import { io, type Socket } from 'socket.io-client';
import { getToken, serverUrl } from './api';
import { isAppActive, notify } from './platform';
import {
  activeConversation,
  applyItem,
  applyMessage,
  applyUser,
  connectionStore,
  markReadLocally,
  presenceStore,
  queryClient,
  removeItem,
  removeMessage,
  typingStore,
  upsertConversation,
} from './store';
import { conversationTitle } from './format';
import { toast } from '../components/Toast';
import type { Conversation, ItemType, Message, MessageRequest, User } from './types';

let socket: Socket | null = null;

export function connectRealtime(me: User) {
  disconnectRealtime();
  connectionStore.set('connecting');
  const s = io(serverUrl() || undefined, { auth: { token: getToken() }, transports: ['websocket', 'polling'], reconnectionDelayMax: 8000 });
  socket = s;
  let everConnected = false;

  s.on('connect', () => {
    connectionStore.set('online');
    // After a reconnect, catch up on anything we missed while offline.
    if (everConnected) queryClient.invalidateQueries();
    everConnected = true;
  });
  s.on('disconnect', () => connectionStore.set('offline'));
  s.on('connect_error', () => connectionStore.set('offline'));

  s.on('message:new', ({ message }: { message: Message }) => {
    applyMessage(message, { isNew: true, meId: me.id });
    typingStore.set((map) => {
      const conv = map.get(message.conversation_id);
      if (message.user_id && conv?.delete(message.user_id)) return new Map(map);
      return map;
    });
    maybeNotify(message, me);
    if (message.kind === 'system' && message.meta?.event === 'pinned') queryClient.invalidateQueries({ queryKey: ['pins', message.conversation_id] });
    if (message.attachments.length) queryClient.invalidateQueries({ queryKey: ['files', message.conversation_id] });
  });
  s.on('message:update', ({ message }: { message: Message }) => {
    applyMessage(message, { meId: me.id });
    queryClient.invalidateQueries({ queryKey: ['pins', message.conversation_id] });
  });
  s.on('message:remove', ({ conversation_id, id }: { conversation_id: number; id: number }) => removeMessage(conversation_id, id));

  s.on('conversation:upsert', ({ conversation }: { conversation: Conversation }) => upsertConversation(conversation));
  s.on('conversation:remove', ({ id }: { id: number }) => {
    queryClient.setQueryData<Conversation[]>(['conversations'], (list) => list?.filter((c) => c.id !== id));
    queryClient.removeQueries({ queryKey: ['messages', id] });
    queryClient.removeQueries({ queryKey: ['hub', id] });
  });

  s.on('read', ({ conversation_id, user_id, last_read_id }: { conversation_id: number; user_id: number; last_read_id: number }) =>
    markReadLocally(conversation_id, user_id, last_read_id, user_id === me.id),
  );

  s.on('typing', ({ conversation_id, user_id }: { conversation_id: number; user_id: number }) => {
    typingStore.set((map) => {
      const next = new Map(map);
      next.set(conversation_id, new Map(next.get(conversation_id) ?? []).set(user_id, Date.now()));
      return next;
    });
    setTimeout(() => typingStore.set((m) => new Map(m)), 5200);
  });

  s.on('presence:snapshot', ({ online }: { online: number[] }) => presenceStore.set(new Set(online)));
  s.on('presence', ({ user_id, online, last_seen_at }: { user_id: number; online: boolean; last_seen_at?: string }) => {
    presenceStore.set((set) => {
      const next = new Set(set);
      if (online) next.add(user_id);
      else next.delete(user_id);
      return next;
    });
    if (last_seen_at) applyUser({ id: user_id, last_seen_at } as User);
  });

  s.on('item', ({ type, item }: { type: ItemType; item: Parameters<typeof applyItem>[1] }) => applyItem(type, item));
  s.on('item:remove', ({ type, id, conversation_id }: { type: ItemType; id: number; conversation_id: number }) => removeItem(type, conversation_id, id));
  s.on('user:update', ({ user }: { user: User }) => applyUser(user));

  s.on('request:new', ({ request }: { request: MessageRequest }) => {
    queryClient.invalidateQueries({ queryKey: ['requests'] });
    toast(`New message request from ${request.sender?.name || 'a teammate'}`);
  });
  s.on('request:updated', () => {
    queryClient.invalidateQueries({ queryKey: ['requests'] });
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
    queryClient.invalidateQueries({ queryKey: ['users'] });
  });
}

export function disconnectRealtime() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}

let lastTyping = 0;
export function sendTyping(conversationId: number) {
  if (Date.now() - lastTyping < 2500) return;
  lastTyping = Date.now();
  socket?.emit('typing', { conversationId });
}

/* ---------------------------------------------------------- notifications */

function maybeNotify(m: Message, me: User) {
  if (m.user_id === me.id && !(m.kind === 'system' && m.meta?.event === 'reminder')) return;
  const conv = queryClient.getQueryData<Conversation[]>(['conversations'])?.find((c) => c.id === m.conversation_id);
  if (!conv) return;
  const viewing = activeConversation.get() === m.conversation_id && isAppActive();
  if (viewing) return;

  const mentioned = m.mentions.includes(me.id);
  const assigned = (m.kind === 'task' && m.meta?.assignee_id === me.id) || (m.meta?.event === 'task_assigned' && m.meta?.assignee_id === me.id);
  const reminder = m.meta?.event === 'reminder';
  if (conv.muted && !mentioned && !assigned && !reminder) return;
  if (m.kind === 'system' && !assigned && !reminder && m.meta?.event !== 'goal_achieved') return;

  const title = conversationTitle(conv, me.id);
  const who = m.user?.name ?? 'Kizuna';
  let body = m.body || (m.attachments.length ? '📎 Sent an attachment' : '');
  if (assigned) body = `${who} assigned you a task: ${m.kind === 'task' ? m.body : m.body.replace(/^.*assigned /, '')}`;
  else if (m.kind === 'idea') body = `💡 ${who} shared an idea: ${m.body}`;
  else if (m.kind === 'decision') body = `⚖️ Decision: ${m.body}`;
  else if (m.kind === 'poll') body = `📊 ${who} started a poll: ${m.body}`;
  else if (m.kind === 'goal') body = `🎯 New goal: ${m.body}`;
  else if (m.kind === 'checkin') body = `☀️ ${who} posted a check-in`;
  else if (conv.type === 'group' && m.kind === 'text') body = `${who}: ${body}`;

  const to = `/chats/${m.conversation_id}`;
  if (isAppActive()) {
    if (mentioned || assigned || reminder || conv.type !== 'group') toast(`${title} — ${body}`, 'info', to);
  } else {
    notify(reminder ? '⏰ Reminder' : mentioned ? `${who} mentioned you` : title, body, to);
  }
}
