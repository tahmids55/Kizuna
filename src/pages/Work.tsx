import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlarmClock, Bookmark, CheckSquare, Clock, Lightbulb, Scale, Sun, Target, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { cx, dueBucket, fmtValue, fullTime, goalProgress, labelTitle, listTime, plural, timeAgo, type DueBucket } from '../lib/format';
import { queryClient, useConversations, useLibrary, useMe, useSaved, useTasks, useToday } from '../lib/store';
import type { ConversationLabel, Member, Task } from '../lib/types';
import { ackDecision, DueChip, VoteButton } from '../components/Cards';
import { TaskRow } from '../components/HubPanel';
import { Avatar, ConvAvatar, Empty, Loader, Progress, Segmented } from '../components/ui';
import { useWork } from '../components/WorkForms';
import { toastError } from '../components/Toast';

function useAllMembers(): Member[] {
  const { data } = useConversations();
  return useMemo(() => {
    const map = new Map<number, Member>();
    for (const c of data ?? []) for (const m of c.members) map.set(m.id, m);
    return [...map.values()];
  }, [data]);
}

const membersOf = (cid: number) => queryClient.getQueryData<{ id: number; members: Member[] }[]>(['conversations'])?.find((c) => c.id === cid)?.members ?? [];

function ConvTag({ label }: { label?: ConversationLabel | null }) {
  if (!label) return null;
  return (
    <Link to={`/chats/${label.id}`} className="conv-tag" onClick={(e) => e.stopPropagation()}>
      {label.type === 'direct' ? '@' : label.emoji} {labelTitle(label)}
    </Link>
  );
}

function Section({ title, icon, count, action, children }: { title: string; icon: ReactNode; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>
          {icon} {title} {count != null && count > 0 && <span className="count">{count}</span>}
        </h3>
        {action}
      </header>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ Today */

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function TodayPage() {
  const { data: me } = useMe();
  const { data, isLoading } = useToday();
  const members = useAllMembers();
  const work = useWork();
  const navigate = useNavigate();
  if (isLoading || !data || !me) return <Loader />;
  const overdue = data.my_tasks.filter((t) => dueBucket(t.due_date) === 'overdue');
  const todays = data.my_tasks.filter((t) => dueBucket(t.due_date) === 'today');
  const later = data.my_tasks.filter((t) => !['overdue', 'today'].includes(dueBucket(t.due_date)));

  return (
    <div className="page">
      <header className="page-hero">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1>
            {greeting()}, {me.name.split(' ')[0]} 👋
          </h1>
          <p className="muted">
            {data.stats.open === 0 ? 'Nothing on your plate. A great day to think big.' : `${plural(data.stats.open, 'open task')}${overdue.length ? `, ${overdue.length} overdue` : ''}.`}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => work({ type: 'checkin' })}>
          <Sun size={16} /> Post check-in
        </button>
      </header>

      <div className="stat-row">
        <div className="stat">
          <span className="stat-value">{data.stats.open}</span>
          <span className="stat-label">Open tasks</span>
        </div>
        <div className={cx('stat', overdue.length > 0 && 'alert')}>
          <span className="stat-value">{overdue.length}</span>
          <span className="stat-label">Overdue</span>
        </div>
        <div className="stat">
          <span className="stat-value">{data.stats.done_week}</span>
          <span className="stat-label">Done this week</span>
        </div>
        <div className="stat">
          <span className="stat-value">{data.waiting_on.length}</span>
          <span className="stat-label">Waiting on others</span>
        </div>
      </div>

      <div className="dash-grid">
        <div className="dash-col">
          <Section title="Your focus" icon={<CheckSquare size={17} />} count={data.my_tasks.length} action={<Link to="/tasks" className="link small">All tasks</Link>}>
            {!data.my_tasks.length && <Empty title="Inbox zero 🎉">Tasks assigned to you show up here.</Empty>}
            {overdue.length > 0 && <TaskBucket title="Overdue" tasks={overdue} members={members} meId={me.id} tone="danger" />}
            {todays.length > 0 && <TaskBucket title="Today" tasks={todays} members={members} meId={me.id} />}
            {later.length > 0 && <TaskBucket title="Coming up" tasks={later} members={members} meId={me.id} />}
          </Section>

          <Section title="Waiting on others" icon={<Clock size={17} />} count={data.waiting_on.length}>
            {!data.waiting_on.length ? (
              <p className="muted small">Tasks you’ve assigned to teammates will be tracked here.</p>
            ) : (
              data.waiting_on.map((t) => <TaskRow key={t.id} task={t} members={members} meId={me.id} showConv />)
            )}
          </Section>
        </div>

        <div className="dash-col">
          <Section title="Goals" icon={<Target size={17} />} count={data.goals.length}>
            {!data.goals.length && <p className="muted small">No active goals. Set one from any chat with /goal.</p>}
            {data.goals.map((g) => {
              const owner = members.find((m) => m.id === g.owner_id);
              return (
                <button key={g.id} className="goal-mini" onClick={() => work({ type: 'goal-progress', goal: g })}>
                  <div className="goal-mini-top">
                    <span className="row-title">{g.title}</span>
                    <span className="goal-pct">{Math.round(goalProgress(g) * 100)}%</span>
                  </div>
                  <Progress value={goalProgress(g)} color="var(--goal)" />
                  <div className="goal-mini-foot">
                    {owner && <Avatar user={owner} size={18} />}
                    <span className="muted small">
                      {fmtValue(g.current_value, g.unit)} / {fmtValue(g.target_value, g.unit)}
                    </span>
                    <span className="spacer" />
                    {g.due_date && <DueChip date={g.due_date} />}
                    <ConvTag label={g.conversation} />
                  </div>
                </button>
              );
            })}
          </Section>

          {data.reminders.length > 0 && (
            <Section title="Reminders" icon={<AlarmClock size={17} />} count={data.reminders.length}>
              {data.reminders.map((r) => (
                <div key={r.id} className="reminder-row">
                  <span className="reminder-time">{new Date(r.remind_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                  <button className="grow as-link left" onClick={() => r.conversation_id && r.message_id && navigate(`/chats/${r.conversation_id}?m=${r.message_id}`)}>
                    {r.note || r.message_body || 'Reminder'}
                  </button>
                  <button
                    className="icon-btn sm"
                    aria-label="Cancel reminder"
                    onClick={async () => {
                      try {
                        await api(`/reminders/${r.id}`, { method: 'DELETE' });
                        queryClient.invalidateQueries({ queryKey: ['today'] });
                      } catch (e) {
                        toastError(e);
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </Section>
          )}

          <Section title="Fresh ideas" icon={<Lightbulb size={17} />} count={data.ideas.length} action={<Link to="/library" className="link small">Library</Link>}>
            {!data.ideas.length && <p className="muted small">New ideas from the last two weeks appear here.</p>}
            {data.ideas.map((i) => (
              <div key={i.id} className="idea-row compact">
                <VoteButton idea={i} members={membersOf(i.conversation_id)} meId={me.id} />
                <div className="grow">
                  <div className="row-title">{i.title}</div>
                  <div className="row-sub">
                    <ConvTag label={i.conversation} /> · {timeAgo(i.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </Section>

          <Section title="Recent decisions" icon={<Scale size={17} />} count={data.decisions.length}>
            {!data.decisions.length && <p className="muted small">Record decisions with /decision so nobody has to scroll back.</p>}
            {data.decisions.map((d) => (
              <div key={d.id} className="decision-mini">
                <span className="row-title">{d.title}</span>
                <span className="row-sub">
                  <ConvTag label={d.conversation} /> · {listTime(d.created_at)} · {d.acks.length} agreed
                  {!d.acks.includes(me.id) && (
                    <button className="link small" onClick={() => ackDecision(d)}>
                      I agree
                    </button>
                  )}
                </span>
              </div>
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}

function TaskBucket({ title, tasks, members, meId, tone }: { title: string; tasks: Task[]; members: Member[]; meId: number; tone?: 'danger' }) {
  return (
    <div className="task-group">
      <div className={cx('group-title', tone)}>
        {title} <span>{tasks.length}</span>
      </div>
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} members={members} meId={meId} showConv />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Tasks */

const BUCKETS: [DueBucket, string][] = [
  ['overdue', 'Overdue'],
  ['today', 'Today'],
  ['soon', 'This week'],
  ['later', 'Later'],
  ['none', 'No due date'],
];

export function TasksPage() {
  const { data: me } = useMe();
  const [scope, setScope] = useState<'assigned' | 'created' | 'all'>('assigned');
  const { data: tasks, isLoading } = useTasks(scope);
  const members = useAllMembers();
  const work = useWork();
  const { data: conversations } = useConversations();
  const self = conversations?.find((c) => c.type === 'self');
  const open = (tasks ?? []).filter((t) => t.status !== 'done');
  const done = (tasks ?? []).filter((t) => t.status === 'done');

  return (
    <div className="page">
      <header className="page-head">
        <h1>Tasks</h1>
        {self && (
          <button className="btn btn-primary" onClick={() => work({ type: 'task', cid: self.id })}>
            + Personal task
          </button>
        )}
      </header>
      <Segmented
        value={scope}
        onChange={setScope}
        options={[
          { value: 'assigned', label: 'Assigned to me' },
          { value: 'created', label: 'I assigned' },
          { value: 'all', label: 'Everything' },
        ]}
        className="wide page-tabs"
      />
      {isLoading || !me ? (
        <Loader />
      ) : !tasks?.length ? (
        <Empty icon={<CheckSquare size={26} />} title={scope === 'created' ? 'You haven’t assigned anything' : 'No tasks'}>
          In any chat, tap ⋯ on a message → “Make it a task”, or type /task.
        </Empty>
      ) : (
        <div className="panel">
          {BUCKETS.map(([b, label]) => {
            const list = open.filter((t) => dueBucket(t.due_date) === b);
            return list.length ? <TaskBucket key={b} title={label} tasks={list} members={members} meId={me.id} tone={b === 'overdue' ? 'danger' : undefined} /> : null;
          })}
          {done.length > 0 && <TaskBucket title="Done in the last 7 days" tasks={done} members={members} meId={me.id} />}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Library */

export function LibraryPage() {
  const { data: me } = useMe();
  const [tab, setTab] = useState<'ideas' | 'goals' | 'decisions' | 'saved'>('ideas');
  const { data, isLoading } = useLibrary();
  const { data: saved } = useSaved();
  const work = useWork();
  const navigate = useNavigate();

  return (
    <div className="page">
      <header className="page-head">
        <h1>Library</h1>
      </header>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'ideas', label: <><Lightbulb size={14} /> Ideas</> },
          { value: 'goals', label: <><Target size={14} /> Goals</> },
          { value: 'decisions', label: <><Scale size={14} /> Decisions</> },
          { value: 'saved', label: <><Bookmark size={14} /> Saved</> },
        ]}
        className="wide page-tabs"
      />
      {isLoading || !data || !me ? (
        <Loader />
      ) : tab === 'ideas' ? (
        <div className="lib-grid">
          {!data.ideas.length && <Empty title="No ideas yet">Use /idea in any chat.</Empty>}
          {[...data.ideas]
            .sort((a, b) => b.votes.length - a.votes.length)
            .map((i) => (
              <div key={i.id} className="lib-card" role="button" tabIndex={0} onClick={() => work({ type: 'idea-edit', idea: i })}>
                <div className="lib-card-top">
                  <span className={cx('status-chip', `idea-${i.status}`)}>{i.status}</span>
                  <ConvTag label={i.conversation} />
                </div>
                <div className="row-title">{i.title}</div>
                {i.body && <p className="row-sub clamp">{i.body}</p>}
                <div onClick={(e) => e.stopPropagation()}>
                  <VoteButton idea={i} members={membersOf(i.conversation_id)} meId={me.id} />
                </div>
              </div>
            ))}
        </div>
      ) : tab === 'goals' ? (
        <div className="lib-grid">
          {!data.goals.length && <Empty title="No goals yet">Use /goal in any chat.</Empty>}
          {data.goals.map((g) => (
            <div key={g.id} className={cx('lib-card', g.status !== 'active' && 'inactive')} role="button" tabIndex={0} onClick={() => work({ type: g.status === 'active' ? 'goal-progress' : 'goal-edit', goal: g })}>
              <div className="lib-card-top">
                <span className={cx('status-chip', g.status === 'achieved' && 'done')}>{g.status}</span>
                <ConvTag label={g.conversation} />
              </div>
              <div className="row-title">{g.title}</div>
              <div className="goal-numbers">
                <strong>{fmtValue(g.current_value, g.unit)}</strong>
                <span className="muted"> / {fmtValue(g.target_value, g.unit)}</span>
                <span className="goal-pct">{Math.round(goalProgress(g) * 100)}%</span>
              </div>
              <Progress value={goalProgress(g)} color={g.status === 'achieved' ? 'var(--success)' : 'var(--goal)'} />
            </div>
          ))}
        </div>
      ) : tab === 'decisions' ? (
        <div className="panel timeline">
          {!data.decisions.length && <Empty title="No decisions logged">Use /decision in any chat.</Empty>}
          {data.decisions.map((d) => (
            <div key={d.id} className="timeline-item">
              <span className="timeline-dot" />
              <div className="grow">
                <div className="row-title">{d.title}</div>
                <div className="row-sub">
                  {fullTime(d.created_at)} · <ConvTag label={d.conversation} /> · {d.acks.length} agreed
                </div>
                {d.context && <p className="decision-context">{d.context}</p>}
              </div>
              <button className={cx('agree-btn sm', d.acks.includes(me.id) && 'on')} onClick={() => ackDecision(d)}>
                {d.acks.includes(me.id) ? 'Agreed ✓' : 'I agree'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel">
          {!saved?.length && <Empty icon={<Bookmark size={24} />} title="Nothing saved">Tap ⋯ → “Save for later” on any message.</Empty>}
          {saved?.map((m) => (
            <button key={m.id} className="saved-row" onClick={() => navigate(`/chats/${m.conversation_id}?m=${m.id}`)}>
              {m.conversation && <ConvAvatar label={m.conversation} size={34} />}
              <span className="grow">
                <span className="row-sub">
                  <strong>{m.user?.name}</strong> in {labelTitle(m.conversation)} · {listTime(m.created_at)}
                </span>
                <span className="saved-text">{m.body || (m.attachments.length ? `📎 ${m.attachments[0].filename}` : m.kind)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
