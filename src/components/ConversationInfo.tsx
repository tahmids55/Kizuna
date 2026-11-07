import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, LogOut, Mail, Search, Send, Shield, UserMinus, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import { conversationTitle, cx, lastSeen, otherMember, plural } from '../lib/format';
import { queryClient, upsertConversation, useOnline, usePresence, useUsers } from '../lib/store';
import type { Conversation, User } from '../lib/types';
import { Avatar, Confirm, ConvAvatar, EmojiGrid, Field, Modal, Popover, Segmented, Spinner, Swatches, Toggle } from './ui';
import { toast, toastError } from './Toast';

const MAX = 10;

export function ConversationInfo({ open, onClose, conversation, me }: { open: boolean; onClose: () => void; conversation: Conversation; me: User }) {
  const navigate = useNavigate();
  const presence = usePresence();
  const admin = ['owner', 'admin'].includes(conversation.role);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [leave, setLeave] = useState(false);
  const other = otherMember(conversation, me.id);
  const otherOnline = useOnline(other?.id);
  const title = conversationTitle(conversation, me.id);

  const settings = async (patch: { muted?: boolean; pinned?: boolean }) => {
    try {
      upsertConversation((await api<{ conversation: Conversation }>(`/conversations/${conversation.id}/settings`, { method: 'PATCH', body: patch })).conversation);
    } catch (e) {
      toastError(e);
    }
  };

  const memberAction = async (method: string, path: string, body?: unknown, msg?: string) => {
    try {
      const r = await api<{ conversation?: Conversation }>(path, { method, body });
      if (r.conversation) upsertConversation(r.conversation);
      else queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (msg) toast(msg);
    } catch (e) {
      toastError(e);
    }
  };

  const doLeave = async () => {
    try {
      await api(`/conversations/${conversation.id}/members/${me.id}`, { method: 'DELETE' });
      queryClient.setQueryData<Conversation[]>(['conversations'], (l) => l?.filter((c) => c.id !== conversation.id));
      onClose();
      navigate('/chats');
      toast(`You left ${title}`);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={conversation.type === 'group' ? 'Group info' : conversation.type === 'self' ? 'My space' : 'Contact'} width={460}>
      <div className="info-hero">
        <ConvAvatar label={{ ...conversation, name: title }} members={conversation.members} meId={me.id} size={76} />
        <h2>{title}</h2>
        {conversation.type === 'direct' && other && (
          <>
            {other.title && <p className="muted">{other.title}</p>}
            <p className={cx('small', otherOnline ? 'online-text' : 'muted')}>{lastSeen(other, otherOnline)}</p>
            {other.status_text && (
              <p className="status-line">
                {other.status_emoji} {other.status_text}
              </p>
            )}
            <a className="btn btn-sm" href={`mailto:${other.email}`}>
              <Mail size={15} /> {other.email}
            </a>
          </>
        )}
        {conversation.type === 'group' && (
          <>
            {conversation.description && <p className="muted center">{conversation.description}</p>}
            <p className="muted small">{plural(conversation.members.length, 'member')} · up to {MAX}</p>
            {admin && (
              <button className="btn btn-sm" onClick={() => setEditing(true)}>
                Edit group
              </button>
            )}
          </>
        )}
      </div>

      <div className="info-settings">
        <Toggle checked={conversation.pinned} onChange={(v) => settings({ pinned: v })} label="Pin to top of chat list" />
        {conversation.type !== 'self' && <Toggle checked={conversation.muted} onChange={(v) => settings({ muted: v })} label="Mute notifications (mentions & tasks still notify)" />}
      </div>

      {conversation.type === 'group' && (
        <div className="info-members">
          <div className="info-members-head">
            <h4>Members</h4>
            {admin && conversation.members.length < MAX && (
              <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
                <UserPlus size={15} /> Add people
              </button>
            )}
          </div>
          {conversation.members.map((m) => (
            <div key={m.id} className="member-row">
              <Avatar user={m} size={38} presence />
              <div className="grow">
                <div className="member-name">
                  {m.name} {m.id === me.id && <span className="muted">(you)</span>}
                  {m.role === 'owner' && <Crown size={13} className="role-icon owner" />}
                  {m.role === 'admin' && <Shield size={13} className="role-icon" />}
                </div>
                <div className="muted small">{m.status_text ? `${m.status_emoji} ${m.status_text}` : m.title || lastSeen(m, presence.has(m.id))}</div>
              </div>
              {admin && m.id !== me.id && m.role !== 'owner' && (
                <MemberMenu
                  isAdmin={m.role === 'admin'}
                  onRole={() =>
                    memberAction('PATCH', `/conversations/${conversation.id}/members/${m.id}`, { role: m.role === 'admin' ? 'member' : 'admin' }, m.role === 'admin' ? `${m.name} is no longer an admin` : `${m.name} is now an admin`)
                  }
                  onRemove={() => memberAction('DELETE', `/conversations/${conversation.id}/members/${m.id}`, undefined, `${m.name} removed`)}
                />
              )}
            </div>
          ))}
          <button className="btn btn-danger-ghost full" onClick={() => setLeave(true)}>
            <LogOut size={16} /> Leave group
          </button>
        </div>
      )}

      {editing && <EditGroup conversation={conversation} onClose={() => setEditing(false)} />}
      {adding && <AddPeople conversation={conversation} onClose={() => setAdding(false)} />}
      <Confirm open={leave} title={`Leave ${title}?`} message="You’ll stop receiving messages. An admin can add you back later." confirm="Leave" onConfirm={doLeave} onClose={() => setLeave(false)} />
    </Modal>
  );
}

function MemberMenu({ isAdmin, onRole, onRemove }: { isAdmin: boolean; onRole: () => void; onRemove: () => void }) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={setEl} className="btn btn-ghost btn-xs" onClick={() => setOpen((o) => !o)}>
        Manage
      </button>
      <Popover anchor={el} open={open} onClose={() => setOpen(false)} align="end">
        <div className="menu">
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onRole();
            }}
          >
            <Shield size={16} /> {isAdmin ? 'Remove admin' : 'Make admin'}
          </button>
          <button
            className="menu-item danger"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            <UserMinus size={16} /> Remove from group
          </button>
        </div>
      </Popover>
    </>
  );
}

function EditGroup({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const [name, setName] = useState(conversation.name);
  const [description, setDescription] = useState(conversation.description);
  const [emoji, setEmoji] = useState(conversation.emoji);
  const [color, setColor] = useState(conversation.color);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      upsertConversation((await api<{ conversation: Conversation }>(`/conversations/${conversation.id}`, { method: 'PATCH', body: { name, description, emoji, color } })).conversation);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit group"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!name.trim() || busy}>
            {busy ? <Spinner size={15} /> : 'Save'}
          </button>
        </>
      }
    >
      <div className="form">
        <GroupIdentity name={name} setName={setName} emoji={emoji} setEmoji={setEmoji} color={color} setColor={setColor} />
        <Field label="Description">
          <textarea className="input" rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function GroupIdentity({ name, setName, emoji, setEmoji, color, setColor }: { name: string; setName: (s: string) => void; emoji: string; setEmoji: (s: string) => void; color: string; setColor: (s: string) => void }) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="group-identity">
        <button type="button" ref={setEl} className="emoji-pick" style={{ background: color }} onClick={() => setOpen(true)} aria-label="Choose emoji">
          {emoji || '💬'}
        </button>
        <input className="input input-lg" placeholder="Group name, e.g. Founders" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <Swatches value={color} onChange={setColor} />
      <Popover anchor={el} open={open} onClose={() => setOpen(false)}>
        <EmojiGrid
          onPick={(e) => {
            setEmoji(e);
            setOpen(false);
          }}
        />
      </Popover>
    </>
  );
}

/** Select people from the directory, respecting a maximum. */
export function PeopleSelect({ selected, onChange, exclude = [], max }: { selected: number[]; onChange: (ids: number[]) => void; exclude?: number[]; max: number }) {
  const { data: users } = useUsers();
  const [q, setQ] = useState('');
  const list = (users ?? []).filter((u) => !exclude.includes(u.id) && `${u.name} ${u.email} ${u.title}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : selected.length < max ? [...selected, id] : selected);
  return (
    <div className="people-select">
      <div className="search-box">
        <Search size={16} />
        <input placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="people-list">
        {list.map((u) => {
          const on = selected.includes(u.id);
          return (
            <button key={u.id} type="button" className={cx('person-row', on && 'on')} onClick={() => toggle(u.id)} disabled={!on && selected.length >= max}>
              <Avatar user={u} size={36} presence />
              <span className="grow">
                <strong>{u.name}</strong>
                <span className="muted small">{u.title || u.email}</span>
              </span>
              <span className={cx('checkbox', on && 'on')} />
            </button>
          );
        })}
        {!list.length && <p className="muted small center">{users?.length ? 'No matches' : 'Nobody else has joined yet — invite your team to sign up.'}</p>}
      </div>
    </div>
  );
}

function AddPeople({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const [ids, setIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const left = MAX - conversation.members.length;
  useEffect(() => setIds([]), [conversation.id]);
  const add = async () => {
    setBusy(true);
    try {
      upsertConversation((await api<{ conversation: Conversation }>(`/conversations/${conversation.id}/members`, { method: 'POST', body: { user_ids: ids } })).conversation);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Add people (${left} spot${left === 1 ? '' : 's'} left)`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={add} disabled={!ids.length || busy}>
            {busy ? <Spinner size={15} /> : `Add ${ids.length || ''}`}
          </button>
        </>
      }
    >
      <PeopleSelect selected={ids} onChange={setIds} exclude={conversation.members.map((m) => m.id)} max={left} />
    </Modal>
  );
}

export function NewChat({ open, onClose, me }: { open: boolean; onClose: () => void; me: User }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [ids, setIds] = useState<number[]>([]);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🚀');
  const [color, setColor] = useState('#0d9488');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setIds([]);
      setName('');
      setMode('direct');
    }
  }, [open]);

  const go = (c: Conversation) => {
    upsertConversation(c);
    onClose();
    navigate(`/chats/${c.id}`);
  };
  const startDirect = async (userId: number) => {
    try {
      go((await api<{ conversation: Conversation }>('/conversations/direct', { method: 'POST', body: { user_id: userId } })).conversation);
    } catch (e) {
      toastError(e);
    }
  };
  const createGroup = async () => {
    setBusy(true);
    try {
      go((await api<{ conversation: Conversation }>('/conversations/group', { method: 'POST', body: { name, emoji, color, member_ids: ids } })).conversation);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New conversation"
      width={480}
      footer={
        mode === 'group' && (
          <>
            <span className="muted small">{ids.length + 1}/10 members</span>
            <span className="spacer" />
            <button className="btn btn-primary" onClick={createGroup} disabled={!name.trim() || busy}>
              {busy ? <Spinner size={15} /> : 'Create group'}
            </button>
          </>
        )
      }
    >
      <div className="form">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'direct', label: 'Direct message' }, { value: 'group', label: 'New group' }]} className="wide" />
        {mode === 'direct' ? (
          <DirectPicker meId={me.id} onPick={startDirect} onClose={onClose} />
        ) : (
          <>
            <GroupIdentity name={name} setName={setName} emoji={emoji} setEmoji={setEmoji} color={color} setColor={setColor} />
            <PeopleSelect selected={ids} onChange={setIds} exclude={[me.id]} max={9} />
          </>
        )}
      </div>
    </Modal>
  );
}

function DirectPicker({ meId, onPick, onClose }: { meId: number; onPick: (id: number) => void; onClose: () => void }) {
  const { data: users } = useUsers();
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{
    user: User | null;
    status: 'none' | 'pending_outgoing' | 'pending_incoming' | 'accepted' | 'rejected_by_them' | 'rejected_by_you' | 'self' | 'not_found';
    request?: { id: number } | null;
  } | null>(null);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = email.trim().toLowerCase();
    if (!target) return;
    setSearching(true);
    setResult(null);
    try {
      const res = await api<{
        user: User | null;
        status: 'none' | 'pending_outgoing' | 'pending_incoming' | 'accepted' | 'rejected_by_them' | 'rejected_by_you' | 'self' | 'not_found';
        request?: { id: number } | null;
      }>(`/requests/lookup?email=${encodeURIComponent(target)}`);
      setResult(res);
    } catch (err) {
      toastError(err);
    } finally {
      setSearching(false);
    }
  };

  const sendRequest = async () => {
    if (!email.trim()) return;
    setSending(true);
    try {
      const res = await api<{ request: { id: number; recipient_id: number; sender_id: number }; status: string; conversation?: Conversation }>('/requests', {
        method: 'POST',
        body: { email: email.trim(), note },
      });
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      if (res.conversation) {
        toast('Connected! Direct chat opened.');
        onPick(res.request.recipient_id === meId ? res.request.sender_id : res.request.recipient_id);
      } else {
        toast('Message request sent! They will see it in their requests.');
        setResult({ user: result?.user ?? null, status: 'pending_outgoing', request: res.request });
      }
    } catch (err) {
      toastError(err);
    } finally {
      setSending(false);
    }
  };

  const acceptIncoming = async (rid: number) => {
    setSending(true);
    try {
      const res = await api<{ conversation: Conversation }>(`/requests/${rid}/accept`, { method: 'POST' });
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      upsertConversation(res.conversation);
      toast('Request accepted!');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="direct-picker">
      <form onSubmit={lookup} className="email-lookup-form">
        <label className="field-label">Find person by complete email address</label>
        <div className="search-input-group">
          <input
            type="email"
            className="input"
            autoFocus
            placeholder="e.g. colleague@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!email.trim() || searching}>
            {searching ? <Spinner size={14} /> : <Search size={14} />} Find
          </button>
        </div>
      </form>

      {result && (
        <div className="lookup-result">
          {result.status === 'not_found' || !result.user ? (
            <div className="alert-box muted small">
              No user found with that exact email address. Please make sure the email is spelled correctly.
            </div>
          ) : result.status === 'self' ? (
            <div className="alert-box muted small">
              That’s your own email address. Use “My space” for notes to yourself.
            </div>
          ) : (
            <div className="lookup-user-card">
              <div className="lookup-user-info">
                <Avatar user={result.user} size={42} />
                <div className="grow">
                  <strong>{result.user.name}</strong>
                  <div className="small muted">{result.user.email}</div>
                  {result.user.title && <div className="small muted">{result.user.title}</div>}
                </div>
              </div>

              {result.status === 'accepted' ? (
                <div className="lookup-action-row">
                  <span className="small text-success">Already connected</span>
                  <button className="btn btn-primary btn-sm" onClick={() => onPick(result.user!.id)}>
                    Open Chat
                  </button>
                </div>
              ) : result.status === 'pending_incoming' && result.request ? (
                <div className="lookup-action-row">
                  <span className="small text-primary">They sent you a message request!</span>
                  <button className="btn btn-primary btn-sm" onClick={() => acceptIncoming(result.request!.id)} disabled={sending}>
                    {sending ? <Spinner size={14} /> : 'Accept Request'}
                  </button>
                </div>
              ) : result.status === 'pending_outgoing' ? (
                <div className="alert-box muted small">
                  Message request pending. Waiting for them to accept.
                </div>
              ) : result.status === 'rejected_by_them' ? (
                <div className="alert-box danger small">
                  This user declined your previous request. You cannot message them unless they send a request to you.
                </div>
              ) : (
                <div className="send-request-form">
                  <input
                    className="input input-sm"
                    placeholder="Add an optional note (e.g. Hi, let’s build together!)"
                    maxLength={300}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <button className="btn btn-primary btn-sm full mt-2" onClick={sendRequest} disabled={sending}>
                    {sending ? <Spinner size={14} /> : <Send size={14} />} Send Message Request
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {users && users.length > 0 && (
        <div className="connected-contacts mt-4">
          <h4 className="small muted-label mb-2">Connected teammates</h4>
          <div className="people-list">
            {users.map((u) => (
              <button key={u.id} className="person-row" onClick={() => onPick(u.id)}>
                <Avatar user={u} size={36} presence />
                <span className="grow">
                  <strong>{u.name}</strong>
                  <span className="muted small">{u.title || u.email}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
