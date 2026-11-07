import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, BellOff, Info, LayoutPanelLeft, Phone, Pin, Upload, Video, X } from 'lucide-react';
import { api } from '../lib/api';
import { conversationTitle, cx, dayLabel, firstName, lastSeen, otherMember, plural } from '../lib/format';
import { activeCallStore, activeConversation, loadOlder, markReadLocally, useHub, useMe, useMessages, useOnline, useTyping, usePresence } from '../lib/store';
import type { ActiveCall, Conversation, Message, User } from '../lib/types';
import { Composer, type ComposerHandle } from './Composer';
import { MessageItem } from './Message';
import { HubPanel, type HubTab } from './HubPanel';
import { ConversationInfo } from './ConversationInfo';
import { ConvAvatar, Empty, Loader, Modal, Spinner } from './ui';
import { useWork } from './WorkForms';
import { toastError } from './Toast';

const GROUP_GAP = 5 * 60e3;

export function ChatView({ conversation }: { conversation: Conversation }) {
  const { data: me } = useMe();
  if (!me) return null;
  return <Chat key={conversation.id} conversation={conversation} me={me} />;
}

function Chat({ conversation, me }: { conversation: Conversation; me: User }) {
  const cid = conversation.id;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, isLoading } = useMessages(cid);
  const { data: hub } = useHub(cid);
  const typing = useTyping(cid).filter((id) => id !== me.id);
  const work = useWork();

  const panelParam = params.get('panel') as HubTab | null;
  const [panelPref, setPanelPref] = useState<HubTab | null>(() => (window.innerWidth >= 1280 ? ((localStorage.getItem('kizuna-panel') as HubTab) ?? null) : null));
  const panel = panelParam ?? panelPref;
  const setPanel = (t: HubTab | null) => {
    if (window.innerWidth >= 1100) {
      setPanelPref(t);
      if (t) localStorage.setItem('kizuna-panel', t);
      else localStorage.removeItem('kizuna-panel');
      if (panelParam) setParams((p) => (p.delete('panel'), p));
    } else setParams((p) => (t ? p.set('panel', t) : p.delete('panel'), p));
  };

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [info, setInfo] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const restore = useRef<number | null>(null);
  const nearBottom = useRef(true);
  const initial = useRef(true);
  const unreadFrom = useRef<number>(conversation.unread_count > 0 ? conversation.last_read_id : Infinity);

  const messages = useMemo(() => data?.messages ?? [], [data]);
  const lastMine = [...messages].reverse().find((m) => m.user_id === me.id && m.id > 0 && m.kind !== 'system');

  useEffect(() => {
    activeConversation.set(cid);
    return () => activeConversation.set(null);
  }, [cid]);

  /* --------------------------------------------------------------- scroll */
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !data) return;
    if (restore.current !== null) {
      el.scrollTop += el.scrollHeight - restore.current;
      restore.current = null;
      return;
    }
    if (initial.current) {
      initial.current = false;
      const divider = el.querySelector('.unread-divider') as HTMLElement | null;
      if (divider) el.scrollTop = divider.offsetTop - 80;
      else scrollToBottom();
      return;
    }
    if (nearBottom.current) scrollToBottom();
  }, [data, scrollToBottom]);

  // Keep pinned to the bottom when images load or the keyboard resizes the view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => nearBottom.current && scrollToBottom());
    ro.observe(el);
    const imgs = (e: Event) => (e.target as HTMLElement).tagName === 'IMG' && nearBottom.current && scrollToBottom();
    el.addEventListener('load', imgs, true);
    return () => {
      ro.disconnect();
      el.removeEventListener('load', imgs, true);
    };
  }, [scrollToBottom]);

  const onScroll = async () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    nearBottom.current = near;
    if (near !== atBottom) setAtBottom(near);
    if (el.scrollTop < 300 && data?.hasMore && !loadingOlder) {
      setLoadingOlder(true);
      restore.current = el.scrollHeight;
      try {
        if (!(await loadOlder(cid))) restore.current = null;
      } finally {
        setLoadingOlder(false);
      }
    }
  };

  /* ---------------------------------------------------- jump to a message */
  const jumpTo = useCallback(
    async (id: number) => {
      for (let i = 0; i < 15; i++) {
        const el = document.getElementById(`m-${id}`);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setHighlight(id);
          setTimeout(() => setHighlight(null), 1800);
          return;
        }
        restore.current = scroller.current?.scrollHeight ?? null;
        if (!(await loadOlder(cid))) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    [cid],
  );

  const jumpParam = Number(params.get('m')) || null;
  useEffect(() => {
    if (!jumpParam || !data) return;
    jumpTo(jumpParam);
    setParams((p) => (p.delete('m'), p), { replace: true });
  }, [jumpParam, data, jumpTo, setParams]);

  /* ------------------------------------------------------------ mark read */
  const lastId = [...messages].reverse().find((m) => m.id > 0)?.id ?? 0;
  useEffect(() => {
    if (!lastId || lastId <= conversation.last_read_id) return;
    const markIfVisible = () => {
      if (document.visibilityState !== 'visible' || !nearBottom.current) return;
      markReadLocally(cid, me.id, lastId, true);
      api(`/conversations/${cid}/read`, { method: 'POST', body: { message_id: lastId } }).catch(() => {});
    };
    const t = setTimeout(markIfVisible, 400);
    document.addEventListener('visibilitychange', markIfVisible);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', markIfVisible);
    };
  }, [lastId, conversation.last_read_id, cid, me.id, atBottom]);

  /* -------------------------------------------------------------- header */
  const title = conversationTitle(conversation, me.id);
  const other = otherMember(conversation, me.id);
  const otherOnline = useOnline(other?.id);
  const presence = usePresence();
  const onlineCount = conversation.members.filter((m) => m.id !== me.id && presence.has(m.id)).length;
  const typingNames = typing.map((id) => firstName(conversation.members.find((m) => m.id === id)?.name)).filter(Boolean);
  const subtitle = typingNames.length
    ? `${typingNames.join(', ')} ${typingNames.length > 1 ? 'are' : 'is'} typing…`
    : conversation.type === 'direct' && other
      ? [lastSeen(other, otherOnline), other.status_text && `${other.status_emoji} ${other.status_text}`].filter(Boolean).join(' · ')
      : conversation.type === 'self'
        ? 'Private notes, todos and goals — only you can see this'
        : `${plural(conversation.members.length, 'member')}${onlineCount ? ` · ${onlineCount} online` : ''}`;
  const pinned = useMemo(() => [...messages].reverse().find((m) => m.pinned && !m.deleted), [messages]);
  const openTasks = hub?.tasks.filter((t) => t.status !== 'done').length ?? conversation.open_tasks;

  /* ---------------------------------------------------------------- body */
  let lastDay = '';
  const rows = messages.map((m, i) => {
    const prev = messages[i - 1];
    const day = dayLabel(m.created_at);
    const showDay = day !== lastDay;
    lastDay = day;
    const grouped = Boolean(
      prev && !showDay && prev.user_id === m.user_id && prev.kind !== 'system' && m.kind !== 'system' && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_GAP,
    );
    const showUnread = m.id > unreadFrom.current && (prev?.id ?? 0) <= unreadFrom.current && m.user_id !== me.id;
    return (
      <Fragment key={m.id}>
        {showDay && (
          <div className="day-divider">
            <span>{day}</span>
          </div>
        )}
        {showUnread && (
          <div className="unread-divider">
            <span>New messages</span>
          </div>
        )}
        <MessageItem
          message={m}
          conversation={conversation}
          me={me}
          hub={hub}
          grouped={grouped && !showUnread}
          showSeen={m.id === lastMine?.id}
          highlight={highlight === m.id}
          onReply={(msg) => {
            setEditing(null);
            setReplyTo(msg);
          }}
          onEdit={(msg) => {
            setReplyTo(null);
            setEditing(msg);
          }}
          onJump={jumpTo}
          onImage={setLightbox}
        />
      </Fragment>
    );
  });

  const startCall = async (isVideo: boolean) => {
    try {
      const res = await api<ActiveCall>(`/conversations/${cid}/call/token`, {
        method: 'POST',
        body: { isVideo },
      });
      activeCallStore.set({
        ...res,
        conversationId: cid,
        isVideo,
      });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className={cx('chat-layout', panel && 'with-panel')}>
      <section
        className="chat"
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes('Files')) setDragging(true);
        }}
      >
        <header className="chat-head">
          <button className="icon-btn back-btn" onClick={() => navigate('/chats')} aria-label="Back">
            <ArrowLeft size={21} />
          </button>
          <button className="chat-title" onClick={() => setInfo(true)}>
            <ConvAvatar label={{ ...conversation, name: title }} members={conversation.members} meId={me.id} size={40} />
            <span className="chat-title-text">
              <strong className="truncate">
                {title}
                {conversation.muted && <BellOff size={13} className="muted" />}
              </strong>
              <span className={cx('chat-sub truncate', typingNames.length && 'typing')}>{subtitle}</span>
            </span>
          </button>
          <span className="spacer" />
          {conversation.type !== 'self' && (
            <>
              <button className="icon-btn" onClick={() => startCall(false)} aria-label="Voice Call" title="Start voice call">
                <Phone size={19} />
              </button>
              <button className="icon-btn" onClick={() => startCall(true)} aria-label="Video Call" title="Start video call">
                <Video size={19} />
              </button>
            </>
          )}
          <button className={cx('icon-btn panel-btn', panel && 'on')} onClick={() => setPanel(panel ? null : 'tasks')} aria-label="Tasks, ideas & goals" title="Tasks, ideas & goals">
            <LayoutPanelLeft size={20} />
            {openTasks > 0 && <span className="badge-dot">{openTasks}</span>}
          </button>
          <button className="icon-btn" onClick={() => setInfo(true)} aria-label="Conversation info" title="Info">
            <Info size={20} />
          </button>
        </header>

        {pinned && (
          <button className="pinned-bar" onClick={() => jumpTo(pinned.id)}>
            <Pin size={14} />
            <span className="truncate">
              <strong>{pinned.user?.name.split(' ')[0]}:</strong> {pinned.body || 'Attachment'}
            </span>
            <span className="link small" onClick={(e) => (e.stopPropagation(), setPanel('pinned'))}>
              All pins
            </span>
          </button>
        )}

        <div className="messages" ref={scroller} onScroll={onScroll}>
          {isLoading ? (
            <Loader />
          ) : (
            <>
              {data?.hasMore ? (
                <div className="load-older">{loadingOlder && <Spinner size={16} />}</div>
              ) : (
                <ChatIntro conversation={conversation} title={title} onAction={(r) => work(r)} />
              )}
              {rows}
              {typingNames.length > 0 && (
                <div className="typing-indicator" aria-live="polite">
                  <span className="dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  {typingNames.join(', ')} typing…
                </div>
              )}
            </>
          )}
        </div>

        {!atBottom && (
          <button className="jump-bottom" onClick={() => scrollToBottom(true)} aria-label="Scroll to latest">
            <ArrowDown size={18} />
            {conversation.unread_count > 0 && <span className="badge-dot">{conversation.unread_count}</span>}
          </button>
        )}

        <Composer
          ref={composer}
          conversation={conversation}
          me={me}
          replyTo={replyTo}
          editing={editing}
          onCancelReply={() => setReplyTo(null)}
          onCancelEdit={() => setEditing(null)}
          onEditMessage={(m) => {
            setReplyTo(null);
            setEditing(m);
          }}
          onSent={() => {
            nearBottom.current = true;
            requestAnimationFrame(() => scrollToBottom());
          }}
        />

        {dragging && (
          <div
            className="drop-zone"
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              composer.current?.addFiles([...e.dataTransfer.files]);
            }}
          >
            <Upload size={32} />
            Drop files to share in {title}
          </div>
        )}
      </section>

      {panel && <HubPanel conversation={conversation} me={me} tab={panel} onTab={setPanel} onClose={() => setPanel(null)} onJump={(id) => (window.innerWidth < 1100 && setPanel(null), jumpTo(id))} />}

      <ConversationInfo open={info} onClose={() => setInfo(false)} conversation={conversation} me={me} />
      <Modal open={Boolean(lightbox)} onClose={() => setLightbox(null)} className="lightbox" width={1100}>
        {lightbox && (
          <>
            <img src={lightbox} alt="" />
            <div className="lightbox-bar">
              <a className="btn btn-sm" href={lightbox} target="_blank" rel="noopener noreferrer">
                Open original
              </a>
              <button className="icon-btn" onClick={() => setLightbox(null)} aria-label="Close">
                <X size={20} />
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

function ChatIntro({ conversation, title, onAction }: { conversation: Conversation; title: string; onAction: (r: Parameters<ReturnType<typeof useWork>>[0]) => void }) {
  const cid = conversation.id;
  return (
    <div className="chat-intro">
      <ConvAvatar label={{ ...conversation, name: title }} members={conversation.members} size={64} />
      <h3>{conversation.type === 'self' ? 'Your private space' : conversation.type === 'direct' ? `This is the start of your chat with ${title}` : `Welcome to ${title}`}</h3>
      <p className="muted">{conversation.description || (conversation.type === 'self' ? 'Jot notes, keep a personal to-do list, track your own goals and get reminders here.' : 'Chat, and turn conversations into tasks, ideas, goals and decisions.')}</p>
      <div className="intro-actions">
        <button className="chip" onClick={() => onAction({ type: 'task', cid })}>
          ✅ Add a task
        </button>
        <button className="chip" onClick={() => onAction({ type: 'idea', cid })}>
          💡 Save an idea
        </button>
        <button className="chip" onClick={() => onAction({ type: 'goal', cid })}>
          🎯 Set a goal
        </button>
        {conversation.type !== 'self' && (
          <button className="chip" onClick={() => onAction({ type: 'checkin', cid })}>
            ☀️ Check in
          </button>
        )}
      </div>
    </div>
  );
}

export function NoChatSelected() {
  return (
    <div className="no-chat">
      <Empty title="Pick a conversation">Or start a new one — direct messages for 1:1s, groups of up to 10 for your team.</Empty>
    </div>
  );
}
