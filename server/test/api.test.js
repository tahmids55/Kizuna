import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Tests run against a fresh in-memory Postgres (PGlite) unless TEST_DATABASE_URL is given.
process.env.KIZUNA_SKIP_DOTENV = '1';
delete process.env.DATABASE_URL;
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else process.env.KIZUNA_PGLITE = 'memory';

process.env.LIVEKIT_URL ??= 'wss://kizuna-test.livekit.cloud';
process.env.LIVEKIT_API_KEY ??= 'API_TEST_KEY';
process.env.LIVEKIT_API_SECRET ??= 'SECRET_TEST_KEY_LONG_ENOUGH_FOR_HMAC_SHA256';

const { createServer } = await import('../index.js');
const { closeDb } = await import('../db.js');
const { io: connect } = await import('socket.io-client');

let server;
let origin;
const sockets = [];

before(async () => {
  server = (await createServer()).listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  sockets.forEach((s) => s.close());
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await closeDb();
  setTimeout(() => process.exit(0), 100).unref();
});

function client() {
  const c = { token: null, user: null };
  c.call = async (method, p, body) => {
    const res = await fetch(`${origin}/api${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  c.register = async (name) => {
    const r = await c.call('POST', '/auth/register', { name, email: `${name.toLowerCase()}@team.io`, password: 'password123' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    c.token = r.body.token;
    c.user = r.body.user;
    return c;
  };
  c.socket = () =>
    new Promise((resolve, reject) => {
      const s = connect(origin, { auth: { token: c.token }, transports: ['websocket'], forceNew: true });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  return c;
}

const waitFor = (socket, event, pred = () => true, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const h = (payload) => {
      if (!pred(payload)) return;
      clearTimeout(t);
      socket.off(event, h);
      resolve(payload);
    };
    socket.on(event, h);
  });

const ana = client();
const ben = client();
const cara = client();
let group;
let dm;

test('accounts: register, login, token auth, personal space', async () => {
  await ana.register('Ana');
  await ben.register('Ben');
  await cara.register('Cara');
  const anon = client();
  assert.equal((await anon.call('GET', '/conversations')).status, 401);
  const login = await anon.call('POST', '/auth/login', { email: 'ana@team.io', password: 'password123' });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  assert.equal((await anon.call('POST', '/auth/login', { email: 'ana@team.io', password: 'nope-nope' })).status, 401);
  const convs = (await ana.call('GET', '/conversations')).body.conversations;
  assert.equal(convs.length, 1);
  assert.equal(convs[0].type, 'self', 'every user gets a private space');
});

test('message request flow and direct messages unique per pair', async () => {
  // Outsider cannot send message or direct chat without request
  const unauthDm = await ana.call('POST', '/conversations/direct', { user_id: ben.user.id });
  assert.equal(unauthDm.status, 403, 'direct chat forbidden without accepted request');

  // Lookup requires complete email
  const lookupNotFound = await ana.call('GET', `/requests/lookup?email=wrong@kizuna.test`);
  assert.equal(lookupNotFound.body.status, 'not_found');

  const lookupFound = await ana.call('GET', `/requests/lookup?email=${encodeURIComponent(ben.user.email)}`);
  assert.equal(lookupFound.body.status, 'none');
  assert.equal(lookupFound.body.user.id, ben.user.id);

  // Send request with email
  const req = await ana.call('POST', '/requests', { email: ben.user.email, note: 'Hey Ben, let’s chat!' });
  assert.equal(req.status, 201);
  assert.equal(req.body.request.status, 'pending');

  // Ben sees incoming request
  const reqs = (await ben.call('GET', '/requests')).body;
  assert.equal(reqs.incoming.length, 1);
  assert.equal(reqs.incoming[0].note, 'Hey Ben, let’s chat!');

  // Ben accepts
  const accepted = await ben.call('POST', `/requests/${req.body.request.id}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.request.status, 'accepted');
  dm = accepted.body.conversation;

  // Direct messages now open and unique per pair
  const r2 = await ben.call('POST', '/conversations/direct', { user_id: ana.user.id });
  assert.equal(r2.status, 200);
  assert.equal(dm.id, r2.body.conversation.id);
  assert.equal((await cara.call('GET', `/conversations/${dm.id}/messages`)).status, 404, 'outsiders cannot read');
});

test('groups: create, 10-member limit, admin rules', async () => {
  const r = await ana.call('POST', '/conversations/group', { name: 'Founders', emoji: '🚀', member_ids: [ben.user.id] });
  assert.equal(r.status, 201);
  group = r.body.conversation;
  assert.equal(group.members.length, 2);
  assert.equal(group.role, 'owner');

  const fakeIds = Array.from({ length: 10 }, (_, i) => i + 1000);
  const tooMany = await ana.call('POST', '/conversations/group', { name: 'Big', member_ids: fakeIds });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /up to 10/);

  assert.equal((await ben.call('POST', `/conversations/${group.id}/members`, { user_ids: [cara.user.id] })).status, 403, 'members cannot add people');
  assert.equal((await ana.call('POST', `/conversations/${group.id}/members`, { user_ids: [cara.user.id] })).status, 201);
});

test('realtime: messages, typing, reactions and read receipts arrive instantly', async () => {
  const sBen = await ben.socket();
  const sCara = await cara.socket();
  const incoming = waitFor(sBen, 'message:new', (p) => p.message.body.includes('hello team'));
  const sent = await ana.call('POST', `/conversations/${group.id}/messages`, { body: 'hello team @Ben', mentions: [ben.user.id] });
  assert.equal(sent.status, 201);
  const { message } = await incoming;
  assert.deepEqual(message.mentions, [ben.user.id]);

  const typing = waitFor(sCara, 'typing');
  sBen.emit('typing', { conversationId: group.id });
  assert.equal((await typing).user_id, ben.user.id);

  const reacted = waitFor(sCara, 'message:update', (p) => p.message.reactions.length > 0);
  await ben.call('POST', `/messages/${message.id}/reactions`, { emoji: '🔥' });
  assert.deepEqual((await reacted).message.reactions, [{ emoji: '🔥', user_ids: [ben.user.id] }]);

  const before = (await ben.call('GET', `/conversations/${group.id}`)).body.conversation;
  assert.ok(before.unread_count >= 1);
  assert.equal(before.mention_count, 1);
  const read = waitFor(sCara, 'read', (p) => p.user_id === ben.user.id);
  await ben.call('POST', `/conversations/${group.id}/read`, { message_id: message.id });
  assert.equal((await read).last_read_id, message.id);
  const after = (await ben.call('GET', `/conversations/${group.id}`)).body.conversation;
  assert.equal(after.unread_count, 0);
});

test('messages: reply, edit, delete, pin, save, search, pagination', async () => {
  const first = (await ana.call('POST', `/conversations/${dm.id}/messages`, { body: 'Pricing thoughts?' })).body.message;
  const reply = await ben.call('POST', `/conversations/${dm.id}/messages`, { body: 'Usage based!', reply_to_id: first.id });
  assert.equal(reply.body.message.reply_to.id, first.id);
  assert.equal((await ben.call('PATCH', `/messages/${first.id}`, { body: 'hijack' })).status, 403);
  const edited = await ana.call('PATCH', `/messages/${first.id}`, { body: 'Pricing thoughts? (v2)' });
  assert.equal(edited.body.message.edited, true);
  await ana.call('POST', `/messages/${first.id}/pin`);
  assert.equal((await ben.call('GET', `/conversations/${dm.id}/pins`)).body.messages.length, 1);
  await ben.call('POST', `/messages/${first.id}/save`);
  assert.equal((await ben.call('GET', '/saved')).body.messages[0].id, first.id);
  const found = await ben.call('GET', '/search?q=usage');
  assert.equal(found.body.messages[0].body, 'Usage based!');
  assert.equal(found.body.messages[0].conversation.name, 'Ana', 'direct chats are labelled with the other person');
  await ben.call('DELETE', `/messages/${reply.body.message.id}`);
  const page = await ana.call('GET', `/conversations/${dm.id}/messages?limit=2`);
  assert.equal(page.body.messages.length, 2);
  assert.equal(page.body.has_more, true);
  assert.ok(page.body.messages.at(-1).deleted || page.body.messages.some((m) => m.deleted));
});

test('tasks: assign to a teammate, complete, show up in their list', async () => {
  const sBen = await ben.socket();
  const card = waitFor(sBen, 'message:new', (p) => p.message.kind === 'task');
  const r = await ana.call('POST', `/conversations/${group.id}/tasks`, {
    title: 'Prepare investor deck',
    assignee_id: ben.user.id,
    due_date: '2030-01-15',
    priority: 'high',
  });
  assert.equal(r.status, 201);
  const { message } = await card;
  assert.equal(message.ref_id, r.body.task.id);
  assert.equal(message.meta.assignee_id, ben.user.id);

  assert.equal((await ana.call('POST', `/conversations/${group.id}/tasks`, { title: 'x', assignee_id: 99999 })).status, 400);

  const mine = (await ben.call('GET', '/tasks?scope=assigned')).body.tasks;
  assert.equal(mine[0].title, 'Prepare investor deck');
  assert.equal(mine[0].conversation.name, 'Founders');
  const waiting = (await ana.call('GET', '/today')).body.waiting_on;
  assert.equal(waiting.length, 1);

  const done = waitFor(sBen, 'message:new', (p) => p.message.kind === 'system' && p.message.body.includes('completed'));
  await ben.call('PATCH', `/tasks/${r.body.task.id}`, { status: 'done' });
  await done;
  const today = (await ben.call('GET', '/today')).body;
  assert.equal(today.my_tasks.length, 0);
  assert.equal(today.stats.done_week, 1);
});

test('ideas, goals, decisions and polls', async () => {
  const idea = (await ben.call('POST', `/conversations/${group.id}/ideas`, { title: 'Referral program' })).body.idea;
  await ana.call('POST', `/ideas/${idea.id}/vote`);
  const voted = (await cara.call('POST', `/ideas/${idea.id}/vote`)).body.idea;
  assert.equal(voted.votes.length, 2);

  const goal = (await ana.call('POST', `/conversations/${group.id}/goals`, { title: 'Paying customers', target_value: 100, unit: 'customers' })).body.goal;
  let g = (await ben.call('POST', `/goals/${goal.id}/progress`, { value: 40, note: 'Two new logos' })).body.goal;
  assert.equal(g.current_value, 40);
  assert.equal(g.status, 'active');
  g = (await ben.call('POST', `/goals/${goal.id}/progress`, { value: 120 })).body.goal;
  assert.equal(g.status, 'achieved');
  assert.equal(g.updates.length, 2);

  const decision = (await ana.call('POST', `/conversations/${group.id}/decisions`, { title: 'Use Stripe for billing', context: 'Fastest to ship' })).body.decision;
  assert.deepEqual(decision.acks, [ana.user.id], 'author agrees by default');
  const acked = (await ben.call('POST', `/decisions/${decision.id}/ack`)).body.decision;
  assert.equal(acked.acks.length, 2);

  const poll = (await cara.call('POST', `/conversations/${group.id}/polls`, { question: 'Offsite city?', options: ['Lisbon', 'Dhaka', 'Tokyo'] })).body.poll;
  assert.equal((await ana.call('POST', `/polls/${poll.id}/vote`, { option_ids: [poll.options[0].id, poll.options[1].id] })).status, 400, 'single choice');
  await ana.call('POST', `/polls/${poll.id}/vote`, { option_ids: [poll.options[2].id] });
  const closed = (await cara.call('POST', `/polls/${poll.id}/close`)).body.poll;
  assert.ok(closed.closed_at);
  assert.equal((await ben.call('POST', `/polls/${poll.id}/vote`, { option_ids: [poll.options[0].id] })).status, 400);

  const hub = (await ben.call('GET', `/conversations/${group.id}/hub`)).body;
  assert.equal(hub.ideas.length, 1);
  assert.equal(hub.goals.length, 1);
  assert.equal(hub.decisions.length, 1);
  assert.equal(hub.polls.length, 1);
  const lib = (await cara.call('GET', '/library')).body;
  assert.equal(lib.decisions[0].conversation.name, 'Founders');
});

test('check-ins and reminders', async () => {
  const c = await ben.call('POST', `/conversations/${group.id}/checkins`, { done: 'Shipped onboarding', doing: 'Pricing page', blockers: '', mood: 'great' });
  assert.equal(c.status, 201);
  assert.equal(c.body.message.meta.mood, 'great');
  const r = await ben.call('POST', '/reminders', { note: 'Call the bank', remind_at: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal(r.status, 201);
  assert.equal((await ben.call('GET', '/reminders')).body.reminders.length, 1);
  assert.equal((await ben.call('POST', '/reminders', { note: 'past', remind_at: '2001-01-01T00:00:00Z' })).status, 400);

  // Event-driven scheduler: a reminder due in 1.5 s is delivered live into "My space".
  const sBen = await ben.socket();
  const delivered = waitFor(sBen, 'message:new', (p) => p.message.meta?.event === 'reminder' && p.message.body.includes('Stand-up in 5'), 6000);
  await ben.call('POST', '/reminders', { note: 'Stand-up in 5', remind_at: new Date(Date.now() + 1500).toISOString() });
  const { message } = await delivered;
  const self = (await ben.call('GET', '/conversations')).body.conversations.find((c) => c.type === 'self');
  assert.equal(message.conversation_id, self.id);
  assert.equal((await ben.call('GET', '/reminders')).body.reminders.length, 1, 'the delivered reminder is no longer pending');
});

test('uploads: files attach to messages and are served by capability URL', async () => {
  const form = new FormData();
  form.append('files', new Blob(['hello world'], { type: 'text/plain' }), 'notes.txt');
  const up = await fetch(`${origin}/api/conversations/${group.id}/uploads`, { method: 'POST', headers: { authorization: `Bearer ${ana.token}` }, body: form });
  assert.equal(up.status, 201);
  const [file] = (await up.json()).attachments;
  const sent = await ana.call('POST', `/conversations/${group.id}/messages`, { body: '', attachment_ids: [file.id] });
  assert.equal(sent.body.message.attachments[0].filename, 'notes.txt');
  const dl = await fetch(origin + file.url);
  assert.equal(await dl.text(), 'hello world', 'file bytes are stored in the database and served back');
  assert.match(dl.headers.get('content-disposition'), /^attachment/, 'non-media files download instead of rendering');
  assert.equal((await ben.call('POST', `/conversations/${group.id}/messages`, { attachment_ids: [file.id] })).status, 400, 'cannot reuse someone else’s upload');
});

test('leaving a group removes access', async () => {
  const sCara = await cara.socket();
  const removed = waitFor(sCara, 'conversation:remove');
  assert.equal((await cara.call('DELETE', `/conversations/${group.id}/members/${cara.user.id}`)).status, 200);
  assert.equal((await removed).id, group.id);
  assert.equal((await cara.call('GET', `/conversations/${group.id}/messages`)).status, 404);
});

test('declining a request blocks messaging until recipient changes decision', async () => {
  // Cara requests Ben via email
  const req = await cara.call('POST', '/requests', { email: ben.user.email, note: 'Can we chat?' });
  assert.equal(req.status, 201);
  assert.equal(req.body.request.status, 'pending');

  // Ben declines the request
  const rejected = await ben.call('POST', `/requests/${req.body.request.id}/reject`);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.request.status, 'rejected');

  // Cara cannot message or re-request while rejected
  const reReq = await cara.call('POST', '/requests', { email: ben.user.email });
  assert.equal(reReq.status, 403);
  assert.match(reReq.body.error, /declined your message request/i);

  // Now Ben changes decision and initiates request to Cara
  const benReq = await ben.call('POST', '/requests', { email: cara.user.email, note: 'Changed my mind!' });
  assert.equal(benReq.status, 201);

  // Cara accepts
  const accepted = await cara.call('POST', `/requests/${benReq.body.request.id}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.request.status, 'accepted');

  // Now Cara and Ben can exchange direct messages
  const msg = await cara.call('POST', `/conversations/${accepted.body.conversation.id}/messages`, { body: 'Glad to connect!' });
  assert.equal(msg.status, 201);
});

test('audio and video calling: token generation, incoming call signaling and leave', async () => {
  const sBen = await ben.socket();
  const incoming = waitFor(sBen, 'call:incoming', (p) => p.conversationId === group.id);

  // Ana starts a video call in the Founders group
  const tokenRes = await ana.call('POST', `/conversations/${group.id}/call/token`, { isVideo: true });
  assert.equal(tokenRes.status, 200);
  assert.ok(tokenRes.body.token, 'returns JWT token');
  assert.ok(tokenRes.body.serverUrl, 'returns LiveKit server URL');
  assert.equal(tokenRes.body.roomName, `kizuna_room_${group.id}`);

  // Ben receives real-time incoming call alert
  const received = await incoming;
  assert.equal(received.caller.name, ana.user.name);
  assert.equal(received.isVideo, true);

  // Outsider cannot join the call
  assert.equal((await cara.call('POST', `/conversations/${group.id}/call/token`)).status, 404);

  // Leave call
  const leaveRes = await ana.call('POST', `/conversations/${group.id}/call/leave`);
  assert.equal(leaveRes.status, 200);
});
