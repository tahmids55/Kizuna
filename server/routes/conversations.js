import { Router } from 'express';
import { all, get, insert, placeholders, run, tx } from '../db.js';
import { publicUser, updateProfile } from '../auth.js';
import { MAX_GROUP_MEMBERS, badRequest, field, forbidden, notFound, pickColor } from '../util.js';
import {
  addMembers,
  broadcastConversation,
  conversationFor,
  displayName,
  listConversations,
  memberIds,
  membership,
  requireConversation,
  systemMessage,
} from '../chat.js';
import { emitAll, emitToConversation, emitToUser, isOnline, leaveConversation } from '../realtime.js';

export const conversationsRouter = Router();

/* ------------------------------------------------------------------ people */

conversationsRouter.get('/users', async (req, res) => {
  const users = await all('SELECT * FROM users ORDER BY lower(name)');
  res.json({ users: users.map((u) => ({ ...publicUser(u), online: isOnline(u.id) })) });
});

conversationsRouter.patch('/me', async (req, res) => {
  const user = await updateProfile(req);
  emitAll('user:update', { user });
  res.json({ user });
});

/* ----------------------------------------------------------- conversations */

conversationsRouter.get('/conversations', async (req, res) => {
  res.json({ conversations: await listConversations(req.user.id) });
});

conversationsRouter.get('/conversations/:id', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  res.json({ conversation: await conversationFor(conversation.id, req.user.id) });
});

/** Open (or reuse) the one-to-one conversation with another person. */
conversationsRouter.post('/conversations/direct', async (req, res) => {
  const otherId = field.id(req.body, 'user_id', { label: 'Person', nullable: false });
  if (otherId === req.user.id) throw badRequest('Use “My space” for notes to yourself');
  if (!(await get('SELECT 1 FROM users WHERE id = ?', otherId))) throw notFound('Person not found');
  const key = [req.user.id, otherId].sort((a, b) => a - b).join(':');
  let cid = (await get('SELECT id FROM conversations WHERE direct_key = ?', key))?.id;
  let created = false;
  if (!cid) {
    // ON CONFLICT handles two people opening the same DM at the same moment.
    cid = await tx(async () => {
      const row = await get(
        `INSERT INTO conversations (type, direct_key, created_by) VALUES ('direct', ?, ?) ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
        key,
        req.user.id,
      );
      if (!row) return (await get('SELECT id FROM conversations WHERE direct_key = ?', key)).id;
      await addMembers(row.id, [req.user.id, otherId]);
      created = true;
      return row.id;
    });
  }
  if (created) await broadcastConversation(cid);
  res.status(created ? 201 : 200).json({ conversation: await conversationFor(cid, req.user.id) });
});

conversationsRouter.post('/conversations/group', async (req, res) => {
  const name = field.text(req.body, 'name', { label: 'Group name', required: true, max: 60 });
  const description = field.text(req.body, 'description', { label: 'Description', max: 300, multiline: true }) ?? '';
  const emoji = field.text(req.body, 'emoji', { label: 'Emoji', max: 16 }) || '💬';
  const color = field.color(req.body, 'color', { label: 'Color' }) ?? pickColor(name);
  const ids = (field.idList(req.body, 'member_ids', { label: 'Members' }) ?? []).filter((id) => id !== req.user.id);
  if (ids.length + 1 > MAX_GROUP_MEMBERS) throw badRequest(`Groups can have up to ${MAX_GROUP_MEMBERS} members`);
  if (ids.length) {
    const { n } = await get(`SELECT count(*)::int AS n FROM users WHERE id IN (${placeholders(ids)})`, ...ids);
    if (n !== ids.length) throw badRequest('Some of those people don’t exist');
  }
  const cid = await tx(async () => {
    const id = await insert(
      `INSERT INTO conversations (type, name, description, emoji, color, created_by) VALUES ('group', ?, ?, ?, ?, ?)`,
      name,
      description,
      emoji,
      color,
      req.user.id,
    );
    await addMembers(id, [req.user.id], 'owner');
    await addMembers(id, ids);
    return id;
  });
  await systemMessage(cid, req.user.id, `${req.user.name} created the group`, { event: 'created' });
  await broadcastConversation(cid);
  res.status(201).json({ conversation: await conversationFor(cid, req.user.id) });
});

conversationsRouter.patch('/conversations/:id', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id, { manage: true });
  if (conversation.type !== 'group') throw badRequest('Only groups can be renamed');
  const name = field.text(req.body, 'name', { label: 'Group name', required: 'name' in req.body, max: 60 });
  const description = field.text(req.body, 'description', { label: 'Description', max: 300, multiline: true });
  const emoji = field.text(req.body, 'emoji', { label: 'Emoji', max: 16 });
  const color = field.color(req.body, 'color', { label: 'Color' });
  await run(
    'UPDATE conversations SET name = ?, description = ?, emoji = ?, color = ? WHERE id = ?',
    name ?? conversation.name,
    description ?? conversation.description,
    emoji || conversation.emoji,
    color ?? conversation.color,
    conversation.id,
  );
  if (name && name !== conversation.name) await systemMessage(conversation.id, req.user.id, `${req.user.name} renamed the group to “${name}”`);
  await broadcastConversation(conversation.id);
  res.json({ conversation: await conversationFor(conversation.id, req.user.id) });
});

/** Personal settings: mute and pin to top. */
conversationsRouter.patch('/conversations/:id/settings', async (req, res) => {
  const { conversation, member } = await requireConversation(req, req.params.id);
  const muted = field.bool(req.body, 'muted');
  const pinned = field.bool(req.body, 'pinned');
  await run(
    'UPDATE conversation_members SET muted = ?, pinned = ? WHERE conversation_id = ? AND user_id = ?',
    muted === undefined ? member.muted : Number(muted),
    pinned === undefined ? member.pinned : Number(pinned),
    conversation.id,
    req.user.id,
  );
  const updated = await conversationFor(conversation.id, req.user.id);
  emitToUser(req.user.id, 'conversation:upsert', { conversation: updated });
  res.json({ conversation: updated });
});

conversationsRouter.post('/conversations/:id/members', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id, { manage: true });
  if (conversation.type !== 'group') throw badRequest('People can only be added to groups');
  const existing = await memberIds(conversation.id);
  const ids = (field.idList(req.body, 'user_ids', { label: 'People' }) ?? []).filter((id) => !existing.includes(id));
  if (!ids.length) throw badRequest('Choose someone who isn’t already in the group');
  if (existing.length + ids.length > MAX_GROUP_MEMBERS) {
    throw badRequest(`Groups can have up to ${MAX_GROUP_MEMBERS} members (${MAX_GROUP_MEMBERS - existing.length} spot(s) left)`);
  }
  const users = await all(`SELECT id, name FROM users WHERE id IN (${placeholders(ids)})`, ...ids);
  if (users.length !== ids.length) throw badRequest('Some of those people don’t exist');
  await addMembers(conversation.id, ids);
  await systemMessage(conversation.id, req.user.id, `${req.user.name} added ${users.map((u) => u.name).join(', ')}`, { event: 'members_added' });
  await broadcastConversation(conversation.id);
  res.status(201).json({ conversation: await conversationFor(conversation.id, req.user.id) });
});

conversationsRouter.patch('/conversations/:id/members/:userId', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id, { manage: true });
  const target = await membership(conversation.id, Number(req.params.userId));
  if (!target) throw notFound('Member not found');
  const role = field.oneOf(req.body, 'role', ['admin', 'member'], { label: 'Role' });
  if (!role) throw badRequest('Choose a role');
  if (target.role === 'owner') throw forbidden('The group owner’s role can’t be changed');
  await run('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?', role, conversation.id, target.user_id);
  await broadcastConversation(conversation.id);
  res.json({ conversation: await conversationFor(conversation.id, req.user.id) });
});

/** Remove someone (admins) or leave (anyone). */
conversationsRouter.delete('/conversations/:id/members/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const self = userId === req.user.id;
  const { conversation } = await requireConversation(req, req.params.id, { manage: !self });
  if (conversation.type !== 'group') throw badRequest('You can only leave groups');
  const target = await membership(conversation.id, userId);
  if (!target) throw notFound('Member not found');
  if (!self && target.role === 'owner') throw forbidden('The group owner can’t be removed');

  const name = await displayName(userId);
  await tx(async () => {
    await run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversation.id, userId);
    await run(`UPDATE tasks SET assignee_id = NULL WHERE conversation_id = ? AND assignee_id = ? AND status != 'done'`, conversation.id, userId);
    if (target.role === 'owner') {
      const heir = await get(`SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY role = 'admin' DESC, joined_at LIMIT 1`, conversation.id);
      if (heir) await run(`UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?`, conversation.id, heir.user_id);
    }
  });
  leaveConversation(userId, conversation.id);
  emitToUser(userId, 'conversation:remove', { id: conversation.id });

  if (!(await memberIds(conversation.id)).length) {
    await run('DELETE FROM conversations WHERE id = ?', conversation.id);
  } else {
    await systemMessage(conversation.id, req.user.id, self ? `${name} left the group` : `${req.user.name} removed ${name}`, { event: 'member_left' });
    await broadcastConversation(conversation.id);
  }
  res.json({ ok: true });
});

conversationsRouter.post('/conversations/:id/read', async (req, res) => {
  const { conversation, member } = await requireConversation(req, req.params.id);
  const messageId = field.id(req.body, 'message_id', { label: 'Message', nullable: false });
  if (messageId > member.last_read_id) {
    const exists = await get('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?', messageId, conversation.id);
    if (!exists) throw badRequest('Message not in this conversation');
    await run('UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ? AND last_read_id < ?', messageId, conversation.id, req.user.id, messageId);
    emitToConversation(conversation.id, 'read', { conversation_id: conversation.id, user_id: req.user.id, last_read_id: messageId });
  }
  res.json({ ok: true });
});
