import { memo, useState, type ReactNode } from 'react';
import {
  AlarmClock,
  Bookmark,
  BookmarkCheck,
  Check,
  CheckCheck,
  Clock3,
  Copy,
  Download,
  Ellipsis,
  FileText,
  Lightbulb,
  ListTodo,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Scale,
  SmilePlus,
  Trash2,
} from 'lucide-react';
import { api, fileUrl } from '../lib/api';
import { RichText, clock, cx, fileSize, fullTime, isJumboEmoji } from '../lib/format';
import { applyMessage } from '../lib/store';
import type { Conversation, Hub, Message as Msg, User } from '../lib/types';
import { CheckinCard, DecisionCard, GoalCard, IdeaCard, Missing, PollCard, TaskCard } from './Cards';
import { Avatar, EmojiGrid, MenuList, Modal, Popover, QUICK_REACTIONS, useLongPress, type MenuAction } from './ui';
import { useWork } from './WorkForms';
import { toast, toastError } from './Toast';

export interface MessageProps {
  message: Msg;
  conversation: Conversation;
  me: User;
  hub?: Hub;
  grouped: boolean;
  showSeen: boolean;
  highlight: boolean;
  onReply: (m: Msg) => void;
  onEdit: (m: Msg) => void;
  onJump: (id: number) => void;
  onImage: (url: string) => void;
}

export async function react(m: Msg, emoji: string, meId: number) {
  // Optimistic toggle.
  const has = m.reactions.find((r) => r.emoji === emoji)?.user_ids.includes(meId);
  const reactions = has
    ? m.reactions.map((r) => (r.emoji === emoji ? { ...r, user_ids: r.user_ids.filter((u) => u !== meId) } : r)).filter((r) => r.user_ids.length)
    : m.reactions.some((r) => r.emoji === emoji)
      ? m.reactions.map((r) => (r.emoji === emoji ? { ...r, user_ids: [...r.user_ids, meId] } : r))
      : [...m.reactions, { emoji, user_ids: [meId] }];
  applyMessage({ ...m, reactions });
  try {
    applyMessage((await api<{ message: Msg }>(`/messages/${m.id}/reactions`, { method: 'POST', body: { emoji } })).message);
  } catch (e) {
    applyMessage(m);
    toastError(e);
  }
}

export const MessageItem = memo(function MessageItem(props: MessageProps) {
  const { message: m, conversation, me, grouped } = props;
  const [sheet, setSheet] = useState(false);
  const longPress = useLongPress(() => !m.deleted && m.id > 0 && setSheet(true));

  if (m.kind === 'system') {
    return (
      <div className="msg-system" id={`m-${m.id}`}>
        <span>{m.body}</span>
        <time>{clock(m.created_at)}</time>
      </div>
    );
  }

  const mine = m.user_id === me.id;
  const isGroup = conversation.type === 'group';
  const showAuthor = !mine && isGroup && !grouped;
  const card = m.kind !== 'text';
  const names = conversation.members.map((x) => x.name);

  let content: ReactNode;
  if (m.deleted) content = <div className="bubble deleted">This message was deleted</div>;
  else if (card) content = <CardFor {...props} />;
  else content = <Bubble {...props} mine={mine} names={names} />;

  return (
    <div className={cx('msg-row', mine && 'mine', grouped && 'grouped', card && 'has-card', props.highlight && 'flash')} id={`m-${m.id}`}>
      {!mine && isGroup && <div className="msg-avatar">{!grouped && <Avatar user={m.user} size={32} />}</div>}
      <div className="msg-col">
        {showAuthor && (
          <div className="msg-author" style={{ color: m.user?.color }}>
            {m.user?.name}
          </div>
        )}
        <div className="msg-main" {...longPress} onContextMenu={(e) => window.matchMedia('(pointer: coarse)').matches && e.preventDefault()}>
          {content}
          {!m.deleted && m.id > 0 && <HoverActions {...props} mine={mine} openSheet={() => setSheet(true)} />}
        </div>
        {card && !m.deleted && (
          <div className="card-time">
            {m.pinned && <Pin size={11} />}
            {clock(m.created_at)}
          </div>
        )}
        {m.reactions.length > 0 && <Reactions message={m} meId={me.id} members={conversation.members} />}
        {props.showSeen && <SeenBy message={m} conversation={conversation} meId={me.id} />}
      </div>
      {sheet && <ActionSheet {...props} mine={mine} onClose={() => setSheet(false)} />}
    </div>
  );
});

function Bubble({ message: m, me, mine, names, onJump, onImage, conversation }: MessageProps & { mine: boolean; names: string[] }) {
  const images = m.attachments.filter((a) => a.mime.startsWith('image/'));
  const files = m.attachments.filter((a) => !a.mime.startsWith('image/'));
  const jumbo = m.body && !m.attachments.length && !m.reply_to && isJumboEmoji(m.body);
  const everyoneRead = conversation.members.filter((x) => x.id !== me.id).every((x) => x.last_read_id >= m.id);
  return (
    <div className={cx('bubble', jumbo && 'jumbo', images.length > 0 && !m.body && 'media-only')}>
      {m.reply_to && (
        <button className="reply-quote" onClick={() => onJump(m.reply_to!.id)}>
          <strong>{m.reply_to.user_id === me.id ? 'You' : m.reply_to.user_name}</strong>
          <span>{m.reply_to.deleted ? 'Deleted message' : m.reply_to.body || 'Attachment'}</span>
        </button>
      )}
      {images.length > 0 && (
        <div className={cx('media-grid', `n${Math.min(images.length, 4)}`)}>
          {images.slice(0, 4).map((a, i) => (
            <button key={a.id} className="media" onClick={() => onImage(fileUrl(a.url))}>
              <img src={fileUrl(a.url)} alt={a.filename} loading="lazy" />
              {i === 3 && images.length > 4 && <span className="media-more">+{images.length - 4}</span>}
            </button>
          ))}
        </div>
      )}
      {files.map((a) => (
        <a key={a.id} className="file-chip" href={fileUrl(a.url)} target="_blank" rel="noopener noreferrer" download={a.filename}>
          <span className="file-icon">
            <FileText size={18} />
          </span>
          <span className="file-meta">
            <span className="file-name">{a.filename}</span>
            <span className="file-size">{fileSize(a.size)}</span>
          </span>
          <Download size={16} className="muted" />
        </a>
      ))}
      {m.body && (
        <div className="bubble-text">
          <RichText text={m.body} names={names} meName={me.name} />
        </div>
      )}
      <span className="bubble-meta" title={fullTime(m.created_at)}>
        {m.pinned && <Pin size={11} />}
        {m.edited && 'edited · '}
        {clock(m.created_at)}
        {mine && (m.id < 0 ? <Clock3 size={13} /> : everyoneRead ? <CheckCheck size={14} className="read" /> : conversation.type === 'self' ? null : <Check size={14} />)}
      </span>
    </div>
  );
}

function CardFor({ message: m, hub, conversation, me }: MessageProps) {
  if (m.kind === 'checkin') return <CheckinCard message={m} />;
  if (!hub) return <div className="card card-missing">Loading…</div>;
  const members = conversation.members;
  switch (m.kind) {
    case 'task': {
      const t = hub.tasks.find((x) => x.id === m.ref_id);
      return t ? <TaskCard task={t} members={members} meId={me.id} /> : <Missing what="task" />;
    }
    case 'idea': {
      const i = hub.ideas.find((x) => x.id === m.ref_id);
      return i ? <IdeaCard idea={i} members={members} meId={me.id} /> : <Missing what="idea" />;
    }
    case 'goal': {
      const g = hub.goals.find((x) => x.id === m.ref_id);
      return g ? <GoalCard goal={g} members={members} /> : <Missing what="goal" />;
    }
    case 'decision': {
      const d = hub.decisions.find((x) => x.id === m.ref_id);
      return d ? <DecisionCard decision={d} members={members} meId={me.id} /> : <Missing what="decision" />;
    }
    case 'poll': {
      const p = hub.polls.find((x) => x.id === m.ref_id);
      return p ? <PollCard poll={p} members={members} meId={me.id} /> : <Missing what="poll" />;
    }
    default:
      return null;
  }
}

function Reactions({ message, meId, members }: { message: Msg; meId: number; members: Conversation['members'] }) {
  return (
    <div className="reactions">
      {message.reactions.map((r) => (
        <button
          key={r.emoji}
          className={cx('reaction', r.user_ids.includes(meId) && 'mine')}
          onClick={() => react(message, r.emoji, meId)}
          title={r.user_ids.map((id) => (id === meId ? 'You' : members.find((x) => x.id === id)?.name ?? 'Someone')).join(', ')}
        >
          {r.emoji}
          {r.user_ids.length > 1 && <span>{r.user_ids.length}</span>}
        </button>
      ))}
    </div>
  );
}

function SeenBy({ message, conversation, meId }: { message: Msg; conversation: Conversation; meId: number }) {
  const seen = conversation.members.filter((x) => x.id !== meId && x.last_read_id >= message.id);
  if (!seen.length || conversation.type === 'self') return null;
  if (conversation.type === 'direct') return <div className="seen-by">Seen</div>;
  return (
    <div className="seen-by" title={`Seen by ${seen.map((s) => s.name).join(', ')}`}>
      Seen by
      {seen.slice(0, 6).map((s) => (
        <Avatar key={s.id} user={s} size={14} />
      ))}
      {seen.length > 6 && `+${seen.length - 6}`}
    </div>
  );
}

/* ------------------------------------------------------------------ actions */

function useActions({ message: m, conversation, onReply, onEdit, mine }: MessageProps & { mine: boolean }): MenuAction[] {
  const work = useWork();
  const admin = ['owner', 'admin'].includes(conversation.role);
  const text = m.body;
  const cid = conversation.id;
  const call = async (method: string, path: string, done: string) => {
    try {
      applyMessage((await api<{ message: Msg }>(path, { method })).message);
      toast(done);
    } catch (e) {
      toastError(e);
    }
  };
  const isText = m.kind === 'text';
  return [
    { label: 'Reply', icon: <Reply size={16} />, onSelect: () => onReply(m) },
    { label: 'Make it a task', icon: <ListTodo size={16} />, onSelect: () => work({ type: 'task', cid, title: text.slice(0, 200), source: m.id }), hidden: !isText },
    { label: 'Save as idea', icon: <Lightbulb size={16} />, onSelect: () => work({ type: 'idea', cid, title: text.slice(0, 200), source: m.id }), hidden: !isText },
    { label: 'Record as decision', icon: <Scale size={16} />, onSelect: () => work({ type: 'decision', cid, title: text.slice(0, 300), source: m.id }), hidden: !isText || conversation.type === 'self' },
    { label: 'Remind me', icon: <AlarmClock size={16} />, onSelect: () => work({ type: 'reminder', messageId: m.id }) },
    m.pinned
      ? { label: 'Unpin', icon: <PinOff size={16} />, onSelect: () => call('DELETE', `/messages/${m.id}/pin`, 'Unpinned') }
      : { label: 'Pin to chat', icon: <Pin size={16} />, onSelect: () => call('POST', `/messages/${m.id}/pin`, 'Pinned 📌') },
    m.saved
      ? { label: 'Remove from saved', icon: <BookmarkCheck size={16} />, onSelect: () => call('DELETE', `/messages/${m.id}/save`, 'Removed from saved') }
      : { label: 'Save for later', icon: <Bookmark size={16} />, onSelect: () => call('POST', `/messages/${m.id}/save`, 'Saved 🔖') },
    { label: 'Copy text', icon: <Copy size={16} />, onSelect: () => navigator.clipboard?.writeText(text).then(() => toast('Copied')), hidden: !text },
    { label: 'Edit', icon: <Pencil size={16} />, onSelect: () => onEdit(m), hidden: !mine || !isText },
    {
      label: 'Delete',
      icon: <Trash2 size={16} />,
      danger: true,
      hidden: !(mine || admin) || !['text', 'checkin'].includes(m.kind),
      onSelect: async () => {
        if (!confirm('Delete this message for everyone?')) return;
        try {
          await api(`/messages/${m.id}`, { method: 'DELETE' });
          applyMessage({ ...m, deleted: true, body: '', attachments: [], reactions: [] });
        } catch (e) {
          toastError(e);
        }
      },
    },
  ];
}

function HoverActions(props: MessageProps & { mine: boolean; openSheet: () => void }) {
  const actions = useActions(props);
  const [emojiEl, setEmojiEl] = useState<HTMLButtonElement | null>(null);
  const [moreEl, setMoreEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState<'emoji' | 'more' | null>(null);
  const close = () => setOpen(null);
  return (
    <div className={cx('hover-actions', open && 'open')}>
      <button ref={setEmojiEl} className="icon-btn sm" onClick={() => setOpen(open === 'emoji' ? null : 'emoji')} aria-label="React" title="React">
        <SmilePlus size={16} />
      </button>
      <button className="icon-btn sm" onClick={() => props.onReply(props.message)} aria-label="Reply" title="Reply">
        <Reply size={16} />
      </button>
      <button ref={setMoreEl} className="icon-btn sm" onClick={() => setOpen(open === 'more' ? null : 'more')} aria-label="More actions" title="More">
        <Ellipsis size={16} />
      </button>
      <Popover anchor={emojiEl} open={open === 'emoji'} onClose={close} align={props.mine ? 'end' : 'start'} placement="top">
        <div className="quick-reactions">
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              onClick={() => {
                close();
                react(props.message, e, props.me.id);
              }}
            >
              {e}
            </button>
          ))}
        </div>
        <EmojiGrid
          onPick={(e) => {
            close();
            react(props.message, e, props.me.id);
          }}
        />
      </Popover>
      <Popover anchor={moreEl} open={open === 'more'} onClose={close} align={props.mine ? 'end' : 'start'}>
        <MenuList items={actions} close={close} />
      </Popover>
    </div>
  );
}

function ActionSheet(props: MessageProps & { mine: boolean; onClose: () => void }) {
  const actions = useActions(props).filter((a) => !a.hidden);
  const [allEmoji, setAllEmoji] = useState(false);
  const pick = (e: string) => {
    props.onClose();
    react(props.message, e, props.me.id);
  };
  return (
    <Modal open onClose={props.onClose} className="action-sheet">
      <div className="quick-reactions big">
        {QUICK_REACTIONS.slice(0, 7).map((e) => (
          <button key={e} onClick={() => pick(e)}>
            {e}
          </button>
        ))}
        <button onClick={() => setAllEmoji((v) => !v)} aria-label="More emoji">
          <SmilePlus size={22} />
        </button>
      </div>
      {allEmoji && <EmojiGrid onPick={pick} />}
      <div className="sheet-actions">
        {actions.map((a) => (
          <button
            key={a.label}
            className={cx('sheet-action', a.danger && 'danger')}
            onClick={() => {
              props.onClose();
              a.onSelect();
            }}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}
