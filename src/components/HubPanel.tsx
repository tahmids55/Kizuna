import { useMemo, useState } from 'react';
import { BarChart3, ChevronDown, FileText, Flag, Lightbulb, ListTodo, Paperclip, Pin, Plus, Scale, Target, X } from 'lucide-react';
import { api, fileUrl } from '../lib/api';
import { cx, fileSize, fmtValue, goalProgress, listTime, plural, timeAgo } from '../lib/format';
import { applyItem, applyMessage, useFiles, useHub, usePins } from '../lib/store';
import type { Conversation, Message, Task, User } from '../lib/types';
import { ackDecision, DueChip, PollCard, VoteButton } from './Cards';
import { Avatar, AvatarStack, Check3, Empty, Loader, Progress, Segmented } from './ui';
import { setTaskStatus, useWork } from './WorkForms';
import { toastError } from './Toast';

export type HubTab = 'tasks' | 'ideas' | 'goals' | 'decisions' | 'polls' | 'pinned' | 'files';

const TABS: { id: HubTab; label: string; icon: typeof ListTodo }[] = [
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
  { id: 'ideas', label: 'Ideas', icon: Lightbulb },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'decisions', label: 'Decisions', icon: Scale },
  { id: 'polls', label: 'Polls', icon: BarChart3 },
  { id: 'pinned', label: 'Pinned', icon: Pin },
  { id: 'files', label: 'Files', icon: Paperclip },
];

export function HubPanel({ conversation, me, tab, onTab, onClose, onJump }: { conversation: Conversation; me: User; tab: HubTab; onTab: (t: HubTab) => void; onClose: () => void; onJump: (id: number) => void }) {
  const { data: hub, isLoading } = useHub(conversation.id);
  const counts: Partial<Record<HubTab, number>> = hub
    ? {
        tasks: hub.tasks.filter((t) => t.status !== 'done').length,
        ideas: hub.ideas.filter((i) => i.status === 'new' || i.status === 'exploring').length,
        goals: hub.goals.filter((g) => g.status === 'active').length,
        decisions: hub.decisions.length,
        polls: hub.polls.filter((p) => !p.closed_at).length,
      }
    : {};
  const tabs = conversation.type === 'self' ? TABS.filter((t) => !['decisions', 'polls'].includes(t.id)) : TABS;

  return (
    <aside className="hub">
      <header className="hub-head">
        <h3>Workspace</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">
          <X size={19} />
        </button>
      </header>
      <nav className="hub-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={cx('hub-tab', tab === t.id && 'active')} onClick={() => onTab(t.id)}>
            <t.icon size={15} />
            {t.label}
            {!!counts[t.id] && <span className="hub-count">{counts[t.id]}</span>}
          </button>
        ))}
      </nav>
      <div className="hub-body">
        {isLoading || !hub ? (
          <Loader />
        ) : tab === 'tasks' ? (
          <TasksTab conversation={conversation} tasks={hub.tasks} me={me} />
        ) : tab === 'ideas' ? (
          <IdeasTab conversation={conversation} me={me} ideas={hub.ideas} />
        ) : tab === 'goals' ? (
          <GoalsTab conversation={conversation} goals={hub.goals} />
        ) : tab === 'decisions' ? (
          <DecisionsTab conversation={conversation} me={me} decisions={hub.decisions} />
        ) : tab === 'polls' ? (
          <PollsTab conversation={conversation} me={me} polls={hub.polls} />
        ) : tab === 'pinned' ? (
          <PinnedTab conversation={conversation} onJump={onJump} />
        ) : (
          <FilesTab conversation={conversation} />
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ tasks */

export function TaskRow({ task, members, meId, showConv }: { task: Task; members: Conversation['members']; meId?: number; showConv?: boolean }) {
  const work = useWork();
  const assignee = members.find((m) => m.id === task.assignee_id);
  const done = task.status === 'done';
  return (
    <div className={cx('task-row', done && 'done')} role="button" tabIndex={0} onClick={() => work({ type: 'task-edit', task })} onKeyDown={(e) => e.key === 'Enter' && work({ type: 'task-edit', task })}>
      <Check3 checked={done} onChange={() => setTaskStatus(task, done ? 'todo' : 'done')} label={done ? 'Mark not done' : 'Mark done'} />
      <div className="task-row-main">
        <span className="task-row-title">{task.title}</span>
        <span className="task-row-meta">
          {task.status === 'doing' && <span className="status-chip doing">Doing</span>}
          {task.priority === 'high' && !done && <Flag size={12} className="pri-high" />}
          <DueChip date={task.due_date} done={done} />
          {showConv && task.conversation && <span className="conv-chip">{task.conversation.emoji} {task.conversation.type === 'self' ? 'My space' : task.conversation.name}</span>}
        </span>
      </div>
      {assignee ? <Avatar user={assignee} size={24} /> : task.assignee_id === meId ? null : <span className="avatar-empty sm" title="Unassigned" />}
    </div>
  );
}

function TasksTab({ conversation, tasks, me }: { conversation: Conversation; tasks: Task[]; me: User }) {
  const work = useWork();
  const [filter, setFilter] = useState<'all' | 'mine'>('all');
  const [title, setTitle] = useState('');
  const [showDone, setShowDone] = useState(false);
  const visible = tasks.filter((t) => filter === 'all' || t.assignee_id === me.id);
  const order = (t: Task) => `${t.priority === 'high' ? 0 : t.priority === 'normal' ? 1 : 2}${t.due_date ?? '9999'}`;
  const doing = visible.filter((t) => t.status === 'doing').sort((a, b) => order(a).localeCompare(order(b)));
  const todo = visible.filter((t) => t.status === 'todo').sort((a, b) => order(a).localeCompare(order(b)));
  const done = visible.filter((t) => t.status === 'done');

  const quickAdd = async () => {
    if (!title.trim()) return;
    try {
      const r = await api<{ task: Task; message: Message }>(`/conversations/${conversation.id}/tasks`, { method: 'POST', body: { title } });
      applyItem('task', r.task);
      applyMessage(r.message, { isNew: true, meId: me.id });
      setTitle('');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="hub-section">
      <div className="quick-add">
        <Plus size={17} className="muted" />
        <input placeholder="Add a task and press Enter" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && quickAdd()} />
        <button className="btn btn-ghost btn-xs" onClick={() => work({ type: 'task', cid: conversation.id, title })}>
          Details
        </button>
      </div>
      {conversation.type !== 'self' && (
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Everyone' }, { value: 'mine', label: 'Assigned to me' }]} className="wide" />
      )}
      {!visible.length && <Empty icon={<ListTodo size={24} />} title="No tasks yet">Turn any message into a task with the ⋯ menu, or type /task.</Empty>}
      {doing.length > 0 && <TaskGroup title="In progress" tasks={doing} conversation={conversation} meId={me.id} />}
      {todo.length > 0 && <TaskGroup title="To do" tasks={todo} conversation={conversation} meId={me.id} />}
      {done.length > 0 && (
        <>
          <button className="group-toggle" onClick={() => setShowDone((v) => !v)}>
            <ChevronDown size={15} className={cx(!showDone && 'rot-90')} /> Done ({done.length})
          </button>
          {showDone && done.map((t) => <TaskRow key={t.id} task={t} members={conversation.members} meId={me.id} />)}
        </>
      )}
    </div>
  );
}

const TaskGroup = ({ title, tasks, conversation, meId }: { title: string; tasks: Task[]; conversation: Conversation; meId: number }) => (
  <div className="task-group">
    <div className="group-title">
      {title} <span>{tasks.length}</span>
    </div>
    {tasks.map((t) => (
      <TaskRow key={t.id} task={t} members={conversation.members} meId={meId} />
    ))}
  </div>
);

/* ------------------------------------------------------------------ ideas */

function IdeasTab({ conversation, me, ideas }: { conversation: Conversation; me: User; ideas: NonNullable<ReturnType<typeof useHub>['data']>['ideas'] }) {
  const work = useWork();
  const [status, setStatus] = useState<'open' | 'accepted' | 'parked'>('open');
  const list = useMemo(
    () =>
      ideas
        .filter((i) => (status === 'open' ? i.status === 'new' || i.status === 'exploring' : i.status === status))
        .sort((a, b) => b.votes.length - a.votes.length || b.id - a.id),
    [ideas, status],
  );
  return (
    <div className="hub-section">
      <button className="btn btn-soft full" onClick={() => work({ type: 'idea', cid: conversation.id })}>
        <Lightbulb size={16} /> New idea
      </button>
      <Segmented value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'accepted', label: 'Accepted' }, { value: 'parked', label: 'Parked' }]} className="wide" />
      {!list.length && <Empty icon={<Lightbulb size={24} />} title="No ideas here">Capture ideas before they get lost in the scroll.</Empty>}
      {list.map((i) => (
        <div key={i.id} className="idea-row" role="button" tabIndex={0} onClick={() => work({ type: 'idea-edit', idea: i })}>
          <div onClick={(e) => e.stopPropagation()}>
            <VoteButton idea={i} members={conversation.members} meId={me.id} />
          </div>
          <div className="grow">
            <div className="row-title">{i.title}</div>
            {i.body && <div className="row-sub">{i.body}</div>}
            <div className="row-sub">
              {conversation.members.find((m) => m.id === i.created_by)?.name.split(' ')[0]} · {timeAgo(i.created_at)} · <span className={`idea-${i.status}`}>{i.status}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ goals */

function GoalsTab({ conversation, goals }: { conversation: Conversation; goals: NonNullable<ReturnType<typeof useHub>['data']>['goals'] }) {
  const work = useWork();
  return (
    <div className="hub-section">
      <button className="btn btn-soft full" onClick={() => work({ type: 'goal', cid: conversation.id })}>
        <Target size={16} /> New goal
      </button>
      {!goals.length && <Empty icon={<Target size={24} />} title="No goals yet">Set a measurable target — revenue, users, launches — and track it together.</Empty>}
      {goals.map((g) => {
        const owner = conversation.members.find((m) => m.id === g.owner_id);
        return (
          <div key={g.id} className={cx('goal-row', g.status !== 'active' && 'inactive')}>
            <div className="goal-row-head" role="button" tabIndex={0} onClick={() => work({ type: 'goal-edit', goal: g })}>
              <span className="row-title">{g.title}</span>
              {g.status === 'achieved' && <span className="status-chip done">Achieved</span>}
              {g.status === 'dropped' && <span className="status-chip">Dropped</span>}
            </div>
            <div className="goal-numbers">
              <strong>{fmtValue(g.current_value, g.unit)}</strong>
              <span className="muted"> / {fmtValue(g.target_value, g.unit)}</span>
              <span className="goal-pct">{Math.round(goalProgress(g) * 100)}%</span>
            </div>
            <Progress value={goalProgress(g)} color={g.status === 'achieved' ? 'var(--success)' : 'var(--goal)'} />
            <div className="goal-row-foot">
              {owner && <Avatar user={owner} size={20} />}
              {g.due_date && <DueChip date={g.due_date} done={g.status !== 'active'} />}
              <span className="spacer" />
              {g.status === 'active' && (
                <button className="btn btn-xs btn-soft" onClick={() => work({ type: 'goal-progress', goal: g })}>
                  Update
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- decisions */

function DecisionsTab({ conversation, me, decisions }: { conversation: Conversation; me: User; decisions: NonNullable<ReturnType<typeof useHub>['data']>['decisions'] }) {
  const work = useWork();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="hub-section">
      <button className="btn btn-soft full" onClick={() => work({ type: 'decision', cid: conversation.id })}>
        <Scale size={16} /> Record a decision
      </button>
      {!decisions.length && <Empty icon={<Scale size={24} />} title="Decision log is empty">“What did we agree on?” — answered in one place.</Empty>}
      <div className="timeline">
        {decisions.map((d) => {
          const ackers = conversation.members.filter((m) => d.acks.includes(m.id));
          const acked = d.acks.includes(me.id);
          return (
            <div key={d.id} className="timeline-item">
              <span className="timeline-dot" />
              <div className="grow">
                <button className="row-title as-link" onClick={() => setOpen(open === d.id ? null : d.id)}>
                  {d.title}
                </button>
                <div className="row-sub">
                  {listTime(d.created_at)} · {conversation.members.find((m) => m.id === d.created_by)?.name ?? 'Someone'}
                </div>
                {open === d.id && d.context && <p className="decision-context">{d.context}</p>}
                <div className="decision-acks">
                  <button className={cx('agree-btn sm', acked && 'on')} onClick={() => ackDecision(d)}>
                    {acked ? 'Agreed ✓' : 'I agree'}
                  </button>
                  <AvatarStack users={ackers} size={18} max={6} />
                  <span className="muted small">
                    {ackers.length}/{conversation.members.length}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ polls */

function PollsTab({ conversation, me, polls }: { conversation: Conversation; me: User; polls: NonNullable<ReturnType<typeof useHub>['data']>['polls'] }) {
  const work = useWork();
  return (
    <div className="hub-section">
      <button className="btn btn-soft full" onClick={() => work({ type: 'poll', cid: conversation.id })}>
        <BarChart3 size={16} /> New poll
      </button>
      {!polls.length && <Empty icon={<BarChart3 size={24} />} title="No polls yet">Settle quick questions with a vote.</Empty>}
      {polls.map((p) => (
        <PollCard key={p.id} poll={p} members={conversation.members} meId={me.id} />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- pinned & files */

function PinnedTab({ conversation, onJump }: { conversation: Conversation; onJump: (id: number) => void }) {
  const { data, isLoading } = usePins(conversation.id);
  if (isLoading) return <Loader />;
  if (!data?.length) return <Empty icon={<Pin size={24} />} title="Nothing pinned">Pin important messages — links, meeting times, credentials locations.</Empty>;
  return (
    <div className="hub-section">
      {data.map((m) => (
        <button key={m.id} className="pinned-row" onClick={() => onJump(m.id)}>
          <Avatar user={m.user} size={26} />
          <div className="grow">
            <div className="row-sub">
              {m.user?.name} · {listTime(m.created_at)}
            </div>
            <div className="pinned-text">{m.body || (m.attachments.length ? `📎 ${plural(m.attachments.length, 'attachment')}` : m.kind)}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

function FilesTab({ conversation }: { conversation: Conversation }) {
  const { data, isLoading } = useFiles(conversation.id);
  if (isLoading) return <Loader />;
  if (!data?.length) return <Empty icon={<Paperclip size={24} />} title="No files yet">Photos and documents shared here will collect in one place.</Empty>;
  const images = data.filter((f) => f.mime.startsWith('image/'));
  const docs = data.filter((f) => !f.mime.startsWith('image/'));
  return (
    <div className="hub-section">
      {images.length > 0 && (
        <div className="file-grid">
          {images.map((f) => (
            <a key={f.id} href={fileUrl(f.url)} target="_blank" rel="noopener noreferrer">
              <img src={fileUrl(f.url)} alt={f.filename} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {docs.map((f) => (
        <a key={f.id} className="file-chip wide" href={fileUrl(f.url)} target="_blank" rel="noopener noreferrer" download={f.filename}>
          <span className="file-icon">
            <FileText size={18} />
          </span>
          <span className="file-meta">
            <span className="file-name">{f.filename}</span>
            <span className="file-size">
              {fileSize(f.size)} · {f.user_name} · {listTime(f.created_at)}
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}
