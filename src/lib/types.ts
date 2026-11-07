export interface User {
  id: number;
  name: string;
  email: string;
  title: string;
  color: string;
  avatar: string | null;
  status_emoji: string;
  status_text: string;
  last_seen_at: string | null;
  online?: boolean;
}

export interface MessageRequest {
  id: number;
  sender_id: number;
  recipient_id: number;
  status: 'pending' | 'accepted' | 'rejected';
  note: string;
  created_at: string;
  updated_at: string;
  sender: User | null;
  recipient: User | null;
}

export interface ActiveCall {
  conversationId: number;
  token: string;
  serverUrl: string;
  roomName: string;
  isVideo: boolean;
  minimized?: boolean;
}

export interface IncomingCall {
  conversationId: number;
  conversationTitle: string;
  caller: {
    id: number;
    name: string;
    avatar: string | null;
  };
  isVideo: boolean;
}

export interface Member extends User {
  role: 'owner' | 'admin' | 'member';
  last_read_id: number;
}

export type ConversationType = 'direct' | 'group' | 'self';

export interface Conversation {
  id: number;
  type: ConversationType;
  name: string;
  description: string;
  emoji: string;
  color: string;
  created_by: number | null;
  created_at: string;
  last_message_at: string;
  role: Member['role'];
  muted: boolean;
  pinned: boolean;
  last_read_id: number;
  members: Member[];
  last_message: { id: number; user_id: number | null; user_name: string | null; kind: MessageKind; text: string; created_at: string } | null;
  unread_count: number;
  mention_count: number;
  open_tasks: number;
}

export type MessageKind = 'text' | 'system' | 'task' | 'idea' | 'goal' | 'decision' | 'poll' | 'checkin';

export interface Attachment {
  id: number;
  filename: string;
  mime: string;
  size: number;
  url: string;
}

export interface Message {
  id: number;
  conversation_id: number;
  user_id: number | null;
  user: { id: number; name: string; color: string; avatar: string | null } | null;
  kind: MessageKind;
  body: string;
  ref_id: number | null;
  meta: Record<string, unknown> | null;
  reply_to: { id: number; user_id: number | null; user_name: string | null; kind: MessageKind; body: string; deleted: boolean } | null;
  reactions: { emoji: string; user_ids: number[] }[];
  attachments: Attachment[];
  mentions: number[];
  pinned: boolean;
  edited: boolean;
  deleted: boolean;
  created_at: string;
  saved?: boolean;
  conversation?: ConversationLabel;
}

export interface ConversationLabel {
  id: number;
  type: ConversationType;
  name: string;
  emoji: string;
  color: string;
  avatar?: string | null;
}

export type TaskStatus = 'todo' | 'doing' | 'done';
export type Priority = 'high' | 'normal' | 'low';

export interface Task {
  id: number;
  conversation_id: number;
  title: string;
  notes: string;
  assignee_id: number | null;
  created_by: number | null;
  due_date: string | null;
  priority: Priority;
  status: TaskStatus;
  message_id: number | null;
  source_message_id: number | null;
  completed_at: string | null;
  completed_by: number | null;
  created_at: string;
  updated_at: string;
  conversation?: ConversationLabel;
}

export type IdeaStatus = 'new' | 'exploring' | 'accepted' | 'parked';

export interface Idea {
  id: number;
  conversation_id: number;
  title: string;
  body: string;
  status: IdeaStatus;
  created_by: number | null;
  message_id: number | null;
  created_at: string;
  updated_at: string;
  votes: number[];
  conversation?: ConversationLabel;
}

export interface Goal {
  id: number;
  conversation_id: number;
  title: string;
  description: string;
  unit: string;
  start_value: number;
  target_value: number;
  current_value: number;
  due_date: string | null;
  owner_id: number | null;
  status: 'active' | 'achieved' | 'dropped';
  created_by: number | null;
  message_id: number | null;
  created_at: string;
  updated_at: string;
  updates: { id: number; user_id: number | null; user_name: string | null; value: number; note: string; created_at: string }[];
  conversation?: ConversationLabel;
}

export interface Decision {
  id: number;
  conversation_id: number;
  title: string;
  context: string;
  created_by: number | null;
  message_id: number | null;
  created_at: string;
  acks: number[];
  conversation?: ConversationLabel;
}

export interface Poll {
  id: number;
  conversation_id: number;
  question: string;
  multiple: boolean;
  created_by: number | null;
  message_id: number | null;
  closed_at: string | null;
  created_at: string;
  options: { id: number; label: string; votes: number[] }[];
}

export interface Hub {
  tasks: Task[];
  ideas: Idea[];
  goals: Goal[];
  decisions: Decision[];
  polls: Poll[];
}

export type ItemType = 'task' | 'idea' | 'goal' | 'decision' | 'poll';

export interface Reminder {
  id: number;
  user_id: number;
  message_id: number | null;
  conversation_id: number | null;
  note: string;
  remind_at: string;
  sent_at: string | null;
  message_body: string | null;
  conversation: ConversationLabel | null;
}

export interface Today {
  my_tasks: Task[];
  waiting_on: Task[];
  goals: Goal[];
  ideas: Idea[];
  decisions: Decision[];
  reminders: Reminder[];
  stats: { done_week: number; open: number; overdue: number };
}
