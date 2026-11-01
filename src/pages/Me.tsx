import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Camera, LogOut, Monitor, Moon, Server, Sun } from 'lucide-react';
import { api, isNative, serverUrl, setToken, uploadAvatar } from '../lib/api';
import { cx } from '../lib/format';
import { disconnectRealtime } from '../lib/socket';
import { notificationPermission, requestNotifications, syncStatusBar, type NotifyPermission } from '../lib/platform';
import { applyUser, queryClient, useMe } from '../lib/store';
import type { User } from '../lib/types';
import { Avatar, Field, Segmented, Spinner, Swatches, Toggle } from '../components/ui';
import { toast, toastError } from '../components/Toast';

const STATUS_PRESETS: [string, string][] = [
  ['🎯', 'Focusing'],
  ['🤝', 'In a meeting'],
  ['✈️', 'Travelling'],
  ['🌴', 'On leave'],
  ['🤒', 'Out sick'],
  ['🏠', 'Working remotely'],
];

type Theme = 'light' | 'dark' | 'system';
export function applyTheme(t: Theme) {
  localStorage.setItem('kizuna-theme', t);
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  syncStatusBar();
}

export function MePage() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [color, setColor] = useState('');
  const [emoji, setEmoji] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('kizuna-theme') as Theme) || 'system');
  const [perm, setPerm] = useState<NotifyPermission>('default');
  const [notifyOn, setNotifyOn] = useState(localStorage.getItem('kizuna-notify') !== 'off');
  const [pw, setPw] = useState({ current: '', next: '' });
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!me) return;
    setName(me.name);
    setTitle(me.title);
    setColor(me.color);
    setEmoji(me.status_emoji);
    setStatus(me.status_text);
  }, [me]);
  useEffect(() => {
    notificationPermission().then(setPerm);
  }, []);
  if (!me) return null;

  const save = async (patch: Partial<User> & Record<string, unknown>, msg = 'Saved') => {
    setBusy(true);
    try {
      const { user } = await api<{ user: User }>('/me', { method: 'PATCH', body: patch });
      applyUser(user);
      toast(msg);
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onAvatar = async (f?: File) => {
    if (!f) return;
    setUploading(true);
    try {
      await save({ avatar: await uploadAvatar(f) }, 'Photo updated');
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(false);
    }
  };

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    disconnectRealtime();
    setToken(null);
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  const dirty = name !== me.name || title !== me.title || color !== me.color;

  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>Profile</h1>
      </header>

      <section className="panel profile-card">
        <div className="profile-top">
          <button className="avatar-upload" onClick={() => file.current?.click()} aria-label="Change photo">
            <Avatar user={{ ...me, color }} size={84} />
            <span className="avatar-cam">{uploading ? <Spinner size={14} /> : <Camera size={15} />}</span>
          </button>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => onAvatar(e.target.files?.[0])} />
          <div>
            <h2>{me.name}</h2>
            <p className="muted">{me.email}</p>
            {me.avatar && (
              <button className="link small" onClick={() => save({ avatar: null }, 'Photo removed')}>
                Remove photo
              </button>
            )}
          </div>
        </div>
        <div className="form">
          <div className="form-row">
            <Field label="Name">
              <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Role">
              <input className="input" maxLength={80} placeholder="e.g. CEO & Co-founder" value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          <Field label="Colour">
            <Swatches value={color} onChange={setColor} />
          </Field>
          <div className="row-end">
            <button className="btn btn-primary" disabled={!dirty || !name.trim() || busy} onClick={() => save({ name, title, color })}>
              Save profile
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title">Status</h3>
        <p className="muted small">Let your team know what you’re up to. It shows next to your name.</p>
        <div className="status-presets">
          {STATUS_PRESETS.map(([e, t]) => (
            <button
              key={t}
              className={cx('chip', status === t && 'on')}
              onClick={() => {
                setEmoji(e);
                setStatus(t);
                save({ status_emoji: e, status_text: t }, 'Status updated');
              }}
            >
              {e} {t}
            </button>
          ))}
        </div>
        <div className="status-edit">
          <input className="input emoji-input" maxLength={4} value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🙂" aria-label="Status emoji" />
          <input className="input" maxLength={100} value={status} onChange={(e) => setStatus(e.target.value)} placeholder="What’s your status?" aria-label="Status text" />
          <button className="btn" onClick={() => save({ status_emoji: emoji, status_text: status }, 'Status updated')} disabled={busy}>
            Set
          </button>
          {(me.status_text || me.status_emoji) && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                setEmoji('');
                setStatus('');
                save({ status_emoji: '', status_text: '' }, 'Status cleared');
              }}
            >
              Clear
            </button>
          )}
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title">Appearance & notifications</h3>
        <Field label="Theme">
          <Segmented
            value={theme}
            onChange={(t) => {
              setTheme(t);
              applyTheme(t);
            }}
            options={[
              { value: 'light', label: <><Sun size={14} /> Light</> },
              { value: 'dark', label: <><Moon size={14} /> Dark</> },
              { value: 'system', label: <><Monitor size={14} /> System</> },
            ]}
            className="wide"
          />
        </Field>
        <div className="notify-block">
          <Toggle
            checked={notifyOn && perm === 'granted'}
            onChange={async (v) => {
              if (v && perm !== 'granted') {
                const p = await requestNotifications();
                setPerm(p);
                if (p !== 'granted') return toast('Notifications are blocked — allow them in your browser or phone settings.', 'error');
              }
              localStorage.setItem('kizuna-notify', v ? 'on' : 'off');
              setNotifyOn(v);
            }}
            label={
              <>
                <Bell size={15} /> Notifications for new messages, mentions, tasks & reminders
              </>
            }
          />
          {perm === 'unsupported' && <p className="muted small">This browser doesn’t support notifications.</p>}
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title">Password</h3>
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await save({ current_password: pw.current, new_password: pw.next }, 'Password changed — other devices were signed out')) setPw({ current: '', next: '' });
          }}
        >
          <input type="email" value={me.email} autoComplete="username" readOnly hidden />
          <div className="form-row">
            <Field label="Current password">
              <input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            </Field>
            <Field label="New password" hint="At least 8 characters">
              <input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </Field>
          </div>
          <div className="row-end">
            <button className="btn" disabled={!pw.current || pw.next.length < 8 || busy}>
              Change password
            </button>
          </div>
        </form>
      </section>

      {isNative && (
        <section className="panel">
          <h3 className="panel-title">
            <Server size={16} /> Server
          </h3>
          <p className="muted small">Connected to {serverUrl()}. To switch servers, sign out.</p>
        </section>
      )}

      <button className="btn btn-danger-ghost full" onClick={logout}>
        <LogOut size={16} /> Sign out
      </button>
      <p className="muted small center">Kizuna 1.0 · 絆 — the bonds between people</p>
    </div>
  );
}
