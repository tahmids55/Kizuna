import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flag, Plus, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { addDays, conversationTitle, cx, dueLabel, fmtValue, fullTime, goalProgress, today, timeAgo } from '../lib/format';
import { applyItem, applyMessage, queryClient, useConversations, useMe } from '../lib/store';
import type { Conversation, Decision, Goal, Idea, IdeaStatus, Member, Poll, Priority, Task, TaskStatus } from '../lib/types';
import { Avatar, Confirm, Field, Modal, Progress, Segmented, Spinner } from './ui';
import { toast, toastError } from './Toast';

/* ------------------------------------------------------------- controller */

export type WorkRequest =
  | { type: 'task'; cid: number; title?: string; source?: number; assignee?: number | null }
  | { type: 'task-edit'; task: Task }
  | { type: 'idea'; cid: number; title?: string; body?: string; source?: number }
  | { type: 'idea-edit'; idea: Idea }
  | { type: 'goal'; cid: number; title?: string }
  | { type: 'goal-edit'; goal: Goal }
  | { type: 'goal-progress'; goal: Goal }
  | { type: 'decision'; cid: number; title?: string; context?: string; source?: number }
  | { type: 'poll'; cid: number; question?: string }
  | { type: 'checkin'; cid?: number }
  | { type: 'reminder'; messageId?: number; note?: string };

const Ctx = createContext<(r: WorkRequest) => void>(() => {});
export const useWork = () => useContext(Ctx);

export function WorkProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<WorkRequest | null>(null);
  const close = () => setReq(null);
  return (
    <Ctx.Provider value={setReq}>
      {children}
      {req?.type === 'task' && <TaskForm cid={req.cid} initial={{ title: req.title, assignee_id: req.assignee }} source={req.source} onClose={close} />}
      {req?.type === 'task-edit' && <TaskForm cid={req.task.conversation_id} task={req.task} onClose={close} />}
      {req?.type === 'idea' && <IdeaForm cid={req.cid} initial={{ title: req.title, body: req.body }} source={req.source} onClose={close} />}
      {req?.type === 'idea-edit' && <IdeaForm cid={req.idea.conversation_id} idea={req.idea} onClose={close} />}
      {req?.type === 'goal' && <GoalForm cid={req.cid} initialTitle={req.title} onClose={close} />}
      {req?.type === 'goal-edit' && <GoalForm cid={req.goal.conversation_id} goal={req.goal} onClose={close} />}
      {req?.type === 'goal-progress' && <GoalProgress goal={req.goal} onClose={close} />}
      {req?.type === 'decision' && <DecisionForm cid={req.cid} initial={{ title: req.title, context: req.context }} source={req.source} onClose={close} />}
      {req?.type === 'poll' && <PollForm cid={req.cid} initialQuestion={req.question} onClose={close} />}
      {req?.type === 'checkin' && <CheckinForm cid={req.cid} onClose={close} />}
      {req?.type === 'reminder' && <ReminderForm messageId={req.messageId} initialNote={req.note} onClose={close} />}
    </Ctx.Provider>
  );
}

/* ----------------------------------------------------------------- shared */

function useMembers(cid: number): { conversation?: Conversation; members: Member[] } {
  const { data } = useConversations();
  const conversation = data?.find((c) => c.id === cid);
  return { conversation, members: conversation?.members ?? [] };
}

/** Tap-to-pick people row — fast on phones, fine for groups of up to 10. */
export function PeoplePicker({ members, value, onChange, allowNone = true, meId }: { members: Member[]; value: number | null; onChange: (id: number | null) => void; allowNone?: boolean; meId?: number }) {
  const sorted = [...members].sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : 0));
  return (
    <div className="people-picker">
      {allowNone && (
        <button type="button" className={cx('person-chip', value === null && 'on')} onClick={() => onChange(null)}>
          <span className="avatar-empty" />
          Nobody
        </button>
      )}
      {sorted.map((m) => (
        <button type="button" key={m.id} className={cx('person-chip', value === m.id && 'on')} onClick={() => onChange(m.id)}>
          <Avatar user={m} size={22} />
          {m.id === meId ? 'Me' : m.name.split(' ')[0]}
        </button>
      ))}
    </div>
  );
}

export function DuePicker({ value, onChange }: { value: string | null; onChange: (d: string | null) => void }) {
  const friday = (() => {
    const d = new Date();
    const add = (5 - d.getDay() + 7) % 7 || 7;
    return addDays(add);
  })();
  const presets: [string, string][] = [
    ['Today', today()],
    ['Tomorrow', addDays(1)],
    ['Friday', friday],
    ['Next week', addDays(7)],
  ];
  return (
    <div className="due-picker">
      {presets.map(([label, d]) => (
        <button type="button" key={label} className={cx('chip', value === d && 'on')} onClick={() => onChange(value === d ? null : d)}>
          {label}
        </button>
      ))}
      <input type="date" className="input date-input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Due date" />
      {value && (
        <button type="button" className="icon-btn sm" onClick={() => onChange(null)} aria-label="Clear date">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function FormModal({
  title,
  onClose,
  onSubmit,
  busy,
  submitLabel,
  disabled,
  children,
  extra,
}: {
  title: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  submitLabel: string;
  disabled?: boolean;
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          {extra}
          <span className="spacer" />
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="button" onClick={onSubmit} disabled={busy || disabled}>
            {busy ? <Spinner size={15} /> : submitLabel}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled && !busy) onSubmit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (!disabled && !busy) onSubmit();
          }
        }}
      >
        {children}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function useSubmit(fn: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async () => {
      setBusy(true);
      try {
        await fn();
        onDone();
      } catch (e) {
        toastError(e);
      } finally {
        setBusy(false);
      }
    },
  };
}

type Created<T> = { message?: Parameters<typeof applyMessage>[0] } & T;
function applyCreated<K extends string, T>(type: 'task' | 'idea' | 'goal' | 'decision' | 'poll', key: K, r: Created<Record<K, T>>) {
  const me = queryClient.getQueryData<{ id: number }>(['me']);
  applyItem(type, r[key] as never);
  if (r.message) applyMessage(r.message, { isNew: true, meId: me?.id });
}

/* ------------------------------------------------------------------ tasks */

function TaskForm({ cid, task, initial, source, onClose }: { cid: number; task?: Task; initial?: { title?: string; assignee_id?: number | null }; source?: number; onClose: () => void }) {
  const { data: me } = useMe();
  const { conversation, members } = useMembers(cid);
  const navigate = useNavigate();
  const [title, setTitle] = useState(task?.title ?? initial?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [assignee, setAssignee] = useState<number | null>(task ? task.assignee_id : initial?.assignee_id ?? (conversation?.type === 'self' ? me?.id ?? null : null));
  const [due, setDue] = useState<string | null>(task?.due_date ?? null);
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'normal');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo');
  const [confirm, setConfirm] = useState(false);

  const save = useSubmit(async () => {
    const body = { title, notes, assignee_id: assignee, due_date: due, priority };
    if (task) {
      const r = await api<{ task: Task }>(`/tasks/${task.id}`, { method: 'PATCH', body: { ...body, status } });
      applyItem('task', r.task);
      toast('Task updated');
    } else {
      const r = await api<Created<{ task: Task }>>(`/conversations/${cid}/tasks`, { method: 'POST', body: { ...body, source_message_id: source ?? null } });
      applyCreated('task', 'task', r);
      const who = members.find((m) => m.id === assignee);
      toast(who && who.id !== me?.id ? `Task assigned to ${who.name.split(' ')[0]}` : 'Task created');
    }
  }, onClose);

  const remove = async () => {
    try {
      await api(`/tasks/${task!.id}`, { method: 'DELETE' });
      onClose();
      toast('Task deleted');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <FormModal
      title={task ? 'Task' : 'New task'}
      onClose={onClose}
      onSubmit={save.run}
      busy={save.busy}
      submitLabel={task ? 'Save' : assignee && assignee !== me?.id ? 'Assign task' : 'Create task'}
      disabled={!title.trim()}
      extra={
        task && (
          <>
            <button type="button" className="icon-btn danger" onClick={() => setConfirm(true)} aria-label="Delete task" title="Delete task">
              <Trash2 size={17} />
            </button>
            {task.message_id && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  onClose();
                  navigate(`/chats/${task.conversation_id}?m=${task.message_id}`);
                }}
              >
                View in chat
              </button>
            )}
          </>
        )
      }
    >
      {task && <Segmented value={status} onChange={setStatus} options={[{ value: 'todo', label: 'To do' }, { value: 'doing', label: 'Doing' }, { value: 'done', label: 'Done ✓' }]} className="wide" />}
      <input className="input input-lg" autoFocus={!task} placeholder="What needs to be done?" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="input" rows={3} placeholder="Notes, links, acceptance criteria… (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <Field label="Assign to">
        <PeoplePicker members={members} value={assignee} onChange={setAssignee} meId={me?.id} />
      </Field>
      <Field label="Due">
        <DuePicker value={due} onChange={setDue} />
      </Field>
      <Field label="Priority">
        <Segmented
          value={priority}
          onChange={setPriority}
          options={[
            { value: 'high', label: <><Flag size={13} className="pri-high" /> High</> },
            { value: 'normal', label: 'Normal' },
            { value: 'low', label: 'Low' },
          ]}
        />
      </Field>
      {task && (
        <p className="muted small">
          Created {timeAgo(task.created_at)}
          {conversation ? ` in ${conversationTitle(conversation, me?.id)}` : ''}
          {task.completed_at ? ` · completed ${timeAgo(task.completed_at)}` : ''}
        </p>
      )}
      <Confirm open={confirm} title="Delete this task?" message={`“${task?.title}” will be removed for everyone.`} onConfirm={remove} onClose={() => setConfirm(false)} />
    </FormModal>
  );
}

/* ------------------------------------------------------------------ ideas */

function IdeaForm({ cid, idea, initial, source, onClose }: { cid: number; idea?: Idea; initial?: { title?: string; body?: string }; source?: number; onClose: () => void }) {
  const [title, setTitle] = useState(idea?.title ?? initial?.title ?? '');
  const [body, setBody] = useState(idea?.body ?? initial?.body ?? '');
  const [status, setStatus] = useState<IdeaStatus>(idea?.status ?? 'new');
  const [confirm, setConfirm] = useState(false);
  const save = useSubmit(async () => {
    if (idea) applyItem('idea', (await api<{ idea: Idea }>(`/ideas/${idea.id}`, { method: 'PATCH', body: { title, body, status } })).idea);
    else applyCreated('idea', 'idea', await api<Created<{ idea: Idea }>>(`/conversations/${cid}/ideas`, { method: 'POST', body: { title, body, source_message_id: source ?? null } }));
    toast(idea ? 'Idea updated' : 'Idea saved 💡');
  }, onClose);
  return (
    <FormModal
      title={idea ? 'Idea' : 'Save an idea'}
      onClose={onClose}
      onSubmit={save.run}
      busy={save.busy}
      submitLabel={idea ? 'Save' : 'Save idea'}
      disabled={!title.trim()}
      extra={
        idea && (
          <button type="button" className="icon-btn danger" onClick={() => setConfirm(true)} aria-label="Delete idea" title="Delete idea">
            <Trash2 size={17} />
          </button>
        )
      }
    >
      <input className="input input-lg" autoFocus placeholder="The idea in one line" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="input" rows={4} placeholder="Why it matters, how it could work…" value={body} onChange={(e) => setBody(e.target.value)} />
      {idea && (
        <Field label="Stage">
          <Segmented
            value={status}
            onChange={setStatus}
            options={[
              { value: 'new', label: 'New' },
              { value: 'exploring', label: 'Exploring' },
              { value: 'accepted', label: 'Accepted' },
              { value: 'parked', label: 'Parked' },
            ]}
          />
        </Field>
      )}
      <Confirm
        open={confirm}
        title="Delete this idea?"
        message="Votes and the card in the chat will be removed."
        onConfirm={async () => {
          try {
            await api(`/ideas/${idea!.id}`, { method: 'DELETE' });
            onClose();
          } catch (e) {
            toastError(e);
          }
        }}
        onClose={() => setConfirm(false)}
      />
    </FormModal>
  );
}

/* ------------------------------------------------------------------ goals */

const UNITS = ['', '$', '৳', '%', 'users', 'customers', 'deals', 'hours', 'km', 'books'];

function GoalForm({ cid, goal, initialTitle, onClose }: { cid: number; goal?: Goal; initialTitle?: string; onClose: () => void }) {
  const { data: me } = useMe();
  const { members } = useMembers(cid);
  const [title, setTitle] = useState(goal?.title ?? initialTitle ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  const [unit, setUnit] = useState(goal?.unit ?? '');
  const [start, setStart] = useState(String(goal?.start_value ?? 0));
  const [target, setTarget] = useState(goal ? String(goal.target_value) : '');
  const [due, setDue] = useState<string | null>(goal?.due_date ?? null);
  const [owner, setOwner] = useState<number | null>(goal?.owner_id ?? me?.id ?? null);
  const [status, setStatus] = useState(goal?.status ?? 'active');
  const [confirm, setConfirm] = useState(false);
  const valid = title.trim() && target !== '' && Number(target) !== Number(start) && Number.isFinite(Number(target));

  const save = useSubmit(async () => {
    const body = { title, description, unit, start_value: Number(start) || 0, target_value: Number(target), due_date: due, owner_id: owner, ...(goal ? { status } : {}) };
    if (goal) applyItem('goal', (await api<{ goal: Goal }>(`/goals/${goal.id}`, { method: 'PATCH', body })).goal);
    else applyCreated('goal', 'goal', await api<Created<{ goal: Goal }>>(`/conversations/${cid}/goals`, { method: 'POST', body }));
    toast(goal ? 'Goal updated' : 'Goal set 🎯');
  }, onClose);

  return (
    <FormModal
      title={goal ? 'Edit goal' : 'Set a goal'}
      onClose={onClose}
      onSubmit={save.run}
      busy={save.busy}
      submitLabel={goal ? 'Save' : 'Set goal'}
      disabled={!valid}
      extra={
        goal && (
          <button type="button" className="icon-btn danger" onClick={() => setConfirm(true)} aria-label="Delete goal" title="Delete goal">
            <Trash2 size={17} />
          </button>
        )
      }
    >
      <input className="input input-lg" autoFocus placeholder="e.g. Reach $15k MRR" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <div className="form-row three">
        <Field label="Start at">
          <input className="input" type="number" inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Target">
          <input className="input" type="number" inputMode="decimal" placeholder="100" value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
        <Field label="Unit">
          <input className="input" list="goal-units" placeholder="$, users…" maxLength={20} value={unit} onChange={(e) => setUnit(e.target.value)} />
          <datalist id="goal-units">
            {UNITS.filter(Boolean).map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </Field>
      </div>
      <Field label="Owner">
        <PeoplePicker members={members} value={owner} onChange={setOwner} meId={me?.id} allowNone={false} />
      </Field>
      <Field label="Deadline">
        <DuePicker value={due} onChange={setDue} />
      </Field>
      <textarea className="input" rows={2} placeholder="Why this goal matters (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      {goal && (
        <Field label="Status">
          <Segmented value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'achieved', label: 'Achieved' }, { value: 'dropped', label: 'Dropped' }]} />
        </Field>
      )}
      <Confirm
        open={confirm}
        title="Delete this goal?"
        message="Its progress history will be lost."
        onConfirm={async () => {
          try {
            await api(`/goals/${goal!.id}`, { method: 'DELETE' });
            onClose();
          } catch (e) {
            toastError(e);
          }
        }}
        onClose={() => setConfirm(false)}
      />
    </FormModal>
  );
}

function GoalProgress({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const [value, setValue] = useState(String(goal.current_value));
  const [note, setNote] = useState('');
  const save = useSubmit(async () => {
    applyItem('goal', (await api<{ goal: Goal }>(`/goals/${goal.id}/progress`, { method: 'POST', body: { value: Number(value), note } })).goal);
    toast('Progress updated 📈');
  }, onClose);
  const preview = { ...goal, current_value: Number(value) || 0 };
  return (
    <FormModal title={`Update “${goal.title}”`} onClose={onClose} onSubmit={save.run} busy={save.busy} submitLabel="Update progress" disabled={value === '' || !Number.isFinite(Number(value))}>
      <div className="goal-preview">
        <div className="goal-numbers">
          <strong>{fmtValue(preview.current_value, goal.unit)}</strong>
          <span className="muted"> / {fmtValue(goal.target_value, goal.unit)}</span>
          <span className="goal-pct">{Math.round(goalProgress(preview) * 100)}%</span>
        </div>
        <Progress value={goalProgress(preview)} height={8} />
      </div>
      <Field label="New value">
        <input className="input input-lg" type="number" inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <input className="input" placeholder="What changed? (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      {goal.updates.length > 0 && (
        <div className="goal-history">
          <h4>History</h4>
          {goal.updates.slice(0, 6).map((u) => (
            <div key={u.id} className="goal-history-row">
              <strong>{fmtValue(u.value, goal.unit)}</strong>
              <span className="muted small">
                {u.user_name} · {fullTime(u.created_at)}
              </span>
              {u.note && <span className="small">{u.note}</span>}
            </div>
          ))}
        </div>
      )}
    </FormModal>
  );
}

/* -------------------------------------------------------------- decisions */

function DecisionForm({ cid, initial, source, onClose }: { cid: number; initial?: { title?: string; context?: string }; source?: number; onClose: () => void }) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [context, setContext] = useState(initial?.context ?? '');
  const save = useSubmit(async () => {
    applyCreated('decision', 'decision', await api<Created<{ decision: Decision }>>(`/conversations/${cid}/decisions`, { method: 'POST', body: { title, context, source_message_id: source ?? null } }));
    toast('Decision recorded ⚖️');
  }, onClose);
  return (
    <FormModal title="Record a decision" onClose={onClose} onSubmit={save.run} busy={save.busy} submitLabel="Record decision" disabled={!title.trim()}>
      <p className="muted small">Decisions go into a shared log so nobody has to scroll back to find “what did we agree?”. Teammates can tap “I agree” to sign off.</p>
      <input className="input input-lg" autoFocus placeholder="We decided to…" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="input" rows={4} placeholder="Why — options considered, trade-offs, when to revisit" value={context} onChange={(e) => setContext(e.target.value)} />
    </FormModal>
  );
}

/* ------------------------------------------------------------------ polls */

function PollForm({ cid, initialQuestion, onClose }: { cid: number; initialQuestion?: string; onClose: () => void }) {
  const [question, setQuestion] = useState(initialQuestion ?? '');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const save = useSubmit(async () => {
    applyCreated('poll', 'poll', await api<Created<{ poll: Poll }>>(`/conversations/${cid}/polls`, { method: 'POST', body: { question, options: filled, multiple } }));
  }, onClose);
  return (
    <FormModal title="Create a poll" onClose={onClose} onSubmit={save.run} busy={save.busy} submitLabel="Start poll" disabled={!question.trim() || filled.length < 2}>
      <input className="input input-lg" autoFocus placeholder="Ask a question" value={question} maxLength={300} onChange={(e) => setQuestion(e.target.value)} />
      <div className="poll-options-edit">
        {options.map((o, i) => (
          <div key={i} className="poll-option-edit">
            <input
              className="input"
              placeholder={`Option ${i + 1}`}
              value={o}
              maxLength={120}
              onChange={(e) => setOptions((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && i === options.length - 1 && o.trim() && options.length < 10) {
                  e.preventDefault();
                  setOptions((l) => [...l, '']);
                }
              }}
            />
            {options.length > 2 && (
              <button type="button" className="icon-btn sm" onClick={() => setOptions((l) => l.filter((_, j) => j !== i))} aria-label="Remove option">
                <X size={15} />
              </button>
            )}
          </div>
        ))}
        {options.length < 10 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOptions((l) => [...l, ''])}>
            <Plus size={15} /> Add option
          </button>
        )}
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> Allow multiple answers
      </label>
    </FormModal>
  );
}

/* --------------------------------------------------------------- check-in */

const MOODS = [
  ['great', '🤩', 'Great'],
  ['good', '🙂', 'Good'],
  ['okay', '😐', 'Okay'],
  ['rough', '😓', 'Rough'],
] as const;
export const moodEmoji = (m: string) => MOODS.find((x) => x[0] === m)?.[1] ?? '🙂';

function CheckinForm({ cid, onClose }: { cid?: number; onClose: () => void }) {
  const { data: me } = useMe();
  const { data: conversations } = useConversations();
  const groups = (conversations ?? []).filter((c) => c.type !== 'self');
  const [target, setTarget] = useState<number | null>(cid ?? null);
  const [done, setDone] = useState('');
  const [doing, setDoing] = useState('');
  const [blockers, setBlockers] = useState('');
  const [mood, setMood] = useState<string>('good');
  useEffect(() => {
    if (!target && groups.length) setTarget(groups.find((g) => g.type === 'group')?.id ?? groups[0].id);
  }, [groups, target]);
  const save = useSubmit(async () => {
    const r = await api<{ message: Parameters<typeof applyMessage>[0] }>(`/conversations/${target}/checkins`, { method: 'POST', body: { done, doing, blockers, mood } });
    applyMessage(r.message, { isNew: true, meId: me?.id });
    toast('Check-in posted ☀️');
  }, onClose);
  return (
    <FormModal title="Daily check-in" onClose={onClose} onSubmit={save.run} busy={save.busy} submitLabel="Post check-in" disabled={!target || !(done.trim() || doing.trim() || blockers.trim())}>
      {!cid && (
        <Field label="Post to">
          <select className="input" value={target ?? ''} onChange={(e) => setTarget(Number(e.target.value))}>
            {groups.map((c) => (
              <option key={c.id} value={c.id}>
                {conversationTitle(c, me?.id)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="How are you feeling?">
        <div className="mood-row">
          {MOODS.map(([value, emoji, label]) => (
            <button key={value} type="button" className={cx('mood', mood === value && 'on')} onClick={() => setMood(value)}>
              <span>{emoji}</span>
              {label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="✅ Done since last check-in">
        <textarea className="input" rows={2} autoFocus value={done} onChange={(e) => setDone(e.target.value)} />
      </Field>
      <Field label="🔨 Working on next">
        <textarea className="input" rows={2} value={doing} onChange={(e) => setDoing(e.target.value)} />
      </Field>
      <Field label="🚧 Blockers / need help with">
        <textarea className="input" rows={2} value={blockers} onChange={(e) => setBlockers(e.target.value)} />
      </Field>
    </FormModal>
  );
}

/* --------------------------------------------------------------- reminder */

function at(hours: number, minutes = 0, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hours, minutes, 0, 0);
  return d;
}
const nextMonday = () => {
  const d = at(9);
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return d;
};
const toLocalInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function ReminderForm({ messageId, initialNote, onClose }: { messageId?: number; initialNote?: string; onClose: () => void }) {
  const presets: [string, () => Date][] = [
    ['In 20 minutes', () => new Date(Date.now() + 20 * 60e3)],
    ['In 1 hour', () => new Date(Date.now() + 3600e3)],
    ['In 3 hours', () => new Date(Date.now() + 3 * 3600e3)],
    ['Tomorrow 9:00', () => at(9, 0, 1)],
    ['Next Monday 9:00', nextMonday],
  ];
  const [when, setWhen] = useState(toLocalInput(new Date(Date.now() + 3600e3)));
  const [note, setNote] = useState(initialNote ?? '');
  const save = useSubmit(async () => {
    await api('/reminders', { method: 'POST', body: { message_id: messageId ?? null, note, remind_at: new Date(when).toISOString() } });
    queryClient.invalidateQueries({ queryKey: ['reminders'] });
    queryClient.invalidateQueries({ queryKey: ['today'] });
    toast(`Reminder set for ${new Date(when).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} ⏰`);
  }, onClose);
  return (
    <FormModal title="Remind me" onClose={onClose} onSubmit={save.run} busy={save.busy} submitLabel="Set reminder" disabled={!when || (!messageId && !note.trim())}>
      <div className="preset-grid">
        {presets.map(([label, fn]) => (
          <button key={label} type="button" className={cx('chip', when === toLocalInput(fn()) && 'on')} onClick={() => setWhen(toLocalInput(fn()))}>
            {label}
          </button>
        ))}
      </div>
      <Field label="Or pick a time">
        <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </Field>
      <input className="input" placeholder={messageId ? 'Add a note (optional)' : 'What should I remind you about?'} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} autoFocus={!messageId} />
      <p className="muted small">You’ll get a notification and the reminder appears in “My space”.</p>
    </FormModal>
  );
}

/* ----------------------------------------------------------- task helpers */

export async function setTaskStatus(task: Task, status: TaskStatus) {
  applyItem('task', { ...task, status, completed_at: status === 'done' ? new Date().toISOString() : null });
  try {
    applyItem('task', (await api<{ task: Task }>(`/tasks/${task.id}`, { method: 'PATCH', body: { status } })).task);
  } catch (e) {
    applyItem('task', task);
    toastError(e);
  }
}

export const dueText = (d: string | null) => (d ? dueLabel(d) : '');
