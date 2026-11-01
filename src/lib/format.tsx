import { Fragment, type ReactNode } from 'react';
import type { Conversation, ConversationLabel, Goal, User } from './types';

export const cx = (...parts: (string | number | false | null | undefined)[]) => parts.filter((p) => typeof p === 'string' && p).join(' ');

/* --------------------------------------------------------------------- time */

const DAY = 864e5;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/** Compact timestamp for lists: 14:05 · Tue · Oct 3 */
export function listTime(iso: string) {
  const d = new Date(iso);
  const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY);
  if (diff === 0) return clock(iso);
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const fullTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/* ---------------------------------------------------------------- due dates */

export const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => toDay(new Date());
export const addDays = (n: number) => toDay(new Date(Date.now() + n * DAY));
const parseDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const daysUntil = (s: string) => Math.round((parseDay(s).getTime() - startOfDay(new Date())) / DAY);

export function dueLabel(s: string) {
  const n = daysUntil(s);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return parseDay(s).toLocaleDateString(undefined, { weekday: 'short' });
  return parseDay(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export type DueBucket = 'overdue' | 'today' | 'soon' | 'later' | 'none';
export function dueBucket(s: string | null): DueBucket {
  if (!s) return 'none';
  const n = daysUntil(s);
  return n < 0 ? 'overdue' : n === 0 ? 'today' : n <= 7 ? 'soon' : 'later';
}

/* -------------------------------------------------------------------- misc */

export const initials = (name?: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

export const firstName = (name?: string | null) => (name ?? '').split(' ')[0];

export function fileSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function fmtValue(v: number, unit: string) {
  const n = Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (!unit) return n;
  return ['$', '€', '£', '৳', '₹', '¥'].includes(unit) ? `${unit}${n}` : `${n} ${unit}`;
}

export function goalProgress(g: Pick<Goal, 'start_value' | 'target_value' | 'current_value'>) {
  const span = g.target_value - g.start_value;
  return span === 0 ? 1 : Math.max(0, Math.min(1, (g.current_value - g.start_value) / span));
}

/** Display name for a conversation from the viewer's side. */
export function conversationTitle(c: Pick<Conversation, 'type' | 'name' | 'members'>, meId?: number) {
  if (c.type === 'self') return 'My space';
  if (c.type === 'direct') return c.members.find((m) => m.id !== meId)?.name ?? 'Direct message';
  return c.name;
}

export const otherMember = (c: Conversation, meId?: number) => (c.type === 'direct' ? c.members.find((m) => m.id !== meId) : undefined);

export const labelTitle = (l?: ConversationLabel | null) => (l ? (l.type === 'self' ? 'My space' : l.name) : '');

export function lastSeen(u: Pick<User, 'last_seen_at'>, online: boolean) {
  if (online) return 'Online';
  return u.last_seen_at ? `Last seen ${timeAgo(u.last_seen_at)}` : 'Offline';
}

/* ------------------------------------------------------------- rich text */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Chat formatting without HTML injection: **bold**, *italic*, ~~strike~~, `code`,
 * ```code blocks```, links and @mentions. Produces React nodes (never innerHTML).
 */
export function RichText({ text, names = [], meName }: { text: string; names?: string[]; meName?: string }) {
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {blocks.map((b, i) =>
        b.length >= 6 && b.startsWith('```') && b.endsWith('```') ? (
          <pre key={i} className="code-block">
            {b.slice(3, -3).replace(/^[a-z]*\n/, '')}
          </pre>
        ) : (
          <Fragment key={i}>{inline(b, names, meName)}</Fragment>
        ),
      )}
    </>
  );
}

function inline(text: string, names: string[], meName?: string, depth = 0): ReactNode[] {
  const sorted = [...names].sort((a, b) => b.length - a.length).map(escapeRe);
  const mention = sorted.length ? `|(@(?:${sorted.join('|')}))` : '';
  const re = new RegExp(
    '(`[^`\\n]+`)|(\\*\\*[^*\\n]+\\*\\*)|(~~[^~\\n]+~~)|(\\*[^*\\s][^*\\n]*\\*)|(\\b_[^_\\n]+_\\b)|(https?:\\/\\/[^\\s<]+[^\\s<.,:;"\')\\]!?])' + mention,
    'g',
  );
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (s: string) => {
    s.split('\n').forEach((line, i) => {
      if (i) out.push(<br key={`br${out.length}`} />);
      if (line) out.push(line);
    });
  };
  while ((m = re.exec(text))) {
    pushText(text.slice(last, m.index));
    const [tok] = m;
    const k = `${depth}-${m.index}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{depth < 3 ? inline(tok.slice(2, -2), names, meName, depth + 1) : tok.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<s key={k}>{tok.slice(2, -2)}</s>);
    else if (m[4] || m[5]) out.push(<em key={k}>{depth < 3 ? inline(tok.slice(1, -1), names, meName, depth + 1) : tok.slice(1, -1)}</em>);
    else if (m[6])
      out.push(
        <a key={k} href={tok} target="_blank" rel="noopener noreferrer">
          {tok.length > 60 ? `${tok.slice(0, 57)}…` : tok}
        </a>,
      );
    else if (m[7]) out.push(<span key={k} className={cx('mention', meName && tok.slice(1) === meName && 'mention-me')}>{tok}</span>);
    last = m.index + tok.length;
  }
  pushText(text.slice(last));
  return out;
}

/** True when a message is only 1–3 emoji (rendered large, WhatsApp-style). */
export const isJumboEmoji = (s: string) => /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s){1,12}$/u.test(s) && /\p{Extended_Pictographic}/u.test(s) && [...s.replace(/\s/g, '')].filter((c) => /\p{Extended_Pictographic}/u.test(c)).length <= 3;
