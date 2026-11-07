import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AtSign, BellOff, MessageSquarePlus, Pin, Search, UserCheck } from 'lucide-react';
import { conversationTitle, cx, listTime } from '../lib/format';
import { useConversations, useMe, useRequests, useTyping } from '../lib/store';
import type { Conversation, User } from '../lib/types';
import { ChatView, NoChatSelected } from '../components/ChatView';
import { NewChat } from '../components/ConversationInfo';
import { RequestsModal } from '../components/RequestsModal';
import { ConvAvatar, Empty, Loader } from '../components/ui';

type Filter = 'all' | 'unread' | 'groups' | 'direct';

export function ChatsPage() {
  const id = Number(useParams().id) || null;
  const { data: me } = useMe();
  const { data: conversations, isLoading } = useConversations();
  const { data: requestsData } = useRequests();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [viewingRequests, setViewingRequests] = useState(false);
  const active = conversations?.find((c) => c.id === id);

  const pendingRequests = (requestsData?.incoming ?? []).filter((r) => r.status === 'pending');

  const list = (conversations ?? []).filter((c) => {
    if (filter === 'unread' && !c.unread_count) return false;
    if (filter === 'groups' && c.type !== 'group') return false;
    if (filter === 'direct' && c.type !== 'direct') return false;
    return !q || conversationTitle(c, me?.id).toLowerCase().includes(q.toLowerCase());
  });

  return (
    <div className={cx('chats-page', id && 'has-chat')}>
      <aside className="conv-pane">
        <header className="pane-head">
          <h1>Chats</h1>
          <div className="pane-actions">
            <button
              className={cx('icon-btn', pendingRequests.length > 0 && 'has-badge')}
              onClick={() => setViewingRequests(true)}
              aria-label="Message requests"
              title="Message requests"
            >
              <UserCheck size={20} />
              {pendingRequests.length > 0 && <span className="action-badge">{pendingRequests.length}</span>}
            </button>
            <button className="icon-btn accent" onClick={() => setCreating(true)} aria-label="New conversation" title="New conversation">
              <MessageSquarePlus size={21} />
            </button>
          </div>
        </header>

        {pendingRequests.length > 0 && (
          <div className="requests-banner" onClick={() => setViewingRequests(true)}>
            <div className="requests-banner-content">
              <strong>{pendingRequests.length} new message request{pendingRequests.length > 1 ? 's' : ''}</strong>
              <span className="small muted">Review and accept to start chatting</span>
            </div>
            <button className="btn btn-sm btn-primary">Review</button>
          </div>
        )}

        <div className="search-box">
          <Search size={16} />
          <input placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="filter-chips">
          {(['all', 'unread', 'groups', 'direct'] as Filter[]).map((f) => (
            <button key={f} className={cx('chip', filter === f && 'on')} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : f === 'groups' ? 'Groups' : 'Direct'}
            </button>
          ))}
        </div>
        <div className="conv-list">
          {isLoading ? (
            <Loader />
          ) : list.length ? (
            list.map((c) => <ConversationRow key={c.id} c={c} me={me} active={c.id === id} />)
          ) : (
            <Empty title={filter === 'unread' ? 'All caught up ✨' : 'No conversations'}>
              {filter === 'all' && !q ? 'Connect with teammates via email to start a direct message.' : null}
            </Empty>
          )}
        </div>
      </aside>
      <section className="chat-pane">{active ? <ChatView conversation={active} /> : id && isLoading ? <Loader /> : <NoChatSelected />}</section>
      {me && <NewChat open={creating} onClose={() => setCreating(false)} me={me} />}
      <RequestsModal open={viewingRequests} onClose={() => setViewingRequests(false)} />
    </div>
  );
}

function ConversationRow({ c, me, active }: { c: Conversation; me?: User; active: boolean }) {
  const navigate = useNavigate();
  const typing = useTyping(c.id).filter((uid) => uid !== me?.id);
  const title = conversationTitle(c, me?.id);
  const lm = c.last_message;
  let preview = lm?.text ?? (c.type === 'self' ? 'Your private notes & todos' : 'No messages yet');
  if (lm && lm.kind !== 'system' && lm.user_id) {
    if (lm.user_id === me?.id) preview = `You: ${preview}`;
    else if (c.type === 'group' && lm.user_name) preview = `${lm.user_name.split(' ')[0]}: ${preview}`;
  }
  const typingText = typing.length
    ? c.type === 'group'
      ? `${c.members.find((m) => m.id === typing[0])?.name.split(' ')[0]} is typing…`
      : 'typing…'
    : null;
  return (
    <button className={cx('conv-row', active && 'active', c.unread_count > 0 && 'unread')} onClick={() => navigate(`/chats/${c.id}`)}>
      <ConvAvatar label={{ ...c, name: title }} members={c.members} meId={me?.id} size={48} />
      <span className="conv-main">
        <span className="conv-top">
          <strong className="truncate">{title}</strong>
          {c.muted && <BellOff size={13} className="muted" />}
          <span className="conv-time">{lm ? listTime(lm.created_at) : ''}</span>
        </span>
        <span className="conv-bottom">
          <span className={cx('conv-preview truncate', typingText && 'typing')}>{typingText ?? preview}</span>
          {c.pinned && !c.unread_count && <Pin size={13} className="muted" />}
          {c.mention_count > 0 && (
            <span className="mention-badge" title="You were mentioned">
              <AtSign size={12} />
            </span>
          )}
          {c.unread_count > 0 && <span className={cx('unread-badge', c.muted && 'muted-badge')}>{c.unread_count > 99 ? '99+' : c.unread_count}</span>}
          {c.open_tasks > 0 && !c.unread_count && <span className="task-count" title="Open tasks">✓ {c.open_tasks}</span>}
        </span>
      </span>
    </button>
  );
}
