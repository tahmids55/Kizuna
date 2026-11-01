import { Router } from 'express';
import { all, get, insert, run, tx } from '../db.js';
import { badRequest, field, forbidden, notFound, now } from '../util.js';
import {
  displayName,
  postMessage,
  removeCardMessage,
  requireConversation,
  requireMemberUser,
  syncCardBody,
  systemMessage,
} from '../chat.js';
import { emitToConversation } from '../realtime.js';
import { upcomingReminders } from './messages.js';

export const workRouter = Router();

/* ---------------------------------------------------------------- helpers */

/** Short label for a conversation as seen by a given user (direct chats show the other person). */
export async function conversationLabel(cid, userId) {
  const c = await get('SELECT id, type, name, emoji, color FROM conversations WHERE id = ?', cid);
  if (!c) return null;
  if (c.type === 'direct') {
    const other = await get(
      'SELECT u.id, u.name, u.color, u.avatar FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND m.user_id != ?',
      cid,
      userId,
    );
    return { ...c, name: other?.name ?? 'Direct message', color: other?.color ?? c.color, avatar: other?.avatar ?? null };
  }
  return c;
}

const withConv = (items, userId) => Promise.all(items.map(async (i) => ({ ...i, conversation: await conversationLabel(i.conversation_id, userId) })));
const isSelf = (conversation) => conversation.type === 'self';

async function sourceMessage(body, cid) {
  const id = field.id(body, 'source_message_id', { label: 'Message' }) ?? null;
  if (id && !(await get('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?', id, cid))) {
    throw badRequest('That message is not in this conversation');
  }
  return id;
}

function emitItem(type, item) {
  emitToConversation(item.conversation_id, 'item', { type, item });
  return item;
}

async function requireItem(req, table, id, label) {
  const iid = Number(id);
  const item = Number.isInteger(iid) && iid > 0 ? await get(`SELECT * FROM ${table} WHERE id = ?`, iid) : null;
  if (!item) throw notFound(`${label} not found`);
  const { conversation, member } = await requireConversation(req, item.conversation_id);
  return { item, conversation, member };
}

const canManage = (req, item, member) => item.created_by === req.user.id || ['owner', 'admin'].includes(member.role);

async function deleteItem(table, type, item) {
  await run(`DELETE FROM ${table} WHERE id = ?`, item.id);
  await removeCardMessage(item.message_id);
  emitToConversation(item.conversation_id, 'item:remove', { type, id: item.id, conversation_id: item.conversation_id });
}

/* ------------------------------------------------------------------ tasks */

const getTask = (id) => get('SELECT * FROM tasks WHERE id = ?', id);

workRouter.post('/conversations/:id/tasks', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const title = field.text(req.body, 'title', { label: 'Task', required: true, max: 200 });
  const notes = field.text(req.body, 'notes', { label: 'Notes', max: 4000, multiline: true }) ?? '';
  const assigneeId = field.id(req.body, 'assignee_id', { label: 'Assignee' }) ?? (isSelf(conversation) ? req.user.id : null);
  await requireMemberUser(conversation.id, assigneeId, 'The assignee');
  const due = field.date(req.body, 'due_date', { label: 'Due date' }) ?? null;
  const priority = field.oneOf(req.body, 'priority', ['high', 'normal', 'low'], { label: 'Priority' }) ?? 'normal';
  const source = await sourceMessage(req.body, conversation.id);

  const id = await insert(
    `INSERT INTO tasks (conversation_id, title, notes, assignee_id, created_by, due_date, priority, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    conversation.id,
    title,
    notes,
    assigneeId,
    req.user.id,
    due,
    priority,
    source,
  );
  emitItem('task', await getTask(id));
  const message = await postMessage({
    conversationId: conversation.id,
    userId: req.user.id,
    kind: 'task',
    body: title,
    refId: id,
    replyToId: source,
    meta: { assignee_id: assigneeId },
  });
  await run('UPDATE tasks SET message_id = ? WHERE id = ?', message.id, id);
  res.status(201).json({ task: emitItem('task', await getTask(id)), message });
});

workRouter.patch('/tasks/:id', async (req, res) => {
  const { item: task, conversation } = await requireItem(req, 'tasks', req.params.id, 'Task');
  const sets = {};
  const title = field.text(req.body, 'title', { label: 'Task', required: 'title' in req.body, max: 200 });
  if (title !== undefined && title !== task.title) sets.title = title;
  const notes = field.text(req.body, 'notes', { label: 'Notes', max: 4000, multiline: true });
  if (notes !== undefined) sets.notes = notes;
  const due = field.date(req.body, 'due_date', { label: 'Due date' });
  if (due !== undefined) sets.due_date = due;
  const priority = field.oneOf(req.body, 'priority', ['high', 'normal', 'low'], { label: 'Priority' });
  if (priority !== undefined) sets.priority = priority;
  const assigneeId = field.id(req.body, 'assignee_id', { label: 'Assignee' });
  if (assigneeId !== undefined && assigneeId !== task.assignee_id) {
    await requireMemberUser(conversation.id, assigneeId, 'The assignee');
    sets.assignee_id = assigneeId;
  }
  const status = field.oneOf(req.body, 'status', ['todo', 'doing', 'done'], { label: 'Status' });
  if (status !== undefined && status !== task.status) {
    sets.status = status;
    sets.completed_at = status === 'done' ? now() : null;
    sets.completed_by = status === 'done' ? req.user.id : null;
  }
  if (Object.keys(sets).length) {
    sets.updated_at = now();
    const cols = Object.keys(sets);
    await run(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => sets[c]), task.id);
  }
  const updated = emitItem('task', await getTask(task.id));
  if (sets.title) await syncCardBody(task.message_id, sets.title);

  if (!isSelf(conversation)) {
    const name = `“${updated.title}”`;
    if (sets.status === 'done') await systemMessage(conversation.id, req.user.id, `✅ ${req.user.name} completed ${name}`, { event: 'task_done', task_id: task.id });
    else if (sets.status && task.status === 'done') await systemMessage(conversation.id, req.user.id, `${req.user.name} reopened ${name}`, { event: 'task_reopened', task_id: task.id });
    if ('assignee_id' in sets) {
      await systemMessage(
        conversation.id,
        req.user.id,
        sets.assignee_id ? `${req.user.name} assigned ${name} to ${await displayName(sets.assignee_id)}` : `${req.user.name} unassigned ${name}`,
        { event: 'task_assigned', task_id: task.id, assignee_id: sets.assignee_id },
      );
    }
  }
  res.json({ task: updated });
});

workRouter.delete('/tasks/:id', async (req, res) => {
  const { item: task, member } = await requireItem(req, 'tasks', req.params.id, 'Task');
  if (!canManage(req, task, member) && task.assignee_id !== req.user.id) throw forbidden('Only the creator, assignee or an admin can delete this task');
  await deleteItem('tasks', 'task', task);
  res.json({ ok: true });
});

/** Tasks across every conversation: assigned to me, created by me for others, or everything I can see. */
workRouter.get('/tasks', async (req, res) => {
  const scope = ['assigned', 'created', 'all'].includes(req.query.scope) ? req.query.scope : 'assigned';
  const me = req.user.id;
  const where = {
    assigned: ['t.assignee_id = ?', [me]],
    created: ['t.created_by = ? AND (t.assignee_id IS NULL OR t.assignee_id != ?)', [me, me]],
    all: ['TRUE', []],
  }[scope];
  const rows = await all(
    `SELECT t.* FROM tasks t JOIN conversation_members m ON m.conversation_id = t.conversation_id AND m.user_id = ?
     WHERE ${where[0]} AND (t.status != 'done' OR t.completed_at > ?)
     ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.id DESC
     LIMIT 500`,
    me,
    ...where[1],
    new Date(Date.now() - 7 * 864e5).toISOString(),
  );
  res.json({ tasks: await withConv(rows, me) });
});

/* ------------------------------------------------------------------ ideas */

async function getIdea(id) {
  const idea = await get('SELECT * FROM ideas WHERE id = ?', id);
  return idea && { ...idea, votes: (await all('SELECT user_id FROM idea_votes WHERE idea_id = ?', id)).map((r) => r.user_id) };
}

const IDEA_STATUS = ['new', 'exploring', 'accepted', 'parked'];
const IDEA_LABEL = { new: 'New', exploring: 'Exploring', accepted: 'Accepted', parked: 'Parked' };

workRouter.post('/conversations/:id/ideas', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const title = field.text(req.body, 'title', { label: 'Idea', required: true, max: 200 });
  const body = field.text(req.body, 'body', { label: 'Details', max: 4000, multiline: true }) ?? '';
  const source = await sourceMessage(req.body, conversation.id);
  const id = await insert('INSERT INTO ideas (conversation_id, title, body, created_by, source_message_id) VALUES (?, ?, ?, ?, ?)', conversation.id, title, body, req.user.id, source);
  emitItem('idea', await getIdea(id));
  const message = await postMessage({ conversationId: conversation.id, userId: req.user.id, kind: 'idea', body: title, refId: id, replyToId: source });
  await run('UPDATE ideas SET message_id = ? WHERE id = ?', message.id, id);
  res.status(201).json({ idea: emitItem('idea', await getIdea(id)), message });
});

workRouter.patch('/ideas/:id', async (req, res) => {
  const { item: idea, conversation } = await requireItem(req, 'ideas', req.params.id, 'Idea');
  const title = field.text(req.body, 'title', { label: 'Idea', required: 'title' in req.body, max: 200 });
  const body = field.text(req.body, 'body', { label: 'Details', max: 4000, multiline: true });
  const status = field.oneOf(req.body, 'status', IDEA_STATUS, { label: 'Status' });
  await run('UPDATE ideas SET title = ?, body = ?, status = ?, updated_at = ? WHERE id = ?', title ?? idea.title, body ?? idea.body, status ?? idea.status, now(), idea.id);
  if (title && title !== idea.title) await syncCardBody(idea.message_id, title);
  if (status && status !== idea.status && !isSelf(conversation)) {
    await systemMessage(conversation.id, req.user.id, `💡 ${req.user.name} moved “${title ?? idea.title}” to ${IDEA_LABEL[status]}`, { event: 'idea_status', idea_id: idea.id });
  }
  res.json({ idea: emitItem('idea', await getIdea(idea.id)) });
});

workRouter.post('/ideas/:id/vote', async (req, res) => {
  const { item: idea } = await requireItem(req, 'ideas', req.params.id, 'Idea');
  const removed = await run('DELETE FROM idea_votes WHERE idea_id = ? AND user_id = ?', idea.id, req.user.id);
  if (!removed) await run('INSERT INTO idea_votes (idea_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', idea.id, req.user.id);
  res.json({ idea: emitItem('idea', await getIdea(idea.id)) });
});

workRouter.delete('/ideas/:id', async (req, res) => {
  const { item: idea, member } = await requireItem(req, 'ideas', req.params.id, 'Idea');
  if (!canManage(req, idea, member)) throw forbidden('Only the author or an admin can delete this idea');
  await deleteItem('ideas', 'idea', idea);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ goals */

async function getGoal(id) {
  const goal = await get('SELECT * FROM goals WHERE id = ?', id);
  return (
    goal && {
      ...goal,
      updates: await all(
        `SELECT g.*, u.name AS user_name FROM goal_updates g LEFT JOIN users u ON u.id = g.user_id WHERE g.goal_id = ? ORDER BY g.id DESC LIMIT 20`,
        id,
      ),
    }
  );
}

const fmt = (v, unit) => {
  const n = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (!unit) return n;
  return ['$', '€', '£', '৳', '₹', '¥'].includes(unit) ? `${unit}${n}` : `${n} ${unit}`;
};

const progressPct = (g) => {
  const span = g.target_value - g.start_value;
  return span === 0 ? 100 : Math.round(Math.max(0, Math.min(1, (g.current_value - g.start_value) / span)) * 100);
};

workRouter.post('/conversations/:id/goals', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const title = field.text(req.body, 'title', { label: 'Goal', required: true, max: 200 });
  const description = field.text(req.body, 'description', { label: 'Description', max: 2000, multiline: true }) ?? '';
  const unit = field.text(req.body, 'unit', { label: 'Unit', max: 20 }) ?? '';
  const start = field.number(req.body, 'start_value', { label: 'Starting value' }) ?? 0;
  const target = field.number(req.body, 'target_value', { label: 'Target', nullable: false });
  if (target === undefined) throw badRequest('Target is required');
  if (target === start) throw badRequest('The target must differ from the starting value');
  const current = field.number(req.body, 'current_value', { label: 'Current value' }) ?? start;
  const due = field.date(req.body, 'due_date', { label: 'Deadline' }) ?? null;
  const ownerId = field.id(req.body, 'owner_id', { label: 'Owner' }) ?? req.user.id;
  await requireMemberUser(conversation.id, ownerId, 'The owner');
  const id = await insert(
    `INSERT INTO goals (conversation_id, title, description, unit, start_value, target_value, current_value, due_date, owner_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    conversation.id,
    title,
    description,
    unit,
    start,
    target,
    current,
    due,
    ownerId,
    req.user.id,
  );
  emitItem('goal', await getGoal(id));
  const message = await postMessage({ conversationId: conversation.id, userId: req.user.id, kind: 'goal', body: title, refId: id });
  await run('UPDATE goals SET message_id = ? WHERE id = ?', message.id, id);
  res.status(201).json({ goal: emitItem('goal', await getGoal(id)), message });
});

workRouter.patch('/goals/:id', async (req, res) => {
  const { item: goal } = await requireItem(req, 'goals', req.params.id, 'Goal');
  const b = req.body;
  const next = {
    title: field.text(b, 'title', { label: 'Goal', required: 'title' in b, max: 200 }) ?? goal.title,
    description: field.text(b, 'description', { label: 'Description', max: 2000, multiline: true }) ?? goal.description,
    unit: field.text(b, 'unit', { label: 'Unit', max: 20 }) ?? goal.unit,
    start_value: field.number(b, 'start_value', { label: 'Starting value', nullable: false }) ?? goal.start_value,
    target_value: field.number(b, 'target_value', { label: 'Target', nullable: false }) ?? goal.target_value,
    due_date: field.date(b, 'due_date', { label: 'Deadline' }),
    owner_id: field.id(b, 'owner_id', { label: 'Owner' }),
    status: field.oneOf(b, 'status', ['active', 'achieved', 'dropped'], { label: 'Status' }) ?? goal.status,
  };
  if (next.due_date === undefined) next.due_date = goal.due_date;
  if (next.owner_id === undefined) next.owner_id = goal.owner_id;
  await requireMemberUser(goal.conversation_id, next.owner_id, 'The owner');
  if (next.start_value === next.target_value) throw badRequest('The target must differ from the starting value');
  await run(
    `UPDATE goals SET title = ?, description = ?, unit = ?, start_value = ?, target_value = ?, due_date = ?, owner_id = ?, status = ?, updated_at = ? WHERE id = ?`,
    next.title,
    next.description,
    next.unit,
    next.start_value,
    next.target_value,
    next.due_date,
    next.owner_id,
    next.status,
    now(),
    goal.id,
  );
  if (next.title !== goal.title) await syncCardBody(goal.message_id, next.title);
  res.json({ goal: emitItem('goal', await getGoal(goal.id)) });
});

/** Record progress toward a goal; reaching the target marks it achieved and celebrates in the chat. */
workRouter.post('/goals/:id/progress', async (req, res) => {
  const { item: goal, conversation } = await requireItem(req, 'goals', req.params.id, 'Goal');
  const value = field.number(req.body, 'value', { label: 'Value', nullable: false });
  if (value === undefined) throw badRequest('Value is required');
  const note = field.text(req.body, 'note', { label: 'Note', max: 500, multiline: true }) ?? '';
  const ascending = goal.target_value >= goal.start_value;
  const reached = ascending ? value >= goal.target_value : value <= goal.target_value;
  const status = reached && goal.status === 'active' ? 'achieved' : goal.status;
  await tx(async () => {
    await run('INSERT INTO goal_updates (goal_id, user_id, value, note) VALUES (?, ?, ?, ?)', goal.id, req.user.id, value, note);
    await run('UPDATE goals SET current_value = ?, status = ?, updated_at = ? WHERE id = ?', value, status, now(), goal.id);
  });
  const updated = await getGoal(goal.id);
  if (status === 'achieved' && goal.status !== 'achieved') {
    await systemMessage(conversation.id, req.user.id, `🎉 Goal achieved: “${goal.title}” reached ${fmt(value, goal.unit)}!`, { event: 'goal_achieved', goal_id: goal.id });
  } else {
    await systemMessage(
      conversation.id,
      req.user.id,
      `📈 ${req.user.name} updated “${goal.title}”: ${fmt(goal.current_value, goal.unit)} → ${fmt(value, goal.unit)} (${progressPct(updated)}%)${note ? ` — ${note}` : ''}`,
      { event: 'goal_progress', goal_id: goal.id },
    );
  }
  res.json({ goal: emitItem('goal', updated) });
});

workRouter.delete('/goals/:id', async (req, res) => {
  const { item: goal, member } = await requireItem(req, 'goals', req.params.id, 'Goal');
  if (!canManage(req, goal, member) && goal.owner_id !== req.user.id) throw forbidden('Only the owner, creator or an admin can delete this goal');
  await deleteItem('goals', 'goal', goal);
  res.json({ ok: true });
});

/* -------------------------------------------------------------- decisions */

async function getDecision(id) {
  const d = await get('SELECT * FROM decisions WHERE id = ?', id);
  return d && { ...d, acks: (await all('SELECT user_id FROM decision_acks WHERE decision_id = ? ORDER BY created_at', id)).map((r) => r.user_id) };
}

workRouter.post('/conversations/:id/decisions', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const title = field.text(req.body, 'title', { label: 'Decision', required: true, max: 300 });
  const context = field.text(req.body, 'context', { label: 'Why', max: 4000, multiline: true }) ?? '';
  const source = await sourceMessage(req.body, conversation.id);
  const id = await tx(async () => {
    const did = await insert('INSERT INTO decisions (conversation_id, title, context, created_by, source_message_id) VALUES (?, ?, ?, ?, ?)', conversation.id, title, context, req.user.id, source);
    await run('INSERT INTO decision_acks (decision_id, user_id) VALUES (?, ?)', did, req.user.id);
    return did;
  });
  emitItem('decision', await getDecision(id));
  const message = await postMessage({ conversationId: conversation.id, userId: req.user.id, kind: 'decision', body: title, refId: id, replyToId: source });
  await run('UPDATE decisions SET message_id = ? WHERE id = ?', message.id, id);
  res.status(201).json({ decision: emitItem('decision', await getDecision(id)), message });
});

workRouter.patch('/decisions/:id', async (req, res) => {
  const { item: d, member } = await requireItem(req, 'decisions', req.params.id, 'Decision');
  if (!canManage(req, d, member)) throw forbidden('Only the author or an admin can edit this decision');
  const title = field.text(req.body, 'title', { label: 'Decision', required: 'title' in req.body, max: 300 });
  const context = field.text(req.body, 'context', { label: 'Why', max: 4000, multiline: true });
  await run('UPDATE decisions SET title = ?, context = ? WHERE id = ?', title ?? d.title, context ?? d.context, d.id);
  if (title && title !== d.title) await syncCardBody(d.message_id, title);
  res.json({ decision: emitItem('decision', await getDecision(d.id)) });
});

/** "I agree" — co-founders sign off on a decision. */
workRouter.post('/decisions/:id/ack', async (req, res) => {
  const { item: d } = await requireItem(req, 'decisions', req.params.id, 'Decision');
  const removed = await run('DELETE FROM decision_acks WHERE decision_id = ? AND user_id = ?', d.id, req.user.id);
  if (!removed) await run('INSERT INTO decision_acks (decision_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', d.id, req.user.id);
  res.json({ decision: emitItem('decision', await getDecision(d.id)) });
});

workRouter.delete('/decisions/:id', async (req, res) => {
  const { item: d, member } = await requireItem(req, 'decisions', req.params.id, 'Decision');
  if (!canManage(req, d, member)) throw forbidden('Only the author or an admin can delete this decision');
  await deleteItem('decisions', 'decision', d);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ polls */

async function getPoll(id) {
  const p = await get('SELECT * FROM polls WHERE id = ?', id);
  if (!p) return p;
  const [votes, options] = await Promise.all([
    all('SELECT option_id, user_id FROM poll_votes WHERE poll_id = ?', id),
    all('SELECT id, label FROM poll_options WHERE poll_id = ? ORDER BY position', id),
  ]);
  return { ...p, multiple: Boolean(p.multiple), options: options.map((o) => ({ ...o, votes: votes.filter((v) => v.option_id === o.id).map((v) => v.user_id) })) };
}

workRouter.post('/conversations/:id/polls', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const question = field.text(req.body, 'question', { label: 'Question', required: true, max: 300 });
  const raw = Array.isArray(req.body.options) ? req.body.options : [];
  const options = [...new Set(raw.filter((o) => typeof o === 'string').map((o) => o.trim()).filter(Boolean))];
  if (options.length < 2) throw badRequest('Add at least two options');
  if (options.length > 10) throw badRequest('Up to 10 options');
  if (options.some((o) => o.length > 120)) throw badRequest('Options must be at most 120 characters');
  const multiple = Boolean(req.body.multiple);
  const id = await tx(async () => {
    const pid = await insert('INSERT INTO polls (conversation_id, question, multiple, created_by) VALUES (?, ?, ?, ?)', conversation.id, question, Number(multiple), req.user.id);
    for (const [i, label] of options.entries()) await run('INSERT INTO poll_options (poll_id, label, position) VALUES (?, ?, ?)', pid, label, i);
    return pid;
  });
  emitItem('poll', await getPoll(id));
  const message = await postMessage({ conversationId: conversation.id, userId: req.user.id, kind: 'poll', body: question, refId: id });
  await run('UPDATE polls SET message_id = ? WHERE id = ?', message.id, id);
  res.status(201).json({ poll: emitItem('poll', await getPoll(id)), message });
});

workRouter.post('/polls/:id/vote', async (req, res) => {
  const { item: poll } = await requireItem(req, 'polls', req.params.id, 'Poll');
  if (poll.closed_at) throw badRequest('This poll is closed');
  const optionIds = field.idList(req.body, 'option_ids', { label: 'Options', max: 10 }) ?? [];
  if (!poll.multiple && optionIds.length > 1) throw badRequest('Pick one option');
  const valid = new Set((await all('SELECT id FROM poll_options WHERE poll_id = ?', poll.id)).map((o) => o.id));
  if (optionIds.some((id) => !valid.has(id))) throw badRequest('Unknown option');
  await tx(async () => {
    await run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', poll.id, req.user.id);
    for (const oid of optionIds) await run('INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)', poll.id, oid, req.user.id);
  });
  res.json({ poll: emitItem('poll', await getPoll(poll.id)) });
});

workRouter.post('/polls/:id/close', async (req, res) => {
  const { item: poll, conversation, member } = await requireItem(req, 'polls', req.params.id, 'Poll');
  if (!canManage(req, poll, member)) throw forbidden('Only the author or an admin can close this poll');
  if (!poll.closed_at) {
    await run('UPDATE polls SET closed_at = ? WHERE id = ?', now(), poll.id);
    const p = await getPoll(poll.id);
    const top = [...p.options].sort((a, b) => b.votes.length - a.votes.length)[0];
    await systemMessage(conversation.id, req.user.id, `📊 Poll closed: “${poll.question}” — top answer: ${top?.votes.length ? `${top.label} (${top.votes.length})` : 'no votes'}`, {
      event: 'poll_closed',
      poll_id: poll.id,
    });
  }
  res.json({ poll: emitItem('poll', await getPoll(poll.id)) });
});

workRouter.delete('/polls/:id', async (req, res) => {
  const { item: poll, member } = await requireItem(req, 'polls', req.params.id, 'Poll');
  if (!canManage(req, poll, member)) throw forbidden('Only the author or an admin can delete this poll');
  await deleteItem('polls', 'poll', poll);
  res.json({ ok: true });
});

/* ------------------------------------------------------------ aggregates */

const ids = (rows) => rows.map((r) => r.id);

/** Everything productive in one conversation — powers the side panel and the inline cards. */
workRouter.get('/conversations/:id/hub', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const cid = conversation.id;
  const [tasks, ideaIds, goalIds, decisionIds, pollIds] = await Promise.all([
    all('SELECT * FROM tasks WHERE conversation_id = ? ORDER BY id DESC', cid),
    all('SELECT id FROM ideas WHERE conversation_id = ? ORDER BY id DESC', cid),
    all('SELECT id FROM goals WHERE conversation_id = ? ORDER BY id DESC', cid),
    all('SELECT id FROM decisions WHERE conversation_id = ? ORDER BY id DESC', cid),
    all('SELECT id FROM polls WHERE conversation_id = ? ORDER BY id DESC', cid),
  ]);
  res.json({
    tasks,
    ideas: await Promise.all(ids(ideaIds).map(getIdea)),
    goals: await Promise.all(ids(goalIds).map(getGoal)),
    decisions: await Promise.all(ids(decisionIds).map(getDecision)),
    polls: await Promise.all(ids(pollIds).map(getPoll)),
  });
});

const MY = 'SELECT conversation_id FROM conversation_members WHERE user_id = ?';

/** Ideas, goals and decisions across all of my conversations. */
workRouter.get('/library', async (req, res) => {
  const me = req.user.id;
  const [ideaRows, goalRows, decisionRows] = await Promise.all([
    all(`SELECT id FROM ideas WHERE conversation_id IN (${MY}) ORDER BY id DESC LIMIT 300`, me),
    all(`SELECT id FROM goals WHERE conversation_id IN (${MY}) ORDER BY status != 'active', id DESC LIMIT 300`, me),
    all(`SELECT id FROM decisions WHERE conversation_id IN (${MY}) ORDER BY id DESC LIMIT 300`, me),
  ]);
  res.json({
    ideas: await withConv(await Promise.all(ids(ideaRows).map(getIdea)), me),
    goals: await withConv(await Promise.all(ids(goalRows).map(getGoal)), me),
    decisions: await withConv(await Promise.all(ids(decisionRows).map(getDecision)), me),
  });
});

/** The personal dashboard: what needs me today, what I'm waiting on, and how the goals are going. */
workRouter.get('/today', async (req, res) => {
  const me = req.user.id;
  const week = new Date(Date.now() - 7 * 864e5).toISOString();
  const fortnight = new Date(Date.now() - 14 * 864e5).toISOString();
  const [myTasks, waiting, goalRows, ideaRows, decisionRows, done] = await Promise.all([
    all(
      `SELECT t.* FROM tasks t WHERE t.assignee_id = ? AND t.status != 'done' AND t.conversation_id IN (${MY})
       ORDER BY t.due_date IS NULL, t.due_date, CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.id`,
      me,
      me,
    ),
    all(
      `SELECT t.* FROM tasks t WHERE t.created_by = ? AND t.assignee_id IS NOT NULL AND t.assignee_id != ?
       AND t.status != 'done' AND t.conversation_id IN (${MY}) ORDER BY t.due_date IS NULL, t.due_date, t.id`,
      me,
      me,
      me,
    ),
    all(`SELECT id FROM goals WHERE status = 'active' AND conversation_id IN (${MY}) ORDER BY due_date IS NULL, due_date`, me),
    all(
      `SELECT i.id FROM ideas i WHERE i.conversation_id IN (${MY}) AND i.created_at > ? AND i.status IN ('new','exploring')
       ORDER BY (SELECT count(*) FROM idea_votes v WHERE v.idea_id = i.id) DESC, i.id DESC LIMIT 6`,
      me,
      fortnight,
    ),
    all(`SELECT id FROM decisions WHERE conversation_id IN (${MY}) ORDER BY id DESC LIMIT 5`, me),
    get(`SELECT count(*)::int AS n FROM tasks WHERE completed_by = ? AND completed_at > ?`, me, week),
  ]);
  res.json({
    my_tasks: await withConv(myTasks, me),
    waiting_on: await withConv(waiting, me),
    goals: await withConv(await Promise.all(ids(goalRows).map(getGoal)), me),
    ideas: await withConv(await Promise.all(ids(ideaRows).map(getIdea)), me),
    decisions: await withConv(await Promise.all(ids(decisionRows).map(getDecision)), me),
    reminders: await upcomingReminders(me),
    stats: { done_week: done.n, open: myTasks.length, overdue: myTasks.filter((t) => t.due_date && t.due_date < new Date().toISOString().slice(0, 10)).length },
  });
});
