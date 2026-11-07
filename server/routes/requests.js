import { Router } from 'express';
import { all, get, insert, run, tx } from '../db.js';
import { publicUser } from '../auth.js';
import { badRequest, field, forbidden, notFound, now } from '../util.js';
import { addMembers, broadcastConversation, conversationFor } from '../chat.js';
import { emitToUser } from '../realtime.js';

export const requestsRouter = Router();

async function getOrCreateDirectConversation(userA, userB) {
  const key = [userA, userB].sort((a, b) => a - b).join(':');
  let cid = (await get('SELECT id FROM conversations WHERE direct_key = ?', key))?.id;
  let created = false;
  if (!cid) {
    cid = await tx(async () => {
      const row = await get(
        `INSERT INTO conversations (type, direct_key, created_by) VALUES ('direct', ?, ?) ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
        key,
        userA,
      );
      if (!row) return (await get('SELECT id FROM conversations WHERE direct_key = ?', key)).id;
      await addMembers(row.id, [userA, userB]);
      created = true;
      return row.id;
    });
  }
  if (created) await broadcastConversation(cid);
  return cid;
}

function serializeRequest(r, senderUser = null, recipientUser = null) {
  return {
    id: r.id,
    sender_id: r.sender_id,
    recipient_id: r.recipient_id,
    status: r.status,
    note: r.note || '',
    created_at: r.created_at,
    updated_at: r.updated_at,
    sender: senderUser ? publicUser(senderUser) : null,
    recipient: recipientUser ? publicUser(recipientUser) : null,
  };
}

/** List all incoming and outgoing requests for the current user. */
requestsRouter.get('/requests', async (req, res) => {
  const incomingRows = await all(
    `SELECT r.*, u.id AS u_id, u.email AS u_email, u.name AS u_name, u.title AS u_title,
            u.color AS u_color, u.avatar AS u_avatar, u.status_emoji AS u_status_emoji,
            u.status_text AS u_status_text, u.last_seen_at AS u_last_seen_at, u.created_at AS u_created_at
     FROM message_requests r
     JOIN users u ON u.id = r.sender_id
     WHERE r.recipient_id = ?
     ORDER BY r.id DESC`,
    req.user.id,
  );

  const outgoingRows = await all(
    `SELECT r.*, u.id AS u_id, u.email AS u_email, u.name AS u_name, u.title AS u_title,
            u.color AS u_color, u.avatar AS u_avatar, u.status_emoji AS u_status_emoji,
            u.status_text AS u_status_text, u.last_seen_at AS u_last_seen_at, u.created_at AS u_created_at
     FROM message_requests r
     JOIN users u ON u.id = r.recipient_id
     WHERE r.sender_id = ?
     ORDER BY r.id DESC`,
    req.user.id,
  );

  const incoming = incomingRows.map((row) => {
    const sender = {
      id: row.u_id,
      email: row.u_email,
      name: row.u_name,
      title: row.u_title,
      color: row.u_color,
      avatar: row.u_avatar,
      status_emoji: row.u_status_emoji,
      status_text: row.u_status_text,
      last_seen_at: row.u_last_seen_at,
      created_at: row.u_created_at,
    };
    return serializeRequest(row, sender, req.user);
  });

  const outgoing = outgoingRows.map((row) => {
    const recipient = {
      id: row.u_id,
      email: row.u_email,
      name: row.u_name,
      title: row.u_title,
      color: row.u_color,
      avatar: row.u_avatar,
      status_emoji: row.u_status_emoji,
      status_text: row.u_status_text,
      last_seen_at: row.u_last_seen_at,
      created_at: row.u_created_at,
    };
    return serializeRequest(row, req.user, recipient);
  });

  res.json({ incoming, outgoing });
});

function validateEmail(obj, key = 'email') {
  const email = field.text(obj, key, { label: 'Email', required: true, max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address');
  return email;
}

/** Look up a user by exact email address and return connection status. */
requestsRouter.get('/requests/lookup', async (req, res) => {
  const email = validateEmail(req.query, 'email');
  const user = await get('SELECT * FROM users WHERE lower(email) = lower(?)', email.trim());
  if (!user) return res.json({ user: null, status: 'not_found' });

  if (user.id === req.user.id) {
    return res.json({ user: publicUser(user), status: 'self' });
  }

  const existing = await get(
    `SELECT * FROM message_requests
     WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
     ORDER BY id DESC LIMIT 1`,
    req.user.id,
    user.id,
    user.id,
    req.user.id,
  );

  let status = 'none';
  if (existing) {
    if (existing.status === 'accepted') status = 'accepted';
    else if (existing.status === 'pending') {
      status = existing.sender_id === req.user.id ? 'pending_outgoing' : 'pending_incoming';
    } else if (existing.status === 'rejected') {
      status = existing.sender_id === req.user.id ? 'rejected_by_them' : 'rejected_by_you';
    }
  }

  res.json({
    user: publicUser(user),
    status,
    request: existing ? serializeRequest(existing, existing.sender_id === req.user.id ? req.user : user, existing.recipient_id === req.user.id ? req.user : user) : null,
  });
});

/** Send a message request to another user by email. */
requestsRouter.post('/requests', async (req, res) => {
  const email = validateEmail(req.body, 'email');
  const note = field.text(req.body, 'note', { label: 'Note', max: 500 }) ?? '';
  const recipient = await get('SELECT * FROM users WHERE lower(email) = lower(?)', email.trim());
  if (!recipient) throw notFound('No user found with that email address');
  if (recipient.id === req.user.id) throw badRequest('You cannot send a message request to yourself');

  const existing = await get(
    `SELECT * FROM message_requests
     WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
     ORDER BY id DESC LIMIT 1`,
    req.user.id,
    recipient.id,
    recipient.id,
    req.user.id,
  );

  const ts = now();

  // Already accepted -> Return direct conversation
  if (existing && existing.status === 'accepted') {
    const cid = await getOrCreateDirectConversation(req.user.id, recipient.id);
    return res.json({
      request: serializeRequest(existing, req.user, recipient),
      conversation: await conversationFor(cid, req.user.id),
      status: 'accepted',
    });
  }

  // Mutual request -> If recipient had already sent a pending request to sender, auto-accept!
  if (existing && existing.sender_id === recipient.id && existing.recipient_id === req.user.id && existing.status === 'pending') {
    await run('UPDATE message_requests SET status = ?, updated_at = ? WHERE id = ?', 'accepted', ts, existing.id);
    const updated = await get('SELECT * FROM message_requests WHERE id = ?', existing.id);
    const cid = await getOrCreateDirectConversation(req.user.id, recipient.id);
    const serialized = serializeRequest(updated, recipient, req.user);
    emitToUser(recipient.id, 'request:updated', { request: serializeRequest(updated, recipient, req.user) });
    emitToUser(req.user.id, 'request:updated', { request: serialized });
    return res.status(200).json({
      request: serialized,
      conversation: await conversationFor(cid, req.user.id),
      status: 'accepted',
    });
  }

  // Already pending from current user
  if (existing && existing.sender_id === req.user.id && existing.status === 'pending') {
    throw badRequest('You have already sent a pending message request to this user');
  }

  // Recipient previously rejected sender's request
  if (existing && existing.recipient_id === recipient.id && existing.status === 'rejected') {
    throw forbidden('This user declined your message request. You cannot message them unless they send a request to you.');
  }

  let requestId;
  if (existing) {
    // Current user was the one who rejected previously, but has now decided to connect!
    await run(
      'UPDATE message_requests SET sender_id = ?, recipient_id = ?, status = ?, note = ?, updated_at = ? WHERE id = ?',
      req.user.id,
      recipient.id,
      'pending',
      note,
      ts,
      existing.id,
    );
    requestId = existing.id;
  } else {
    requestId = await insert(
      'INSERT INTO message_requests (sender_id, recipient_id, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      req.user.id,
      recipient.id,
      'pending',
      note,
      ts,
      ts,
    );
  }

  const newRow = await get('SELECT * FROM message_requests WHERE id = ?', requestId);
  const serialized = serializeRequest(newRow, req.user, recipient);

  emitToUser(recipient.id, 'request:new', { request: serialized });
  res.status(201).json({ request: serialized, status: 'pending' });
});

/** Accept an incoming message request. */
requestsRouter.post('/requests/:id/accept', async (req, res) => {
  const rid = Number(req.params.id);
  if (!Number.isInteger(rid) || rid <= 0) throw notFound('Request not found');
  const request = await get('SELECT * FROM message_requests WHERE id = ?', rid);
  if (!request) throw notFound('Request not found');
  if (request.recipient_id !== req.user.id) throw forbidden('You can only accept requests sent to you');

  const ts = now();
  await run('UPDATE message_requests SET status = ?, updated_at = ? WHERE id = ?', 'accepted', ts, request.id);
  const updated = await get('SELECT * FROM message_requests WHERE id = ?', request.id);
  const sender = await get('SELECT * FROM users WHERE id = ?', updated.sender_id);

  const cid = await getOrCreateDirectConversation(updated.sender_id, updated.recipient_id);

  const serialized = serializeRequest(updated, sender, req.user);
  emitToUser(updated.sender_id, 'request:updated', { request: serialized });
  emitToUser(req.user.id, 'request:updated', { request: serialized });

  res.json({
    request: serialized,
    conversation: await conversationFor(cid, req.user.id),
  });
});

/** Decline an incoming message request. */
requestsRouter.post('/requests/:id/reject', async (req, res) => {
  const rid = Number(req.params.id);
  if (!Number.isInteger(rid) || rid <= 0) throw notFound('Request not found');
  const request = await get('SELECT * FROM message_requests WHERE id = ?', rid);
  if (!request) throw notFound('Request not found');
  if (request.recipient_id !== req.user.id) throw forbidden('You can only decline requests sent to you');

  const ts = now();
  await run('UPDATE message_requests SET status = ?, updated_at = ? WHERE id = ?', 'rejected', ts, request.id);
  const updated = await get('SELECT * FROM message_requests WHERE id = ?', request.id);
  const sender = await get('SELECT * FROM users WHERE id = ?', updated.sender_id);

  const serialized = serializeRequest(updated, sender, req.user);
  emitToUser(updated.sender_id, 'request:updated', { request: serialized });
  emitToUser(req.user.id, 'request:updated', { request: serialized });

  res.json({ request: serialized });
});
