import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { canMessageDirectly, memberIds, requireConversation } from '../chat.js';
import { emitToUser } from '../realtime.js';
import { badRequest, forbidden } from '../util.js';

export const callsRouter = Router();

callsRouter.post('/conversations/:id/call/token', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);

  if (conversation.type === 'direct') {
    const otherId = (await memberIds(conversation.id)).find((uid) => uid !== req.user.id);
    if (otherId && !(await canMessageDirectly(req.user.id, otherId))) {
      throw forbidden('You can only call users who have accepted your message request.');
    }
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !serverUrl) {
    throw badRequest('Calling service is not configured on this server.');
  }

  const roomName = `kizuna_room_${conversation.id}`;
  const isVideo = Boolean(req.body.isVideo);

  const at = new AccessToken(apiKey, apiSecret, {
    identity: String(req.user.id),
    name: req.user.name,
    metadata: JSON.stringify({
      avatar: req.user.avatar,
      color: req.user.color,
    }),
  });

  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();

  // Notify other members of the conversation via realtime socket
  const allMembers = await memberIds(conversation.id);
  for (const uid of allMembers) {
    if (uid !== req.user.id) {
      emitToUser(uid, 'call:incoming', {
        conversationId: conversation.id,
        conversationTitle: conversation.name || req.user.name,
        caller: {
          id: req.user.id,
          name: req.user.name,
          avatar: req.user.avatar,
        },
        isVideo,
      });
    }
  }

  res.json({ token, serverUrl, roomName });
});

callsRouter.post('/conversations/:id/call/leave', async (req, res) => {
  const { conversation } = await requireConversation(req, req.params.id);
  const allMembers = await memberIds(conversation.id);
  for (const uid of allMembers) {
    if (uid !== req.user.id) {
      emitToUser(uid, 'call:ended', { conversationId: conversation.id, userId: req.user.id });
    }
  }
  res.json({ ok: true });
});
