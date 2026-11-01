import { Server } from 'socket.io';
import { all, run } from './db.js';
import { userForToken } from './auth.js';
import { now } from './util.js';

/**
 * Socket.IO is used only for server → client pushes (plus typing indicators).
 * All writes go through the REST API, which validates and then emits here.
 *
 * Rooms:  user:<id>  — every socket of one user
 *         conv:<id>  — every socket of every member of a conversation
 */
let io = null;
const online = new Map(); // userId -> open socket count

export function initRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: true },
    maxHttpBufferSize: 1e5,
    pingInterval: 20000,
  });

  io.use(async (socket, next) => {
    try {
      const user = await userForToken(socket.handshake.auth?.token);
      if (!user) return next(new Error('unauthorized'));
      socket.data.userId = user.id;
      next();
    } catch (e) {
      next(e);
    }
  });

  io.on('connection', async (socket) => {
    const uid = socket.data.userId;
    socket.join(`user:${uid}`);
    const count = online.get(uid) ?? 0;
    online.set(uid, count + 1);
    if (!count) io.emit('presence', { user_id: uid, online: true });
    socket.emit('presence:snapshot', { online: [...online.keys()] });

    socket.on('typing', (payload) => {
      const cid = Number(payload?.conversationId);
      if (!Number.isInteger(cid) || !socket.rooms.has(`conv:${cid}`)) return;
      socket.to(`conv:${cid}`).emit('typing', { conversation_id: cid, user_id: uid });
    });

    socket.on('disconnect', async () => {
      const n = (online.get(uid) ?? 1) - 1;
      if (n > 0) return void online.set(uid, n);
      online.delete(uid);
      const ts = now();
      io.emit('presence', { user_id: uid, online: false, last_seen_at: ts });
      await run('UPDATE users SET last_seen_at = ? WHERE id = ?', ts, uid).catch(() => {});
    });

    try {
      for (const { conversation_id } of await all('SELECT conversation_id FROM conversation_members WHERE user_id = ?', uid)) {
        socket.join(`conv:${conversation_id}`);
      }
    } catch (e) {
      console.error('socket join failed:', e.message);
    }
  });
  return io;
}

export const isOnline = (uid) => online.has(uid);
export const emitAll = (event, payload) => io?.emit(event, payload);
export const emitToConversation = (cid, event, payload) => io?.to(`conv:${cid}`).emit(event, payload);
export const emitToUser = (uid, event, payload) => io?.to(`user:${uid}`).emit(event, payload);
export const joinConversation = (uid, cid) => io?.in(`user:${uid}`).socketsJoin(`conv:${cid}`);
export const leaveConversation = (uid, cid) => io?.in(`user:${uid}`).socketsLeave(`conv:${cid}`);
export const closeRealtime = () => io?.close();
