import { all, get, insert, placeholders, run, tx } from './db.js';
import { publicUser } from './auth.js';
import { badRequest, forbidden, notFound, now, parseJson } from './util.js';
import { emitToConversation, emitToUser, joinConversation } from './realtime.js';

/* ------------------------------------------------------------- membership */

export const membership = (conversationId, userId) =>
  get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, userId);

export async function canMessageDirectly(userIdA, userIdB) {
  if (userIdA === userIdB) return true;
  const row = await get(
    `SELECT 1 FROM message_requests
     WHERE status = 'accepted'
       AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`,
    userIdA,
    userIdB,
    userIdB,
    userIdA,
  );
  return Boolean(row);
}

export async function getDirectRequest(userIdA, userIdB) {
  return get(
    `SELECT * FROM message_requests
     WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
     ORDER BY id DESC LIMIT 1`,
    userIdA,
    userIdB,
    userIdB,
    userIdA,
  );
}

/** Load a conversation the current user belongs to. Non-members get a 404. */
export async function requireConversation(req, id, { manage = false } = {}) {
  const cid = Number(id);
  if (!Number.isInteger(cid) || cid <= 0) throw notFound('Conversation not found');
  const conversation = await get('SELECT * FROM conversations WHERE id = ?', cid);
  const member = conversation && (await membership(conversation.id, req.user.id));
  if (!member) throw notFound('Conversation not found');
  if (manage && !['owner', 'admin'].includes(member.role)) throw forbidden('Only group admins can do that');
  return { conversation, member };
}

export const memberIds = async (cid) => (await all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', cid)).map((r) => r.user_id);

export async function requireMemberUser(cid, userId, label = 'That person') {
  if (userId != null && !(await membership(cid, userId))) throw badRequest(`${label} is not in this conversation`);
}

/* ---------------------------------------------------------- conversations */

const PREVIEW_PREFIX = { task: '✅ Task', idea: '💡 Idea', goal: '🎯 Goal', decision: '⚖️ Decision', poll: '📊 Poll', checkin: '☀️ Check-in' };

async function preview(m) {
  if (!m) return null;
  let text = m.body;
  if (m.deleted_at) text = 'Message deleted';
  else if (PREVIEW_PREFIX[m.kind]) text = m.kind === 'checkin' ? PREVIEW_PREFIX.checkin : `${PREVIEW_PREFIX[m.kind]}: ${m.body}`;
  else if (!text) {
    const att = await get('SELECT mime FROM attachments WHERE message_id = ? LIMIT 1', m.id);
    text = att ? (att.mime.startsWith('image/') ? '📷 Photo' : '📎 File') : '';
  }
  return { id: m.id, user_id: m.user_id, user_name: m.user_name, kind: m.kind, text: text.slice(0, 140), created_at: m.created_at };
}

export async function conversationFor(cid, userId) {
  const c = await get(
    `SELECT c.*, m.role, m.muted, m.pinned, m.last_read_id FROM conversations c
     JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ? WHERE c.id = ?`,
    userId,
    cid,
  );
  if (!c) return null;
  const [members, last, counts] = await Promise.all([
    all(
      `SELECT u.*, m.role, m.last_read_id FROM conversation_members m JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = ? ORDER BY m.role = 'owner' DESC, lower(u.name)`,
      cid,
    ),
    get(
      `SELECT m.*, u.name AS user_name FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`,
      cid,
    ),
    get(
      `SELECT
         (SELECT count(*)::int FROM messages WHERE conversation_id = ? AND id > ? AND deleted_at IS NULL
            AND (user_id IS NULL OR user_id != ?)) AS unread,
         (SELECT count(*)::int FROM mentions x JOIN messages m ON m.id = x.message_id
            WHERE m.conversation_id = ? AND x.user_id = ? AND m.id > ? AND m.deleted_at IS NULL) AS mentions,
         (SELECT count(*)::int FROM tasks WHERE conversation_id = ? AND status != 'done') AS open_tasks`,
      cid,
      c.last_read_id,
      userId,
      cid,
      userId,
      c.last_read_id,
      cid,
    ),
  ]);
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    description: c.description,
    emoji: c.emoji,
    color: c.color,
    created_by: c.created_by,
    created_at: c.created_at,
    last_message_at: c.last_message_at,
    role: c.role,
    muted: Boolean(c.muted),
    pinned: Boolean(c.pinned),
    last_read_id: c.last_read_id,
    members: members.map((u) => ({ ...publicUser(u), role: u.role, last_read_id: u.last_read_id })),
    last_message: await preview(last),
    unread_count: counts.unread,
    mention_count: counts.mentions,
    open_tasks: counts.open_tasks,
  };
}

export async function listConversations(userId) {
  const ids = await all('SELECT conversation_id FROM conversation_members WHERE user_id = ?', userId);
  const list = await Promise.all(ids.map((r) => conversationFor(r.conversation_id, userId)));
  return list.filter(Boolean).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last_message_at.localeCompare(a.last_message_at));
}

/** Push each member their own view of the conversation (unread counts differ per person). */
export async function broadcastConversation(cid) {
  for (const uid of await memberIds(cid)) emitToUser(uid, 'conversation:upsert', { conversation: await conversationFor(cid, uid) });
}

export async function addMembers(cid, userIds, role = 'member') {
  const { maxid } = await get('SELECT coalesce(max(id), 0) AS maxid FROM messages WHERE conversation_id = ?', cid);
  for (const uid of userIds) {
    await run(
      'INSERT INTO conversation_members (conversation_id, user_id, role, last_read_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      cid,
      uid,
      role,
      maxid,
    );
    joinConversation(uid, cid);
  }
}

/* --------------------------------------------------------------- messages */

const fileUrl = (a) => `/api/files/${a.file_key}/${encodeURIComponent(a.filename)}`;

export const serializeAttachment = (a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: fileUrl(a) });

/** Attach author, reactions, files, mentions and reply previews to raw message rows. */
export async function serializeMessages(rows, viewerId = null) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = placeholders(ids);
  const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean))];

  const [userRows, reactionRows, fileRows, mentionRows, replyRows, savedRows] = await Promise.all([
    userIds.length ? all(`SELECT * FROM users WHERE id IN (${placeholders(userIds)})`, ...userIds) : [],
    all(`SELECT * FROM reactions WHERE message_id IN (${ph}) ORDER BY created_at`, ...ids),
    all(`SELECT * FROM attachments WHERE message_id IN (${ph}) ORDER BY id`, ...ids),
    all(`SELECT * FROM mentions WHERE message_id IN (${ph})`, ...ids),
    replyIds.length
      ? all(
          `SELECT m.id, m.user_id, m.kind, m.body, m.deleted_at, u.name AS user_name FROM messages m
           LEFT JOIN users u ON u.id = m.user_id WHERE m.id IN (${placeholders(replyIds)})`,
          ...replyIds,
        )
      : [],
    viewerId ? all(`SELECT message_id FROM saved_messages WHERE user_id = ? AND message_id IN (${ph})`, viewerId, ...ids) : [],
  ]);

  const users = new Map(userRows.map((u) => [u.id, u]));
  const reactions = new Map();
  for (const r of reactionRows) {
    const list = reactions.get(r.message_id) ?? [];
    let entry = list.find((e) => e.emoji === r.emoji);
    if (!entry) list.push((entry = { emoji: r.emoji, user_ids: [] }));
    entry.user_ids.push(r.user_id);
    reactions.set(r.message_id, list);
  }
  const files = new Map();
  for (const a of fileRows) files.set(a.message_id, [...(files.get(a.message_id) ?? []), serializeAttachment(a)]);
  const mentions = new Map();
  for (const m of mentionRows) mentions.set(m.message_id, [...(mentions.get(m.message_id) ?? []), m.user_id]);
  const replies = new Map(
    replyRows.map((r) => [r.id, { id: r.id, user_id: r.user_id, user_name: r.user_name, kind: r.kind, body: r.deleted_at ? '' : r.body.slice(0, 200), deleted: Boolean(r.deleted_at) }]),
  );
  const saved = viewerId ? new Set(savedRows.map((r) => r.message_id)) : null;

  return rows.map((r) => {
    const u = r.user_id ? users.get(r.user_id) : null;
    const deleted = Boolean(r.deleted_at);
    return {
      id: r.id,
      conversation_id: r.conversation_id,
      user_id: r.user_id,
      user: u ? { id: u.id, name: u.name, color: u.color, avatar: u.avatar } : null,
      kind: r.kind,
      body: deleted ? '' : r.body,
      ref_id: r.ref_id,
      meta: deleted ? null : parseJson(r.meta),
      reply_to: r.reply_to_id ? replies.get(r.reply_to_id) ?? null : null,
      reactions: deleted ? [] : reactions.get(r.id) ?? [],
      attachments: deleted ? [] : files.get(r.id) ?? [],
      mentions: mentions.get(r.id) ?? [],
      pinned: Boolean(r.pinned_at),
      edited: Boolean(r.edited_at),
      deleted,
      created_at: r.created_at,
      ...(saved ? { saved: saved.has(r.id) } : {}),
    };
  });
}

export async function getMessage(id, viewerId = null) {
  const row = await get('SELECT * FROM messages WHERE id = ?', id);
  return row ? (await serializeMessages([row], viewerId))[0] : null;
}

export async function requireMessage(req, id) {
  const mid = Number(id);
  const row = Number.isInteger(mid) && mid > 0 ? await get('SELECT * FROM messages WHERE id = ?', mid) : null;
  if (!row) throw notFound('Message not found');
  const { conversation, member } = await requireConversation(req, row.conversation_id);
  return { message: row, conversation, member };
}

/**
 * Insert a message, bump the conversation, mark it read for the author and push it
 * to everyone in the conversation. Returns the serialized message.
 */
export async function postMessage({ conversationId, userId = null, kind = 'text', body = '', refId = null, meta = null, replyToId = null, attachmentIds = [], mentionIds = [] }) {
  const id = await tx(async () => {
    const ts = now();
    const mid = await insert(
      `INSERT INTO messages (conversation_id, user_id, kind, body, ref_id, meta, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      conversationId,
      userId,
      kind,
      body,
      refId,
      meta ? JSON.stringify(meta) : null,
      replyToId,
      ts,
    );
    for (const aid of attachmentIds) {
      const changed = await run(
        'UPDATE attachments SET message_id = ? WHERE id = ? AND conversation_id = ? AND uploader_id = ? AND message_id IS NULL',
        mid,
        aid,
        conversationId,
        userId,
      );
      if (!changed) throw badRequest('Attachment not found');
    }
    for (const uid of mentionIds) {
      if (uid !== userId) await run('INSERT INTO mentions (message_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', mid, uid);
    }
    await run('UPDATE conversations SET last_message_at = ? WHERE id = ?', ts, conversationId);
    if (userId) await run('UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?', mid, conversationId, userId);
    return mid;
  });
  const message = await getMessage(id);
  emitToConversation(conversationId, 'message:new', { message });
  if (userId) emitToConversation(conversationId, 'read', { conversation_id: conversationId, user_id: userId, last_read_id: id });
  return message;
}

/** A small centred line in the chat, e.g. "Priya completed “Ship v1”". The actor is stored as user_id. */
export const systemMessage = (conversationId, actorId, text, meta = null) => postMessage({ conversationId, userId: actorId, kind: 'system', body: text, meta });

export async function broadcastMessage(id) {
  const message = await getMessage(id);
  if (message) emitToConversation(message.conversation_id, 'message:update', { message });
  return message;
}

/** Keep a card message's body (used for previews & search) in sync with its item title. */
export async function syncCardBody(messageId, title) {
  if (!messageId) return;
  await run('UPDATE messages SET body = ? WHERE id = ?', title, messageId);
  await broadcastMessage(messageId);
}

export async function removeCardMessage(messageId) {
  if (!messageId) return;
  const row = await get('SELECT conversation_id FROM messages WHERE id = ?', messageId);
  if (!row) return;
  await run('DELETE FROM messages WHERE id = ?', messageId);
  emitToConversation(row.conversation_id, 'message:remove', { conversation_id: row.conversation_id, id: messageId });
}

export async function displayName(userId) {
  if (!userId) return 'nobody';
  return (await get('SELECT name FROM users WHERE id = ?', userId))?.name ?? 'Someone';
}
