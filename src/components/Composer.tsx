import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, BarChart3, FileText, Lightbulb, ListTodo, Paperclip, Plus, Scale, SendHorizontal, Smile, Sun, Target, X } from 'lucide-react';
import { ApiError, api, uploadFiles } from '../lib/api';
import { cx, fileSize } from '../lib/format';
import { applyMessage, queryClient, type MessagePage } from '../lib/store';
import { sendTyping } from '../lib/socket';
import type { Attachment, Conversation, Message, User } from '../lib/types';
import { Avatar, EmojiGrid, Popover, Spinner } from './ui';
import { useWork, type WorkRequest } from './WorkForms';
import { toastError } from './Toast';

interface Pending {
  key: string;
  file: File;
  progress: number;
  attachment?: Attachment;
  error?: string;
  preview?: string;
}

const COMMANDS: { cmd: string; label: string; hint: string; icon: typeof ListTodo; req: (cid: number, rest: string) => WorkRequest }[] = [
  { cmd: 'task', label: 'Task', hint: 'Create & assign a to-do', icon: ListTodo, req: (cid, rest) => ({ type: 'task', cid, title: rest }) },
  { cmd: 'idea', label: 'Idea', hint: 'Save an idea to vote on', icon: Lightbulb, req: (cid, rest) => ({ type: 'idea', cid, title: rest }) },
  { cmd: 'goal', label: 'Goal', hint: 'Set a measurable target', icon: Target, req: (cid, rest) => ({ type: 'goal', cid, title: rest }) },
  { cmd: 'decision', label: 'Decision', hint: 'Log what you agreed', icon: Scale, req: (cid, rest) => ({ type: 'decision', cid, title: rest }) },
  { cmd: 'poll', label: 'Poll', hint: 'Ask the group to vote', icon: BarChart3, req: (cid, rest) => ({ type: 'poll', cid, question: rest }) },
  { cmd: 'checkin', label: 'Check-in', hint: 'Done / next / blockers', icon: Sun, req: (cid) => ({ type: 'checkin', cid }) },
  { cmd: 'remind', label: 'Reminder', hint: 'Remind me later', icon: AlarmClock, req: (_cid, rest) => ({ type: 'reminder', note: rest }) },
];

export interface ComposerHandle {
  focus: () => void;
  addFiles: (files: File[]) => void;
}

interface Props {
  conversation: Conversation;
  me: User;
  replyTo: Message | null;
  editing: Message | null;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onEditMessage: (m: Message) => void;
  onSent: () => void;
}

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
const draftKey = (cid: number) => `kizuna-draft-${cid}`;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ conversation, me, replyTo, editing, onCancelReply, onCancelEdit, onEditMessage, onSent }, ref) {
  const cid = conversation.id;
  const work = useWork();
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey(cid)) ?? '');
  const [pending, setPending] = useState<Pending[]>([]);
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [plusEl, setPlusEl] = useState<HTMLButtonElement | null>(null);
  const [emojiEl, setEmojiEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState<'plus' | 'emoji' | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), addFiles }));

  useEffect(() => {
    sessionStorage.setItem(draftKey(cid), editing ? '' : text);
  }, [text, cid, editing]);

  useEffect(() => {
    if (editing) {
      setText(editing.body);
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(editing.body.length, editing.body.length);
      });
    }
  }, [editing]);

  useEffect(() => {
    if (replyTo && !isTouch()) input.current?.focus();
  }, [replyTo]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    // Place the caret before the browser handles the next keystroke.
    if (pendingCaret.current !== null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  /* ---------------------------------------------------------- suggestions */
  const before = text.slice(0, caret);
  const mentionMatch = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(before);
  const slashMatch = /^\/(\w*)$/.exec(text);
  const members = conversation.members.filter((m) => m.id !== me.id);
  const mentionOptions = useMemo(() => {
    if (!mentionMatch || conversation.type === 'self') return [];
    const q = mentionMatch[2].toLowerCase();
    return members.filter((m) => m.name.toLowerCase().split(' ').some((p) => p.startsWith(q)) || m.name.toLowerCase().startsWith(q)).slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionMatch?.[2], conversation.members]);
  const slashOptions = slashMatch ? COMMANDS.filter((c) => c.cmd.startsWith(slashMatch[1].toLowerCase())) : [];
  const suggestions = slashOptions.length ? 'slash' : mentionOptions.length ? 'mention' : null;
  const suggestionCount = suggestions === 'slash' ? slashOptions.length : mentionOptions.length;
  useEffect(() => setMenuIndex(0), [suggestions, suggestionCount]);

  const insertMention = (name: string) => {
    const start = before.length - (mentionMatch?.[2].length ?? 0) - 1;
    const next = `${text.slice(0, start)}@${name} ${text.slice(caret)}`;
    pendingCaret.current = start + name.length + 2;
    setText(next);
  };

  const runCommand = (c: (typeof COMMANDS)[number], rest = '') => {
    setText('');
    work(c.req(cid, rest.trim()));
  };

  /* ---------------------------------------------------------------- files */
  function addFiles(files: File[]) {
    if (!files.length) return;
    if (pending.length + files.length > 10) return toastError(new Error('Up to 10 files per message'));
    const items: Pending[] = files.map((file) => ({
      key: `${Date.now()}-${Math.random()}`,
      file,
      progress: 0,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    }));
    setPending((p) => [...p, ...items]);
    for (const item of items) {
      uploadFiles(cid, [item.file], (progress) => setPending((p) => p.map((x) => (x.key === item.key ? { ...x, progress } : x))))
        .then(([attachment]) => setPending((p) => p.map((x) => (x.key === item.key ? { ...x, attachment, progress: 100 } : x))))
        .catch((e: ApiError) => setPending((p) => p.map((x) => (x.key === item.key ? { ...x, error: e.message } : x))));
    }
  }

  const uploading = pending.some((p) => !p.attachment && !p.error);
  const ready = pending.filter((p) => p.attachment);

  /* ----------------------------------------------------------------- send */
  const send = async () => {
    const body = text.trim();
    const command = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(body);
    if (command) {
      const c = COMMANDS.find((x) => x.cmd === command[1].toLowerCase());
      if (c) return runCommand(c, command[2] ?? '');
    }
    if (uploading) return;
    if (!body && !ready.length) return;
    const mentions = conversation.members.filter((m) => m.id !== me.id && body.includes(`@${m.name}`)).map((m) => m.id);

    if (editing) {
      try {
        applyMessage((await api<{ message: Message }>(`/messages/${editing.id}`, { method: 'PATCH', body: { body, mentions } })).message);
        setText(sessionStorage.getItem(draftKey(cid)) ?? '');
        onCancelEdit();
      } catch (e) {
        toastError(e);
      }
      return;
    }

    // Optimistic message so the UI feels instant.
    const temp: Message = {
      id: -Date.now(),
      conversation_id: cid,
      user_id: me.id,
      user: { id: me.id, name: me.name, color: me.color, avatar: me.avatar },
      kind: 'text',
      body,
      ref_id: null,
      meta: null,
      reply_to: replyTo ? { id: replyTo.id, user_id: replyTo.user_id, user_name: replyTo.user?.name ?? null, kind: replyTo.kind, body: replyTo.body, deleted: false } : null,
      reactions: [],
      attachments: ready.map((p) => p.attachment!),
      mentions,
      pinned: false,
      edited: false,
      deleted: false,
      created_at: new Date().toISOString(),
      saved: false,
    };
    queryClient.setQueryData<MessagePage>(['messages', cid], (p) => (p ? { ...p, messages: [...p.messages, temp] } : p));
    setText('');
    setPending([]);
    onCancelReply();
    onSent();
    if (!isTouch()) input.current?.focus();
    try {
      const r = await api<{ message: Message }>(`/conversations/${cid}/messages`, {
        method: 'POST',
        body: { body, reply_to_id: replyTo?.id ?? null, attachment_ids: ready.map((p) => p.attachment!.id), mentions },
      });
      queryClient.setQueryData<MessagePage>(['messages', cid], (p) => (p ? { ...p, messages: p.messages.filter((m) => m.id !== temp.id) } : p));
      applyMessage(r.message, { isNew: true, meId: me.id });
    } catch (e) {
      queryClient.setQueryData<MessagePage>(['messages', cid], (p) => (p ? { ...p, messages: p.messages.filter((m) => m.id !== temp.id) } : p));
      setText(body);
      toastError(e);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestionCount) % suggestionCount);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (suggestions === 'slash') runCommand(slashOptions[menuIndex]);
        else insertMention(mentionOptions[menuIndex].name);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (editing) {
        setText('');
        onCancelEdit();
      } else if (replyTo) onCancelReply();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !isTouch()) {
      e.preventDefault();
      send();
    }
    if (e.key === 'ArrowUp' && !text && !editing) {
      // Edit your last message, Slack-style.
      const page = queryClient.getQueryData<MessagePage>(['messages', cid]);
      const last = [...(page?.messages ?? [])].reverse().find((m) => m.user_id === me.id && m.kind === 'text' && !m.deleted && m.id > 0);
      if (last) {
        e.preventDefault();
        onCancelReply();
        onEditMessage(last);
      }
    }
  };

  const canSend = (text.trim().length > 0 || ready.length > 0) && !uploading;

  return (
    <div className="composer-wrap">
      {suggestions && (
        <div className="suggestions" role="listbox">
          {suggestions === 'slash'
            ? slashOptions.map((c, i) => (
                <button key={c.cmd} className={cx('suggestion', i === menuIndex && 'active')} onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(c)}>
                  <c.icon size={16} />
                  <strong>/{c.cmd}</strong>
                  <span className="muted">{c.hint}</span>
                </button>
              ))
            : mentionOptions.map((m, i) => (
                <button key={m.id} className={cx('suggestion', i === menuIndex && 'active')} onMouseDown={(e) => e.preventDefault()} onClick={() => insertMention(m.name)}>
                  <Avatar user={m} size={22} />
                  <strong>{m.name}</strong>
                  <span className="muted">{m.title}</span>
                </button>
              ))}
        </div>
      )}

      {(replyTo || editing) && (
        <div className="compose-context">
          <div>
            <strong>{editing ? 'Editing message' : `Replying to ${replyTo!.user_id === me.id ? 'yourself' : replyTo!.user?.name}`}</strong>
            <span className="truncate">{(editing ?? replyTo)!.body || 'Attachment'}</span>
          </div>
          <button
            className="icon-btn sm"
            onClick={() => {
              if (editing) {
                setText('');
                onCancelEdit();
              } else onCancelReply();
            }}
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className="pending-files">
          {pending.map((p) => (
            <div key={p.key} className={cx('pending-file', p.error && 'error')}>
              {p.preview ? <img src={p.preview} alt="" /> : <FileText size={22} />}
              <div className="pending-meta">
                <span className="truncate">{p.file.name}</span>
                <span className="muted small">{p.error ?? (p.attachment ? fileSize(p.file.size) : `${p.progress}%`)}</span>
              </div>
              {!p.attachment && !p.error && <span className="pending-bar" style={{ width: `${p.progress}%` }} />}
              <button className="icon-btn sm" onClick={() => setPending((list) => list.filter((x) => x.key !== p.key))} aria-label="Remove file">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="composer">
        <button ref={setPlusEl} className={cx('icon-btn composer-plus', open === 'plus' && 'on')} onClick={() => setOpen(open === 'plus' ? null : 'plus')} aria-label="Add task, idea, file…" title="Add task, idea, poll, file…">
          <Plus size={21} />
        </button>
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={editing ? 'Edit message…' : conversation.type === 'self' ? 'Note to self… (try /task)' : 'Message… (type / for tasks, ideas, polls)'}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            if (e.target.value && conversation.type !== 'self') sendTyping(cid);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          aria-label="Message"
        />
        <button ref={setEmojiEl} className="icon-btn hide-touch" onClick={() => setOpen(open === 'emoji' ? null : 'emoji')} aria-label="Emoji">
          <Smile size={20} />
        </button>
        <button className={cx('send-btn', canSend && 'ready')} onClick={send} disabled={!canSend} aria-label={editing ? 'Save' : 'Send'}>
          {uploading ? <Spinner size={16} /> : <SendHorizontal size={19} />}
        </button>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />

      <Popover anchor={plusEl} open={open === 'plus'} onClose={() => setOpen(null)} placement="top">
        <div className="plus-menu">
          <button
            onClick={() => {
              setOpen(null);
              fileInput.current?.click();
            }}
          >
            <span className="plus-icon file">
              <Paperclip size={18} />
            </span>
            Photo or file
          </button>
          {COMMANDS.filter((c) => conversation.type !== 'self' || !['poll', 'checkin', 'decision'].includes(c.cmd)).map((c) => (
            <button
              key={c.cmd}
              onClick={() => {
                setOpen(null);
                work(c.req(cid, ''));
              }}
            >
              <span className={`plus-icon ${c.cmd}`}>
                <c.icon size={18} />
              </span>
              {c.label}
              <span className="muted small">{c.hint}</span>
            </button>
          ))}
        </div>
      </Popover>
      <Popover anchor={emojiEl} open={open === 'emoji'} onClose={() => setOpen(null)} placement="top" align="end">
        <EmojiGrid
          onPick={(e) => {
            const pos = input.current?.selectionStart ?? text.length;
            pendingCaret.current = pos + e.length;
            setText(text.slice(0, pos) + e + text.slice(pos));
          }}
        />
      </Popover>
    </div>
  );
});

