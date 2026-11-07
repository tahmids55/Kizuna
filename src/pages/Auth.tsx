import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { api, isNative, serverUrl, setToken } from '../lib/api';
import { queryClient } from '../lib/store';
import type { User } from '../lib/types';
import { Field, Logo, Spinner } from '../components/ui';

interface Meta {
  inviteRequired: boolean;
  demo: boolean;
}

function useMeta(server: string) {
  return useQuery({
    queryKey: ['meta', server],
    queryFn: () => api<Meta>('/meta'),
    enabled: !isNative || Boolean(server),
    retry: false,
    staleTime: 60_000,
  });
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-art">
        <div className="auth-brand">
          <Logo size={40} />
          <span>Kizuna</span>
        </div>
        <div className="auth-pitch">
          <h1>
            Where co-founders
            <br />
            <em>build together.</em>
          </h1>
          <p>Chat that remembers what matters. Turn any message into a task, idea, goal or decision — and never lose a commitment in the scroll again.</p>
          <ul>
            <li>
              <CheckCircle2 size={18} /> Direct messages & groups of up to 10
            </li>
            <li>
              <CheckCircle2 size={18} /> Assign tasks to each other right in the chat
            </li>
            <li>
              <CheckCircle2 size={18} /> Ideas, goals, decisions, polls & check-ins
            </li>
            <li>
              <CheckCircle2 size={18} /> Web app + Android app, live in real time
            </li>
          </ul>
        </div>
        <span className="auth-kanji">絆</span>
      </div>
      <div className="auth-main">
        <div className="auth-card">
          <div className="auth-mobile-logo">
            <Logo size={52} />
          </div>
          <h2>{title}</h2>
          <p className="muted">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function useAuth(path: string) {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (body: Record<string, string>) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string; user: User }>(path, { method: 'POST', body });
      setToken(r.token);
      queryClient.clear();
      queryClient.setQueryData(['me'], r.user);
      navigate('/chats', { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { data: meta } = useMeta(serverUrl());
  const { submit, error, busy } = useAuth('/auth/login');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit({ email, password });
  };
  return (
    <Shell title="Welcome back" subtitle="Sign in to your team’s workspace.">
      <form className="auth-form" onSubmit={onSubmit}>
        <Field label="Email">
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? <Spinner size={16} /> : <>Sign in <ArrowRight size={17} /></>}
        </button>
        {meta?.demo && (
          <button type="button" className="btn btn-lg" disabled={busy} onClick={() => submit({ email: 'demo@kizuna.app', password: 'demo1234' })}>
            Try the demo team
          </button>
        )}
      </form>
      <p className="auth-switch">
        New here? <Link to="/register">Create an account</Link>
      </p>
    </Shell>
  );
}

export function RegisterPage() {
  const [form, setForm] = useState({ name: '', title: '', email: '', password: '', invite_code: '' });
  const { data: meta } = useMeta(serverUrl());
  const { submit, error, busy } = useAuth('/auth/register');
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Shell title="Create your account" subtitle="Join your co-founders in under a minute.">
      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(form);
        }}
      >
        <div className="form-row">
          <Field label="Full name">
            <input className="input" autoComplete="name" required maxLength={80} value={form.name} onChange={set('name')} />
          </Field>
          <Field label="Role (optional)">
            <input className="input" placeholder="CTO & Co-founder" maxLength={80} value={form.title} onChange={set('title')} />
          </Field>
        </div>
        <Field label="Email">
          <input className="input" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <input className="input" type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set('password')} />
        </Field>
        {meta?.inviteRequired && (
          <Field label="Invite code" hint="Ask whoever runs your Kizuna server">
            <input className="input" required value={form.invite_code} onChange={set('invite_code')} />
          </Field>
        )}
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? <Spinner size={16} /> : <>Create account <ArrowRight size={17} /></>}
        </button>
      </form>
      <p className="auth-switch">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </Shell>
  );
}
