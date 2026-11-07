import { QueryClient, useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { ApiError, api } from './api';
import type { ActiveCall, Conversation, Decision, Goal, Hub, Idea, IncomingCall, ItemType, Message, MessageRequest, Poll, Reminder, Task, Today, User } from './types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
    },
  },
});

/* ------------------------------------------------------------- tiny stores */

function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T | ((v: T) => T)) => {
      value = typeof next === 'function' ? (next as (v: T) => T)(value) : next;
      subs.forEach((s) => s());
    },
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

export const presenceStore = createStore<Set<number>>(new Set());
export const usePresence = () => useSyncExternalStore(presenceStore.subscribe, presenceStore.get);
export const useOnline = (id?: number | null) => usePresence().has(id ?? -1);

/** conversationId → (userId → last typing timestamp) */
export const typingStore = createStore<Map<number, Map<number, number>>>(new Map());
export const useTyping = (cid: number) => {
  const all = useSyncExternalStore(typingStore.subscribe, typingStore.get);
  const now = Date.now();
  return [...(all.get(cid) ?? new Map()).entries()].filter(([, t]) => now - t < 5000).map(([uid]) => uid);
};

export const connectionStore = createStore<'connecting' | 'online' | 'offline'>('connecting');
export const useConnection = () => useSyncExternalStore(connectionStore.subscribe, connectionStore.get);

export const activeCallStore = createStore<ActiveCall | null>(null);
export const useActiveCall = () => useSyncExternalStore(activeCallStore.subscribe, activeCallStore.get);

export const incomingCallStore = createStore<IncomingCall | null>(null);
export const useIncomingCall = () => useSyncExternalStore(incomingCallStore.subscribe, incomingCallStore.get);

/** The conversation currently on screen (used to decide unread counts & notifications). */
export const activeConversation = createStore<number | null>(null);

/* ----------------------------------------------------------------- queries */

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ user: User }>('/auth/me').then((r) => r.user),
    staleTime: Infinity,
    retry: false,
  });
export const useRequests = () =>
  useQuery({
    queryKey: ['requests'],
    queryFn: () => api<{ incoming: MessageRequest[]; outgoing: MessageRequest[] }>('/requests'),
  });
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => api<{ users: User[] }>('/users').then((r) => r.users) });
export const useConversations = () =>
  useQuery({ queryKey: ['conversations'], queryFn: () => api<{ conversations: Conversation[] }>('/conversations').then((r) => r.conversations) });
export const useConversation = (id: number | null) => {
  const { data } = useConversations();
  return data?.find((c) => c.id === id);
};

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
}
export const useMessages = (cid: number) =>
  useQuery({
    queryKey: ['messages', cid],
    queryFn: () => api<{ messages: Message[]; has_more: boolean }>(`/conversations/${cid}/messages?limit=50`).then((r) => ({ messages: r.messages, hasMore: r.has_more })),
    staleTime: Infinity,
  });

export async function loadOlder(cid: number) {
  const page = queryClient.getQueryData<MessagePage>(['messages', cid]);
  if (!page?.hasMore) return false;
  const oldest = page.messages.find((m) => m.id > 0)?.id;
  const r = await api<{ messages: Message[]; has_more: boolean }>(`/conversations/${cid}/messages?limit=50&before=${oldest}`);
  queryClient.setQueryData<MessagePage>(['messages', cid], (p) =>
    p ? { messages: [...r.messages.filter((m) => !p.messages.some((x) => x.id === m.id)), ...p.messages], hasMore: r.has_more } : p,
  );
  return true;
}

export const useHub = (cid: number | null) =>
  useQuery({ queryKey: ['hub', cid], queryFn: () => api<Hub>(`/conversations/${cid}/hub`), enabled: Boolean(cid), staleTime: Infinity });
export const useTasks = (scope: 'assigned' | 'created' | 'all') =>
  useQuery({ queryKey: ['tasks', scope], queryFn: () => api<{ tasks: Task[] }>(`/tasks?scope=${scope}`).then((r) => r.tasks) });
export const useToday = () => useQuery({ queryKey: ['today'], queryFn: () => api<Today>('/today') });
export const useLibrary = () =>
  useQuery({ queryKey: ['library'], queryFn: () => api<{ ideas: Idea[]; goals: Goal[]; decisions: Decision[] }>('/library') });
export const useSaved = () => useQuery({ queryKey: ['saved'], queryFn: () => api<{ messages: Message[] }>('/saved').then((r) => r.messages) });
export const usePins = (cid: number) => useQuery({ queryKey: ['pins', cid], queryFn: () => api<{ messages: Message[] }>(`/conversations/${cid}/pins`).then((r) => r.messages) });
export const useFiles = (cid: number) =>
  useQuery({
    queryKey: ['files', cid],
    queryFn: () => api<{ files: (Message['attachments'][number] & { message_id: number; user_name: string; created_at: string })[] }>(`/conversations/${cid}/files`).then((r) => r.files),
  });
export const useReminders = () => useQuery({ queryKey: ['reminders'], queryFn: () => api<{ reminders: Reminder[] }>('/reminders').then((r) => r.reminders) });

/* ----------------------------------------------------------- cache updates */

const PREFIX: Partial<Record<Message['kind'], string>> = { task: '✅ Task', idea: '💡 Idea', goal: '🎯 Goal', decision: '⚖️ Decision', poll: '📊 Poll' };

export function previewOf(m: Message): Conversation['last_message'] {
  let text = m.body;
  if (m.deleted) text = 'Message deleted';
  else if (m.kind === 'checkin') text = '☀️ Check-in';
  else if (PREFIX[m.kind]) text = `${PREFIX[m.kind]}: ${m.body}`;
  else if (!text && m.attachments.length) text = m.attachments[0].mime.startsWith('image/') ? '📷 Photo' : `📎 ${m.attachments[0].filename}`;
  return { id: m.id, user_id: m.user_id, user_name: m.user?.name ?? null, kind: m.kind, text, created_at: m.created_at };
}

const sortConversations = (list: Conversation[]) =>
  [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last_message_at.localeCompare(a.last_message_at));

export function upsertConversation(c: Conversation) {
  queryClient.setQueryData<Conversation[]>(['conversations'], (list) => {
    if (!list) return list;
    const exists = list.some((x) => x.id === c.id);
    return sortConversations(exists ? list.map((x) => (x.id === c.id ? c : x)) : [c, ...list]);
  });
}

export function patchConversation(id: number, patch: (c: Conversation) => Conversation) {
  queryClient.setQueryData<Conversation[]>(['conversations'], (list) => (list ? sortConversations(list.map((c) => (c.id === id ? patch(c) : c))) : list));
}

/** Add or replace a message everywhere it appears. `isNew` bumps the conversation and unread count. */
export function applyMessage(m: Message, { isNew = false, meId }: { isNew?: boolean; meId?: number } = {}) {
  let added = false;
  queryClient.setQueryData<MessagePage>(['messages', m.conversation_id], (p) => {
    if (!p) return p;
    const idx = p.messages.findIndex((x) => x.id === m.id);
    if (idx >= 0) {
      const old = p.messages[idx];
      const merged = { ...old, ...m, saved: m.saved ?? old.saved };
      return { ...p, messages: p.messages.map((x, i) => (i === idx ? merged : x)) };
    }
    if (!isNew) return p;
    added = true;
    // Drop the optimistic copy (negative id) that this message replaces.
    const rest = p.messages.filter((x) => !(x.id < 0 && x.user_id === m.user_id && x.body === m.body && x.kind === m.kind));
    const order = (x: Message) => (x.id < 0 ? Number.MAX_SAFE_INTEGER : x.id);
    return { ...p, messages: [...rest, m].sort((a, b) => order(a) - order(b)) };
  });
  const list = queryClient.getQueryData<Conversation[]>(['conversations']);
  const conv = list?.find((c) => c.id === m.conversation_id);
  if (!conv) {
    if (isNew) queryClient.invalidateQueries({ queryKey: ['conversations'] });
    return;
  }
  const mine = m.user_id != null && m.user_id === meId;
  const viewing = activeConversation.get() === m.conversation_id && document.visibilityState === 'visible';
  if (isNew && (added || !queryClient.getQueryData(['messages', m.conversation_id]))) {
    patchConversation(conv.id, (c) => ({
      ...c,
      last_message: previewOf(m),
      last_message_at: m.created_at,
      unread_count: mine || viewing ? c.unread_count : c.unread_count + 1,
      mention_count: !mine && !viewing && meId != null && m.mentions.includes(meId) ? c.mention_count + 1 : c.mention_count,
      last_read_id: mine ? m.id : c.last_read_id,
    }));
  } else if (conv.last_message?.id === m.id) {
    patchConversation(conv.id, (c) => ({ ...c, last_message: previewOf(m) }));
  }
  if (m.kind !== 'text' && m.kind !== 'system') queryClient.invalidateQueries({ queryKey: ['hub', m.conversation_id] });
}

export function removeMessage(cid: number, id: number) {
  queryClient.setQueryData<MessagePage>(['messages', cid], (p) => (p ? { ...p, messages: p.messages.filter((m) => m.id !== id) } : p));
}

const ITEM_KEY: Record<ItemType, keyof Hub> = { task: 'tasks', idea: 'ideas', goal: 'goals', decision: 'decisions', poll: 'polls' };

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Cross-conversation views (Today, Tasks, Library) refresh shortly after any item changes. */
export function refreshWorkViews() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const key of ['today', 'tasks', 'library', 'conversations']) queryClient.invalidateQueries({ queryKey: [key] });
  }, 250);
}

export function applyItem(type: ItemType, item: Task | Idea | Goal | Decision | Poll) {
  const key = ITEM_KEY[type];
  queryClient.setQueryData<Hub>(['hub', item.conversation_id], (hub) => {
    if (!hub) return hub;
    const list = hub[key] as { id: number }[];
    const exists = list.some((x) => x.id === item.id);
    return { ...hub, [key]: exists ? list.map((x) => (x.id === item.id ? item : x)) : [item, ...list] };
  });
  if (type === 'task') {
    for (const scope of ['assigned', 'created', 'all']) {
      queryClient.setQueryData<Task[]>(['tasks', scope], (list) => list?.map((t) => (t.id === item.id ? { ...t, ...(item as Task) } : t)));
    }
  }
  refreshWorkViews();
}

export function removeItem(type: ItemType, cid: number, id: number) {
  const key = ITEM_KEY[type];
  queryClient.setQueryData<Hub>(['hub', cid], (hub) => (hub ? { ...hub, [key]: (hub[key] as { id: number }[]).filter((x) => x.id !== id) } : hub));
  refreshWorkViews();
}

export function applyUser(u: User) {
  queryClient.setQueryData<User[]>(['users'], (list) => list?.map((x) => (x.id === u.id ? { ...x, ...u } : x)));
  queryClient.setQueryData<Conversation[]>(['conversations'], (list) =>
    list?.map((c) => (c.members.some((m) => m.id === u.id) ? { ...c, members: c.members.map((m) => (m.id === u.id ? { ...m, ...u } : m)) } : c)),
  );
  const me = queryClient.getQueryData<User>(['me']);
  if (me?.id === u.id) queryClient.setQueryData(['me'], { ...me, ...u });
}

export function markReadLocally(cid: number, userId: number, lastReadId: number, isMe: boolean) {
  patchConversation(cid, (c) => ({
    ...c,
    ...(isMe ? { unread_count: 0, mention_count: 0, last_read_id: Math.max(c.last_read_id, lastReadId) } : {}),
    members: c.members.map((m) => (m.id === userId ? { ...m, last_read_id: Math.max(m.last_read_id, lastReadId) } : m)),
  }));
}
