import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { all, get, insert, run, tx } from '../db.js';
import { badRequest, field, forbidden, notFound, now } from '../util.js';
import {
  broadcastMessage,
  getMessage,
  memberIds,
  postMessage,
  requireConversation,
  requireMessage,
  serializeAttachment,
  serializeMessages,
  systemMessage,
} from '../chat.js';
import { conversationLabel } from './work.js';

export const messagesRouter = Router();
export const filesRouter = Router();

export const MAX_FILE_MB = Number(process.env.KIZUNA_MAX_FILE_MB) || 10;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 10 } });

/* ---------------------------------------------------------------- reading */

messagesRouter.get('/conversations/:id/messages', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
  const before = Number(req.query.before) || null;
  const rows = before
    ? await all('SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?', conversation.id, before, limit + 1)
    : await all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?', conversation.id, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  res.json({ messages: await serializeMessages(page, req.user.id), has_more: hasMore });
});

messagesRouter.get('/conversations/:id/pins', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const rows = await all(
    'SELECT * FROM messages WHERE conversation_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC',
    conversation.id,
  );
  res.json({ messages: await serializeMessages(rows, req.user.id) });
});

messagesRouter.get('/conversations/:id/files', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const rows = await all(
    `SELECT a.*, m.user_id, m.created_at AS sent_at, u.name AS user_name FROM attachments a
     JOIN messages m ON m.id = a.message_id LEFT JOIN users u ON u.id = m.user_id
     WHERE a.conversation_id = ? AND m.deleted_at IS NULL ORDER BY a.id DESC LIMIT 200`,
    conversation.id,
  );
  res.json({ files: rows.map((a) => ({ ...serializeAttachment(a), message_id: a.message_id, user_name: a.user_name, created_at: a.sent_at })) });
});

/* ---------------------------------------------------------------- writing */

async function readMentions(body, cid) {
  const ids = field.idList(body, 'mentions', { label: 'Mentions', max: 20 }) ?? [];
  const members = new Set(await memberIds(cid));
  return ids.filter((id) => members.has(id));
}

async function readReply(body, cid) {
  const replyTo = field.id(body, 'reply_to_id', { label: 'Reply' }) ?? null;
  if (replyTo && !(await get('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?', replyTo, cid))) {
    throw badRequest('The message you replied to is not in this conversation');
  }
  return replyTo;
}

messagesRouter.post('/conversations/:id/messages', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const body = field.text(req.body, 'body', { label: 'Message', max: 8000, multiline: true }) ?? '';
  const attachmentIds = field.idList(req.body, 'attachment_ids', { label: 'Attachments', max: 10 }) ?? [];
  if (!body && !attachmentIds.length) throw badRequest('Write a message or attach a file');
  const message = await postMessage({
    conversationId: conversation.id,
    userId: req.user.id,
    body,
    replyToId: await readReply(req.body, conversation.id),
    attachmentIds,
    mentionIds: await readMentions(req.body, conversation.id),
  });
  res.status(201).json({ message: { ...message, saved: false } });
});

/** Async stand-up: what I did, what I'm doing, what's blocking me. */
messagesRouter.post('/conversations/:id/checkins', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const meta = {
    done: field.text(req.body, 'done', { label: 'Done', max: 2000, multiline: true }) ?? '',
    doing: field.text(req.body, 'doing', { label: 'Doing', max: 2000, multiline: true }) ?? '',
    blockers: field.text(req.body, 'blockers', { label: 'Blockers', max: 2000, multiline: true }) ?? '',
    mood: field.oneOf(req.body, 'mood', ['great', 'good', 'okay', 'rough'], { label: 'Mood' }) ?? 'good',
  };
  if (!meta.done && !meta.doing && !meta.blockers) throw badRequest('Fill in at least one part of your check-in');
  const body = [meta.done, meta.doing, meta.blockers].filter(Boolean).join(' · ').slice(0, 300);
  res.status(201).json({ message: await postMessage({ conversationId: conversation.id, userId: req.user.id, kind: 'checkin', body, meta }) });
});

messagesRouter.patch('/messages/:id', async (req, res) => {
  const { message } = await requireMessage(req, req.params.id);
  if (message.user_id !== req.user.id || message.kind !== 'text') throw forbidden('You can only edit your own messages');
  if (message.deleted_at) throw badRequest('That message was deleted');
  const body = field.text(req.body, 'body', { label: 'Message', required: true, max: 8000, multiline: true });
  await tx(async () => {
    await run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', body, now(), message.id);
    if ('mentions' in req.body) {
      await run('DELETE FROM mentions WHERE message_id = ?', message.id);
      for (const uid of await readMentions(req.body, message.conversation_id)) {
        if (uid !== req.user.id) await run('INSERT INTO mentions (message_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', message.id, uid);
      }
    }
  });
  res.json({ message: await broadcastMessage(message.id) });
});

messagesRouter.delete('/messages/:id', async (req, res) => {
  const { message, member } = await requireMessage(req, req.params.id);
  const isAdmin = ['owner', 'admin'].includes(member.role);
  if (message.user_id !== req.user.id && !isAdmin) throw forbidden('You can only delete your own messages');
  if (!['text', 'checkin'].includes(message.kind)) throw badRequest('Delete the task, idea, goal, decision or poll itself instead');
  await tx(async () => {
    await run('DELETE FROM attachments WHERE message_id = ?', message.id); // file bytes cascade
    await run(`UPDATE messages SET body = '', meta = NULL, deleted_at = ?, pinned_at = NULL WHERE id = ?`, now(), message.id);
    await run('DELETE FROM reactions WHERE message_id = ?', message.id);
  });
  await broadcastMessage(message.id);
  res.json({ ok: true });
});

messagesRouter.post('/messages/:id/reactions', async (req, res) => {
  const { message } = await requireMessage(req, req.params.id);
  if (message.deleted_at) throw badRequest('That message was deleted');
  const emoji = field.text(req.body, 'emoji', { label: 'Emoji', required: true, max: 16 });
  const removed = await run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', message.id, req.user.id, emoji);
  if (!removed) {
    const { n } = await get('SELECT count(DISTINCT emoji)::int AS n FROM reactions WHERE message_id = ?', message.id);
    if (n >= 20) throw badRequest('That message has enough reactions');
    await run('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', message.id, req.user.id, emoji);
  }
  res.json({ message: await broadcastMessage(message.id) });
});

messagesRouter.post('/messages/:id/pin', async (req, res) => {
  const { message } = await requireMessage(req, req.params.id);
  if (message.deleted_at || message.kind === 'system') throw badRequest('That message can’t be pinned');
  if (!message.pinned_at) {
    await run('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', now(), req.user.id, message.id);
    await systemMessage(message.conversation_id, req.user.id, `${req.user.name} pinned a message`, { event: 'pinned', message_id: message.id });
  }
  res.json({ message: await broadcastMessage(message.id) });
});

messagesRouter.delete('/messages/:id/pin', async (req, res) => {
  const { message } = await requireMessage(req, req.params.id);
  await run('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?', message.id);
  res.json({ message: await broadcastMessage(message.id) });
});

/* ------------------------------------------------------- saved & search */

messagesRouter.post('/messages/:id/save', async (req, res) => {
  const { message } = await requireMessage(req, req.params.id);
  await run('INSERT INTO saved_messages (user_id, message_id) VALUES (?, ?) ON CONFLICT DO NOTHING', req.user.id, message.id);
  res.json({ message: await getMessage(message.id, req.user.id) });
});

messagesRouter.delete('/messages/:id/save', async (req, res) => {
  const { message } = await requireMessage(req, req.params.id);
  await run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?', req.user.id, message.id);
  res.json({ message: await getMessage(message.id, req.user.id) });
});

const withConversation = async (messages, userId) =>
  Promise.all(messages.map(async (m) => ({ ...m, conversation: await conversationLabel(m.conversation_id, userId) })));

messagesRouter.get('/saved', async (req, res) => {
  const rows = await all(
    `SELECT m.* FROM saved_messages s JOIN messages m ON m.id = s.message_id
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = s.user_id
     WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 200`,
    req.user.id,
  );
  res.json({ messages: await withConversation(await serializeMessages(rows, req.user.id), req.user.id) });
});

messagesRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json({ messages: [] });
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await all(
    `SELECT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
     WHERE m.deleted_at IS NULL AND m.kind != 'system' AND m.body ILIKE ? ESCAPE '\\'
     ORDER BY m.id DESC LIMIT 40`,
    req.user.id,
    like,
  );
  res.json({ messages: await withConversation(await serializeMessages(rows, req.user.id), req.user.id) });
});

/* -------------------------------------------------------------- reminders */

messagesRouter.post('/reminders', async (req, res) => {
  const remindAt = field.datetime(req.body, 'remind_at', { label: 'Reminder time' });
  if (!remindAt) throw badRequest('Choose when to be reminded');
  if (Date.parse(remindAt) < Date.now() - 60e3) throw badRequest('Pick a time in the future');
  const note = field.text(req.body, 'note', { label: 'Note', max: 300, multiline: true }) ?? '';
  const messageId = field.id(req.body, 'message_id', { label: 'Message' }) ?? null;
  let conversationId = null;
  if (messageId) conversationId = (await requireMessage(req, messageId)).message.conversation_id;
  if (!messageId && !note) throw badRequest('Add a note for the reminder');
  const id = await insert(
    'INSERT INTO reminders (user_id, message_id, conversation_id, note, remind_at) VALUES (?, ?, ?, ?, ?)',
    req.user.id,
    messageId,
    conversationId,
    note,
    remindAt,
  );
  await scheduleReminders();
  res.status(201).json({ reminder: await get('SELECT * FROM reminders WHERE id = ?', id) });
});

messagesRouter.get('/reminders', async (req, res) => {
  res.json({ reminders: await upcomingReminders(req.user.id) });
});

messagesRouter.delete('/reminders/:id', async (req, res) => {
  await run('DELETE FROM reminders WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  await scheduleReminders();
  res.json({ ok: true });
});

export async function upcomingReminders(userId) {
  const rows = await all(
    `SELECT r.*, m.body AS message_body, m.kind AS message_kind FROM reminders r LEFT JOIN messages m ON m.id = r.message_id
     WHERE r.user_id = ? AND r.sent_at IS NULL ORDER BY r.remind_at LIMIT 50`,
    userId,
  );
  return Promise.all(rows.map(async (r) => ({ ...r, conversation: r.conversation_id ? await conversationLabel(r.conversation_id, userId) : null })));
}

/**
 * Event-driven reminder scheduler: deliver anything due, then sleep until the next reminder.
 * No polling — so a scale-to-zero database (Neon) is only woken when there is work to do.
 * Called at start-up (catching up on reminders that came due while a free server slept)
 * and whenever a reminder is created or cancelled.
 */
let reminderTimer = null;
export async function scheduleReminders() {
  clearTimeout(reminderTimer);
  await deliverDueReminders();
  const next = await get('SELECT min(remind_at) AS at FROM reminders WHERE sent_at IS NULL');
  if (!next?.at) return;
  const delay = Math.min(Math.max(Date.parse(next.at) - Date.now(), 500), 2 ** 31 - 1);
  reminderTimer = setTimeout(() => scheduleReminders().catch((e) => console.error('reminders:', e.message)), delay);
  reminderTimer.unref?.();
}
export const stopReminders = () => clearTimeout(reminderTimer);

/**
 * Deliver due reminders as a message in the person's private "My space".
 * Also runs at start-up, so reminders that came due while a free-tier server slept still arrive.
 */
export async function deliverDueReminders() {
  // Claim reminders atomically so two server instances never deliver the same one twice.
  const due = await all(
    `UPDATE reminders SET sent_at = ? WHERE id IN (
       SELECT id FROM reminders WHERE sent_at IS NULL AND remind_at <= ? ORDER BY remind_at LIMIT 100 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    now(),
    now(),
  );
  for (const r of due) {
    const self = await get(
      `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE c.type = 'self' AND m.user_id = ?`,
      r.user_id,
    );
    if (!self) continue;
    const original = r.message_id ? await get('SELECT body, conversation_id FROM messages WHERE id = ?', r.message_id) : null;
    const text = r.note || original?.body || 'Reminder';
    await postMessage({
      conversationId: self.id,
      userId: null,
      kind: 'system',
      body: `⏰ Reminder: ${text.slice(0, 300)}`,
      meta: { event: 'reminder', reminder_id: r.id, user_id: r.user_id, message_id: r.message_id, conversation_id: original?.conversation_id ?? null },
    });
  }
}

/* ------------------------------------------------------------------ files */

const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|video\/(mp4|webm)|audio\/(mpeg|ogg|webm|mp4|wav))$/;

/** Save an uploaded file in the database (Render's free disk does not survive restarts). */
async function storeFile(file, uploaderId, conversationId) {
  const key = crypto.randomBytes(18).toString('base64url');
  const filename = (Buffer.from(file.originalname, 'latin1').toString('utf8') || 'file').replace(/[/\\\0]/g, '_').slice(0, 180);
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimetype) ? file.mimetype : 'application/octet-stream';
  return tx(async () => {
    const id = await insert(
      'INSERT INTO attachments (conversation_id, uploader_id, file_key, filename, mime, size) VALUES (?, ?, ?, ?, ?, ?)',
      conversationId,
      uploaderId,
      key,
      filename,
      mime,
      file.size,
    );
    await run('INSERT INTO file_blobs (file_key, data) VALUES (?, ?)', key, file.buffer);
    return get('SELECT * FROM attachments WHERE id = ?', id);
  });
}

const runUpload = (mw) => (req, res) =>
  new Promise((resolve, reject) =>
    mw(req, res, (err) => {
      if (!err) return resolve();
      if (err.code === 'LIMIT_FILE_SIZE') return reject(badRequest(`Files can be up to ${MAX_FILE_MB} MB`));
      if (err.code === 'LIMIT_FILE_COUNT') return reject(badRequest('Up to 10 files at a time'));
      reject(badRequest(err.message));
    }),
  );

messagesRouter.post('/conversations/:id/uploads', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  await runUpload(upload.array('files', 10))(req, res);
  if (!req.files?.length) throw badRequest('Choose a file to upload');
  const files = [];
  for (const f of req.files) files.push(serializeAttachment(await storeFile(f, req.user.id, conversation.id)));
  res.status(201).json({ attachments: files });
});

messagesRouter.post('/uploads/avatar', async (req, res) => {
  await runUpload(upload.single('file'))(req, res);
  if (!req.file) throw badRequest('Choose an image');
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(req.file.mimetype)) throw badRequest('Avatars must be PNG, JPG, GIF or WebP');
  if (req.file.size > 4 * 1024 * 1024) throw badRequest('Avatars can be up to 4 MB');
  res.status(201).json({ url: serializeAttachment(await storeFile(req.file, req.user.id, null)).url });
});

/**
 * Files are served by an unguessable key (capability URL) so <img> tags work in the
 * browser and in the Android app without sending auth headers.
 */
filesRouter.get('/files/:key/:name', async (req, res) => {
  const a = await get(
    'SELECT a.filename, a.mime, b.data FROM attachments a JOIN file_blobs b ON b.file_key = a.file_key WHERE a.file_key = ?',
    req.params.key,
  );
  if (!a) throw notFound('File not found');
  const inline = INLINE_TYPES.test(a.mime);
  res.set({
    'Content-Type': a.mime,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  res.send(Buffer.from(a.data));
});
