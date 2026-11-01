import type { ReactNode } from 'react';
import { CalendarDays, Check, Flag, Lightbulb, ListTodo, Scale, Target, ThumbsUp, Vote } from 'lucide-react';
import { api } from '../lib/api';
import { cx, daysUntil, dueLabel, fmtValue, goalProgress, plural } from '../lib/format';
import { applyItem } from '../lib/store';
import type { Decision, Goal, Idea, Member, Message, Poll, Task } from '../lib/types';
import { Avatar, AvatarStack, Check3, Progress } from './ui';
import { moodEmoji, setTaskStatus, useWork } from './WorkForms';
import { toastError } from './Toast';

function CardShell({ kind, icon, label, children, footer, onOpen, done }: { kind: string; icon: ReactNode; label: ReactNode; children: ReactNode; footer?: ReactNode; onOpen?: () => void; done?: boolean }) {
  return (
    <div className={cx('card', `card-${kind}`, done && 'is-done')}>
      <div className="card-head">
        <span className="card-icon">{icon}</span>
        <span className="card-label">{label}</span>
        {onOpen && (
          <button className="card-open" onClick={onOpen}>
            Open
          </button>
        )}
      </div>
      <div className="card-body">{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </div>
  );
}

export const Missing = ({ what }: { what: string }) => <div className="card card-missing">This {what} was deleted.</div>;

export function DueChip({ date, done }: { date: string | null; done?: boolean }) {
  if (!date) return null;
  const n = daysUntil(date);
  return (
    <span className={cx('due-chip', !done && n < 0 && 'overdue', !done && n === 0 && 'today')}>
      <CalendarDays size={12} />
      {dueLabel(date)}
    </span>
  );
}

const byId = (members: Member[], id: number | null) => (id ? members.find((m) => m.id === id) : undefined);

/* ------------------------------------------------------------------- task */

export function TaskCard({ task, members, meId }: { task: Task; members: Member[]; meId?: number }) {
  const work = useWork();
  const assignee = byId(members, task.assignee_id);
  const creator = byId(members, task.created_by);
  const done = task.status === 'done';
  const forMe = task.assignee_id === meId && task.created_by !== meId;
  return (
    <CardShell
      kind="task"
      icon={<ListTodo size={14} />}
      label={forMe ? `Task for you from ${creator?.name.split(' ')[0] ?? 'someone'}` : 'Task'}
      onOpen={() => work({ type: 'task-edit', task })}
      done={done}
    >
      <div className="task-line">
        <Check3 checked={done} onChange={() => setTaskStatus(task, done ? 'todo' : 'done')} label={done ? 'Mark as not done' : 'Mark as done'} />
        <span className="task-title">{task.title}</span>
      </div>
      <div className="card-meta">
        {assignee ? (
          <span className="meta-person">
            <Avatar user={assignee} size={18} />
            {assignee.id === meId ? 'You' : assignee.name.split(' ')[0]}
          </span>
        ) : (
          <span className="muted">Unassigned</span>
        )}
        <DueChip date={task.due_date} done={done} />
        {task.priority === 'high' && (
          <span className="pri-high meta-flag">
            <Flag size={12} /> High
          </span>
        )}
        {task.status === 'doing' && <span className="status-chip doing">In progress</span>}
        {done && <span className="status-chip done">Done</span>}
      </div>
      {task.notes && <p className="card-notes">{task.notes}</p>}
    </CardShell>
  );
}

/* ------------------------------------------------------------------- idea */

const IDEA_LABEL = { new: 'New', exploring: 'Exploring', accepted: 'Accepted', parked: 'Parked' };

export async function voteIdea(idea: Idea) {
  try {
    applyItem('idea', (await api<{ idea: Idea }>(`/ideas/${idea.id}/vote`, { method: 'POST' })).idea);
  } catch (e) {
    toastError(e);
  }
}

export function VoteButton({ idea, members, meId }: { idea: Idea; members: Member[]; meId?: number }) {
  const voted = meId != null && idea.votes.includes(meId);
  const voters = idea.votes.map((id) => byId(members, id)).filter(Boolean) as Member[];
  return (
    <button className={cx('vote-btn', voted && 'on')} onClick={() => voteIdea(idea)} title={voters.map((v) => v.name).join(', ') || 'Be the first to vote'}>
      <ThumbsUp size={14} />
      {idea.votes.length}
    </button>
  );
}

export function IdeaCard({ idea, members, meId }: { idea: Idea; members: Member[]; meId?: number }) {
  const work = useWork();
  const voters = idea.votes.map((id) => byId(members, id)).filter(Boolean) as Member[];
  return (
    <CardShell kind="idea" icon={<Lightbulb size={14} />} label="Idea" onOpen={() => work({ type: 'idea-edit', idea })}>
      <div className="card-title">{idea.title}</div>
      {idea.body && <p className="card-notes">{idea.body}</p>}
      <div className="card-meta">
        <VoteButton idea={idea} members={members} meId={meId} />
        {voters.length > 0 && <AvatarStack users={voters} size={18} />}
        <span className={cx('status-chip', `idea-${idea.status}`)}>{IDEA_LABEL[idea.status]}</span>
      </div>
    </CardShell>
  );
}

/* ------------------------------------------------------------------- goal */

export function GoalCard({ goal, members }: { goal: Goal; members: Member[] }) {
  const work = useWork();
  const owner = byId(members, goal.owner_id);
  const pct = goalProgress(goal);
  return (
    <CardShell
      kind="goal"
      icon={<Target size={14} />}
      label={goal.status === 'achieved' ? 'Goal achieved 🎉' : goal.status === 'dropped' ? 'Goal (dropped)' : 'Goal'}
      onOpen={() => work({ type: 'goal-edit', goal })}
      done={goal.status !== 'active'}
      footer={
        goal.status === 'active' && (
          <button className="btn btn-sm btn-soft" onClick={() => work({ type: 'goal-progress', goal })}>
            Update progress
          </button>
        )
      }
    >
      <div className="card-title">{goal.title}</div>
      <div className="goal-numbers">
        <strong>{fmtValue(goal.current_value, goal.unit)}</strong>
        <span className="muted"> of {fmtValue(goal.target_value, goal.unit)}</span>
        <span className="goal-pct">{Math.round(pct * 100)}%</span>
      </div>
      <Progress value={pct} height={8} color={goal.status === 'achieved' ? 'var(--success)' : 'var(--goal)'} />
      <div className="card-meta">
        {owner && (
          <span className="meta-person">
            <Avatar user={owner} size={18} />
            {owner.name.split(' ')[0]}
          </span>
        )}
        {goal.due_date && <DueChip date={goal.due_date} done={goal.status !== 'active'} />}
      </div>
    </CardShell>
  );
}

/* --------------------------------------------------------------- decision */

export async function ackDecision(d: Decision) {
  try {
    applyItem('decision', (await api<{ decision: Decision }>(`/decisions/${d.id}/ack`, { method: 'POST' })).decision);
  } catch (e) {
    toastError(e);
  }
}

export function DecisionCard({ decision, members, meId }: { decision: Decision; members: Member[]; meId?: number }) {
  const acked = meId != null && decision.acks.includes(meId);
  const ackers = decision.acks.map((id) => byId(members, id)).filter(Boolean) as Member[];
  const all = members.length > 0 && ackers.length >= members.length;
  return (
    <CardShell kind="decision" icon={<Scale size={14} />} label={all ? 'Decision · everyone agreed' : 'Decision'}>
      <div className="card-title">{decision.title}</div>
      {decision.context && <p className="card-notes">{decision.context}</p>}
      <div className="card-meta">
        <button className={cx('agree-btn', acked && 'on')} onClick={() => ackDecision(decision)}>
          <Check size={14} strokeWidth={3} />
          {acked ? 'Agreed' : 'I agree'}
        </button>
        <AvatarStack users={ackers} size={18} max={6} />
        <span className="muted small">
          {ackers.length}/{members.length} agreed
        </span>
      </div>
    </CardShell>
  );
}

/* ------------------------------------------------------------------- poll */

export function PollCard({ poll, members, meId }: { poll: Poll; members: Member[]; meId?: number }) {
  const total = new Set(poll.options.flatMap((o) => o.votes)).size;
  const mine = poll.options.filter((o) => meId != null && o.votes.includes(meId)).map((o) => o.id);
  const max = Math.max(1, ...poll.options.map((o) => o.votes.length));
  const vote = async (optionId: number) => {
    if (poll.closed_at) return;
    const next = poll.multiple ? (mine.includes(optionId) ? mine.filter((x) => x !== optionId) : [...mine, optionId]) : mine.includes(optionId) ? [] : [optionId];
    try {
      applyItem('poll', (await api<{ poll: Poll }>(`/polls/${poll.id}/vote`, { method: 'POST', body: { option_ids: next } })).poll);
    } catch (e) {
      toastError(e);
    }
  };
  const close = async () => {
    try {
      applyItem('poll', (await api<{ poll: Poll }>(`/polls/${poll.id}/close`, { method: 'POST' })).poll);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <CardShell
      kind="poll"
      icon={<Vote size={14} />}
      label={poll.closed_at ? 'Poll · closed' : poll.multiple ? 'Poll · pick any' : 'Poll · pick one'}
      footer={
        <>
          <span className="muted small">{plural(total, 'vote')}</span>
          {!poll.closed_at && poll.created_by === meId && (
            <button className="btn btn-ghost btn-xs" onClick={close}>
              Close poll
            </button>
          )}
        </>
      }
    >
      <div className="card-title">{poll.question}</div>
      <div className="poll-options">
        {poll.options.map((o) => {
          const voters = o.votes.map((id) => byId(members, id)).filter(Boolean) as Member[];
          const picked = mine.includes(o.id);
          const winner = poll.closed_at && o.votes.length === max && o.votes.length > 0;
          return (
            <button key={o.id} className={cx('poll-option', picked && 'picked', winner && 'winner')} onClick={() => vote(o.id)} disabled={Boolean(poll.closed_at)}>
              <span className="poll-bar" style={{ width: `${total ? (o.votes.length / total) * 100 : 0}%` }} />
              <span className="poll-check">{picked && <Check size={12} strokeWidth={3.5} />}</span>
              <span className="poll-label">{o.label}</span>
              <AvatarStack users={voters} size={16} max={3} />
              <span className="poll-count">{o.votes.length}</span>
            </button>
          );
        })}
      </div>
    </CardShell>
  );
}

/* ---------------------------------------------------------------- checkin */

export function CheckinCard({ message }: { message: Message }) {
  const meta = (message.meta ?? {}) as { done?: string; doing?: string; blockers?: string; mood?: string };
  return (
    <CardShell kind="checkin" icon={<span>{moodEmoji(meta.mood ?? 'good')}</span>} label="Daily check-in">
      {meta.done && (
        <div className="checkin-row">
          <span className="checkin-k">✅ Done</span>
          <span>{meta.done}</span>
        </div>
      )}
      {meta.doing && (
        <div className="checkin-row">
          <span className="checkin-k">🔨 Next</span>
          <span>{meta.doing}</span>
        </div>
      )}
      {meta.blockers && (
        <div className="checkin-row blocker">
          <span className="checkin-k">🚧 Blocked</span>
          <span>{meta.blockers}</span>
        </div>
      )}
    </CardShell>
  );
}
