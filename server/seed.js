/**
 * Demo workspace: a four-person founding team plus one engineer.
 *   npm run seed            → add demo data (skips if present)
 *   npm run seed:reset      → DROP all Kizuna tables first, then seed
 *
 * Works against local PGlite or, with DATABASE_URL set, against Neon/Postgres.
 */
import './env.js';
import { DB_LABEL, TABLES, closeDb, get, initDb, insert, run } from './db.js';
import { ensureSelfConversation, hashPassword } from './auth.js';

await initDb();
if (process.argv.includes('--reset')) {
  console.log(`Resetting Kizuna tables in ${DB_LABEL}…`);
  for (const t of TABLES) await run(`DROP TABLE IF EXISTS ${t} CASCADE`);
  await closeDb();
  await initDb();
}

if (await get(`SELECT 1 FROM users WHERE email = 'demo@kizuna.app'`)) {
  console.log('Demo data already exists. Run `npm run seed:reset` to start over (deletes ALL Kizuna data).');
  await closeDb();
  process.exit(0);
}

const DAY = 864e5;
/** Local calendar date, offset by whole days (YYYY-MM-DD). */
const day = (offset) => {
  const d = new Date(Date.now() + offset * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let clock = Date.now() - 2 * DAY;
/** Each conversation's story starts this many hours ago, so the demo always feels recent. */
const startAt = (hoursAgo) => (clock = Date.now() - hoursAgo * 3600e3);
const tick = (minutes = 3) => {
  clock += minutes * 60e3;
  return new Date(Math.min(clock, Date.now() - 60e3)).toISOString();
};

/* ------------------------------------------------------------------ people */
const pw = await hashPassword('demo1234');
const U = {};
for (const [key, name, email, title, color, emoji, status] of [
  ['rafi', 'Rafi Ahmed', 'demo@kizuna.app', 'CEO & Co-founder', '#0d9488', '🎯', 'Fundraising week'],
  ['nadia', 'Nadia Islam', 'nadia@kizuna.app', 'CTO & Co-founder', '#7c3aed', '🛠️', 'Deep work until 3pm'],
  ['arif', 'Arif Hossain', 'arif@kizuna.app', 'Product & Design', '#ea580c', '', ''],
  ['sara', 'Sara Chen', 'sara@kizuna.app', 'Growth & Ops', '#db2777', '✈️', 'Travelling — slow replies'],
  ['leo', 'Leo Martins', 'leo@kizuna.app', 'Founding Engineer', '#0284c7', '', ''],
]) {
  U[key] = await insert(
    'INSERT INTO users (name, email, title, password_hash, color, status_emoji, status_text, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    name,
    email,
    title,
    pw,
    color,
    emoji,
    status,
    new Date(Date.now() - 3600e3).toISOString(),
  );
  await ensureSelfConversation(U[key]);
}

/* ----------------------------------------------------------------- helpers */
async function group(name, emoji, color, description, owner, members) {
  const id = await insert(
    `INSERT INTO conversations (type, name, emoji, color, description, created_by, created_at) VALUES ('group', ?, ?, ?, ?, ?, ?)`,
    name,
    emoji,
    color,
    description,
    U[owner],
    tick(0),
  );
  await run(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'owner')`, id, U[owner]);
  for (const m of members) await run(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)`, id, U[m], m === 'nadia' ? 'admin' : 'member');
  return id;
}

async function direct(a, b) {
  const key = [U[a], U[b]].sort((x, y) => x - y).join(':');
  const id = await insert(`INSERT INTO conversations (type, direct_key, created_by) VALUES ('direct', ?, ?)`, key, U[a]);
  for (const u of [a, b]) await run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', id, U[u]);
  return id;
}

async function msg(cid, who, body, opts = {}) {
  const ts = tick(opts.gap ?? 3);
  const id = await insert(
    'INSERT INTO messages (conversation_id, user_id, kind, body, ref_id, meta, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    cid,
    who ? U[who] : null,
    opts.kind ?? 'text',
    body,
    opts.ref ?? null,
    opts.meta ? JSON.stringify(opts.meta) : null,
    opts.reply ?? null,
    ts,
  );
  await run('UPDATE conversations SET last_message_at = ? WHERE id = ?', ts, cid);
  for (const m of opts.mentions ?? []) await run('INSERT INTO mentions (message_id, user_id) VALUES (?, ?)', id, U[m]);
  for (const [emoji, ...people] of opts.reactions ?? []) {
    for (const p of people) await run('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', id, U[p], emoji);
  }
  if (opts.pin) await run('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', ts, U[who], id);
  return id;
}

async function task(cid, by, title, o = {}) {
  const done = o.status === 'done';
  const id = await insert(
    `INSERT INTO tasks (conversation_id, title, notes, assignee_id, created_by, due_date, priority, status, completed_at, completed_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cid,
    title,
    o.notes ?? '',
    o.to ? U[o.to] : null,
    U[by],
    o.due ?? null,
    o.priority ?? 'normal',
    o.status ?? 'todo',
    done ? tick(0) : null,
    done ? U[o.to ?? by] : null,
    tick(0),
    tick(0),
  );
  const mid = await msg(cid, by, title, { kind: 'task', ref: id, meta: { assignee_id: o.to ? U[o.to] : null }, gap: o.gap });
  await run('UPDATE tasks SET message_id = ? WHERE id = ?', mid, id);
  return id;
}

async function idea(cid, by, title, body, voters = [], status = 'new') {
  const id = await insert('INSERT INTO ideas (conversation_id, title, body, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', cid, title, body, status, U[by], tick(0));
  for (const v of voters) await run('INSERT INTO idea_votes (idea_id, user_id) VALUES (?, ?)', id, U[v]);
  await run('UPDATE ideas SET message_id = ? WHERE id = ?', await msg(cid, by, title, { kind: 'idea', ref: id }), id);
  return id;
}

async function goal(cid, by, title, o) {
  const id = await insert(
    `INSERT INTO goals (conversation_id, title, description, unit, start_value, target_value, current_value, due_date, owner_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cid,
    title,
    o.description ?? '',
    o.unit ?? '',
    o.start ?? 0,
    o.target,
    o.start ?? 0,
    o.due ?? null,
    U[o.owner ?? by],
    U[by],
    tick(0),
  );
  await run('UPDATE goals SET message_id = ? WHERE id = ?', await msg(cid, by, title, { kind: 'goal', ref: id }), id);
  for (const [who, value, note] of o.updates ?? []) {
    await run('INSERT INTO goal_updates (goal_id, user_id, value, note, created_at) VALUES (?, ?, ?, ?, ?)', id, U[who], value, note ?? '', tick(30));
    await run('UPDATE goals SET current_value = ? WHERE id = ?', value, id);
  }
  return id;
}

async function decision(cid, by, title, context, ackers) {
  const id = await insert('INSERT INTO decisions (conversation_id, title, context, created_by, created_at) VALUES (?, ?, ?, ?, ?)', cid, title, context, U[by], tick(0));
  for (const a of [by, ...ackers]) await run('INSERT INTO decision_acks (decision_id, user_id) VALUES (?, ?)', id, U[a]);
  await run('UPDATE decisions SET message_id = ? WHERE id = ?', await msg(cid, by, title, { kind: 'decision', ref: id }), id);
  return id;
}

async function poll(cid, by, question, options, votes) {
  const id = await insert('INSERT INTO polls (conversation_id, question, created_by, created_at) VALUES (?, ?, ?, ?)', cid, question, U[by], tick(0));
  const optIds = [];
  for (const [i, label] of options.entries()) optIds.push(await insert('INSERT INTO poll_options (poll_id, label, position) VALUES (?, ?, ?)', id, label, i));
  for (const [who, idx] of votes) await run('INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)', id, optIds[idx], U[who]);
  await run('UPDATE polls SET message_id = ? WHERE id = ?', await msg(cid, by, question, { kind: 'poll', ref: id }), id);
}

const checkin = (cid, who, done, doing, blockers, mood) => msg(cid, who, [done, doing, blockers].filter(Boolean).join(' · '), { kind: 'checkin', meta: { done, doing, blockers, mood } });

async function readAll(cid, except = []) {
  const { maxid } = await get('SELECT coalesce(max(id), 0) AS maxid FROM messages WHERE conversation_id = ?', cid);
  const skip = except.map((e) => U[e]);
  await run(`UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND NOT (user_id = ANY(?::int[]))`, maxid, cid, skip);
}
const readUpTo = (cid, who, id) => run('UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?', id, cid, U[who]);

/* --------------------------------------------------------------- Founders */
startAt(5);
const founders = await group('Founders', '🚀', '#0d9488', 'The four of us. Strategy, fundraising and the big calls.', 'rafi', ['nadia', 'arif', 'sara']);
await msg(founders, 'rafi', 'Created the group', { kind: 'system', gap: 0 });
await msg(founders, 'rafi', 'Morning team ☀️ Big week — investor meetings Thursday & Friday. Let’s use this space instead of WhatsApp so nothing gets lost.', { gap: 5 });
await msg(founders, 'nadia', 'Finally 🙌 I’ll turn anything actionable into tasks right here.', { reactions: [['🙌', 'rafi', 'arif']] });
const deckMsg = await msg(founders, 'sara', 'We need the investor deck updated with October numbers. MRR is $8.4k now.');
await task(founders, 'rafi', 'Update investor deck with October metrics', { to: 'sara', due: day(1), priority: 'high', notes: 'Slides 4–7: MRR, retention, CAC. Use the new brand template.' });
await msg(founders, 'sara', 'On it 💪 will share a draft tomorrow morning.', { reply: deckMsg });
await goal(founders, 'rafi', 'Reach $15k MRR', { unit: '$', start: 5000, target: 15000, due: day(58), owner: 'sara', description: 'Our target before the seed round closes.', updates: [['sara', 6900, 'Two agency plans'], ['sara', 8400, 'October close']] });
clock -= 50 * 60e3; // goal updates were back-dated; continue the story from here
await msg(founders, null, '📈 Sara Chen updated “Reach $15k MRR”: $6,900 → $8,400 (34%) — October close', { kind: 'system', gap: 1 });
await decision(founders, 'nadia', 'Launch with usage-based pricing', 'Matches how customers get value; easier upsell. Revisit after 3 months of data.', ['rafi', 'arif']);
await msg(founders, 'arif', 'Agreed on usage pricing. I’ll redo the pricing page this week.');
await poll(founders, 'sara', 'Where should we do the January offsite?', ['Cox’s Bazar', 'Sylhet tea gardens', 'Bangkok'], [['sara', 0], ['arif', 1], ['nadia', 0]]);
await idea(founders, 'arif', 'Founder-led webinar series', 'Monthly 30-min sessions showing real workflows. Record and cut into short clips.', ['sara', 'nadia'], 'exploring');
await msg(founders, 'rafi', '📌 Investor meetings: Thu 11:00 (Sequoia Surge), Fri 15:00 (Anchorless). Data room link is in the shared drive.', { pin: true, reactions: [['👍', 'nadia', 'sara', 'arif']] });
await checkin(founders, 'nadia', 'Shipped SSO for the enterprise pilot', 'Fixing the billing webhook retries', 'Waiting on Stripe support about test clocks', 'good');
const lastRead = await msg(founders, 'arif', 'New pricing page mock is ready for review 👀 @Rafi Ahmed', { mentions: ['rafi'], gap: 25 });
await msg(founders, 'sara', 'Love the layout. Can we make the annual toggle default?', { gap: 6 });
await msg(founders, 'nadia', 'Heads up: the deploy tonight might cause ~2 min downtime around 23:00.', { gap: 12, reactions: [['👀', 'sara']] });
await readAll(founders, ['rafi']);
await readUpTo(founders, 'rafi', lastRead - 1);

/* ---------------------------------------------------------- Product & Eng */
startAt(9);
const product = await group('Product & Eng', '🛠️', '#7c3aed', 'Roadmap, releases and bugs.', 'nadia', ['rafi', 'arif', 'leo']);
await msg(product, 'nadia', 'Sprint goals for this week: billing v2, onboarding checklist, and the Android beta.', { gap: 60 });
await task(product, 'nadia', 'Billing v2: proration on plan change', { to: 'leo', due: day(2), priority: 'high' });
await task(product, 'nadia', 'Onboarding checklist UI', { to: 'arif', due: day(3) });
await task(product, 'leo', 'Fix flaky login test on CI', { to: 'leo', status: 'done' });
await msg(product, 'leo', 'Flaky test fixed — it was a timezone issue 🙃', { reactions: [['🎉', 'nadia', 'rafi']] });
await task(product, 'rafi', 'Write release notes for v1.4', { to: 'rafi', due: day(0) });
await idea(product, 'leo', 'Keyboard shortcuts cheat-sheet in-app', 'Press ? anywhere to see shortcuts.', ['arif']);
await checkin(product, 'leo', 'Proration math + tests', 'Edge cases for annual → monthly downgrades', '', 'great');
await readAll(product);

/* ----------------------------------------------------------------- direct */
startAt(1);
const rn = await direct('rafi', 'nadia');
await msg(rn, 'nadia', 'Do you have 10 min before the Thursday pitch? Want to align on the technical-moat slide.', { gap: 30 });
await msg(rn, 'rafi', 'Yes — let’s do 10:30 Thursday. Bring the architecture diagram.');
await task(rn, 'nadia', 'Send architecture diagram for slide 9', { to: 'nadia', due: day(1) });
await msg(rn, 'nadia', 'Also, hiring: I think we should open the senior backend role now, not in Q1.');
await readAll(rn, ['rafi']);

startAt(3.5);
const rs = await direct('rafi', 'sara');
await msg(rs, 'sara', 'Draft of the October update for investors is in the doc — can you add a personal note at the top?', { gap: 20 });
await msg(rs, 'rafi', 'Will do tonight 👍');
await task(rs, 'sara', 'Add personal note to October investor update', { to: 'rafi', due: day(0), priority: 'high' });
await readAll(rs);

startAt(27);
const ra = await direct('rafi', 'arif');
await msg(ra, 'arif', 'Shared the new logo explorations — option B is my favourite.', { gap: 15 });
await msg(ra, 'rafi', 'B is great. Ship it 🚢', { reactions: [['❤️', 'arif']] });
await readAll(ra);

/* -------------------------------------------------------------- My space */
startAt(2.5);
const mine = (await get(`SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE c.type = 'self' AND m.user_id = ?`, U.rafi)).id;
await msg(mine, 'rafi', 'Personal notes & todos live here. Only I can see this space.', { gap: 5 });
await task(mine, 'rafi', 'Prepare answers for tough investor questions', { to: 'rafi', due: day(1), priority: 'high' });
await task(mine, 'rafi', 'Book flights for the offsite', { to: 'rafi', due: day(9), priority: 'low' });
await goal(mine, 'rafi', 'Read 2 books this month', { unit: 'books', start: 0, target: 2, due: day(28), updates: [['rafi', 1, 'Finished “The Mom Test”']] });
await idea(mine, 'rafi', 'Weekly founder letter to customers', 'Short, honest, what we shipped and why.');
await readAll(mine);

await run(
  'INSERT INTO reminders (user_id, message_id, conversation_id, note, remind_at) VALUES (?, ?, ?, ?, ?)',
  U.rafi,
  deckMsg,
  founders,
  'Check Sara’s deck draft',
  new Date(Date.now() + 20 * 3600e3).toISOString(),
);

await closeDb();
console.log(`✓ Demo workspace created in ${DB_LABEL}.`);
console.log('  Sign in with  demo@kizuna.app  /  demo1234   (teammates: nadia@, arif@, sara@, leo@kizuna.app)');
