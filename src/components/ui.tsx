import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { fileUrl } from '../lib/api';
import { cx, initials } from '../lib/format';
import { pushOverlay } from '../lib/platform';
import { useOnline } from '../lib/store';
import type { ConversationLabel } from '../lib/types';

/* -------------------------------------------------------------------- brand */

export function Logo({ size = 32 }: { size?: number }) {
  // Unique gradient id per instance: a gradient defined inside a hidden copy would not paint.
  const gid = `kz-g-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14b8a6" />
          <stop offset="1" stopColor="#0f766e" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${gid})`} />
      <circle cx="25.5" cy="32" r="11" fill="none" stroke="#fff" strokeWidth="5" />
      <circle cx="38.5" cy="32" r="11" fill="none" stroke="#99f6e4" strokeWidth="5" />
      <path d="M32 22.7a11 11 0 0 1 0 18.6" fill="none" stroke="#fff" strokeWidth="5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ avatars */

type AvatarUser = { id?: number; name: string | null; color?: string | null; avatar?: string | null };

export function Avatar({ user, size = 36, presence, className }: { user?: AvatarUser | null; size?: number; presence?: boolean; className?: string }) {
  const online = useOnline(presence ? user?.id : null);
  const [broken, setBroken] = useState(false);
  const style: CSSProperties = { width: size, height: size, fontSize: Math.max(10, size * 0.38), background: user?.color ?? '#64748b' };
  return (
    <span className={cx('avatar-wrap', className)} style={{ width: size, height: size }}>
      {user?.avatar && !broken ? (
        <img className="avatar" src={fileUrl(user.avatar)} alt="" style={style} onError={() => setBroken(true)} />
      ) : (
        <span className="avatar" style={style}>
          {initials(user?.name)}
        </span>
      )}
      {presence && online && <span className="presence-dot" style={{ width: Math.max(9, size * 0.28), height: Math.max(9, size * 0.28) }} />}
    </span>
  );
}

export function ConvAvatar({ label, size = 44, members, meId }: { label: ConversationLabel & { type: string }; size?: number; members?: AvatarUser[]; meId?: number }) {
  if (label.type === 'direct') {
    const other = members?.find((m) => m.id !== meId) ?? { name: label.name, color: label.color, avatar: label.avatar };
    return <Avatar user={other} size={size} presence />;
  }
  return (
    <span className={cx('conv-avatar', label.type === 'self' && 'self')} style={{ width: size, height: size, background: label.color, fontSize: size * 0.48 }}>
      {label.emoji || initials(label.name)}
    </span>
  );
}

export function AvatarStack({ users, max = 4, size = 22 }: { users: AvatarUser[]; max?: number; size?: number }) {
  return (
    <span className="avatar-stack">
      {users.slice(0, max).map((u, i) => (
        <Avatar key={u.id ?? i} user={u} size={size} />
      ))}
      {users.length > max && (
        <span className="avatar more" style={{ width: size, height: size, fontSize: size * 0.42 }}>
          +{users.length - max}
        </span>
      )}
    </span>
  );
}

/* -------------------------------------------------------------- primitives */

export const Spinner = ({ size = 18 }: { size?: number }) => <span className="spinner" style={{ width: size, height: size }} />;

export const Loader = () => (
  <div className="loader">
    <Spinner size={22} />
  </div>
);

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx('segmented', className)} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={cx(o.value === value && 'active')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="toggle">
      <span className="toggle-label">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}

export function Check3({ checked, onChange, label, size = 20 }: { checked: boolean; onChange: () => void; label: string; size?: number }) {
  return (
    <button
      type="button"
      className={cx('task-check', checked && 'checked')}
      style={{ width: size, height: size }}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      aria-label={label}
      aria-pressed={checked}
    >
      {checked && <Check size={size * 0.65} strokeWidth={3.2} />}
    </button>
  );
}

export function Progress({ value, color, height = 6 }: { value: number; color?: string; height?: number }) {
  return (
    <div className="progress" style={{ height }} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${Math.round(value * 100)}%`, background: color }} />
    </div>
  );
}

/* ------------------------------------------------------- modal / sheet */

const useOverlay = (open: boolean, onClose: () => void) => {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const pop = pushOverlay(() => close.current());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.popover') && !(e.target as HTMLElement).closest?.('.popover')) return;
      e.stopPropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      pop();
      window.removeEventListener('keydown', onKey);
      // Hide the phone keyboard when a sheet closes (the focused input is going away).
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest('.modal, .popover')) active.blur();
    };
  }, [open]);
};

/** Centered dialog on desktop, bottom sheet on phones. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}) {
  useOverlay(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', className)} style={{ maxWidth: width }} role="dialog" aria-modal="true">
        <div className="sheet-grip" aria-hidden="true" />
        {title && (
          <div className="modal-header">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={19} />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ open, title, message, confirm = 'Delete', onConfirm, onClose, danger = true }: { open: boolean; title: string; message: ReactNode; confirm?: string; onConfirm: () => void; onClose: () => void; danger?: boolean }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={400}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={cx('btn', danger ? 'btn-danger' : 'btn-primary')}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirm}
          </button>
        </>
      }
    >
      <p className="muted">{message}</p>
    </Modal>
  );
}

/* ---------------------------------------------------------------- popover */

export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'start',
  placement = 'bottom',
  className,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  placement?: 'bottom' | 'top';
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useOverlay(open, onClose);

  useLayoutEffect(() => {
    if (!open || !anchor || !panel.current) return;
    const place = () => {
      if (!panel.current) return;
      const a = anchor.getBoundingClientRect();
      const p = panel.current.getBoundingClientRect();
      let top = placement === 'top' ? a.top - p.height - 6 : a.bottom + 6;
      if (top + p.height > innerHeight - 8) top = a.top - p.height - 6;
      if (top < 8) top = Math.min(a.bottom + 6, innerHeight - p.height - 8);
      let left = align === 'end' ? a.right - p.width : a.left;
      left = Math.max(8, Math.min(left, innerWidth - p.width - 8));
      setStyle({ top, left, visibility: 'visible' });
    };
    place();
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [open, anchor, align, placement]);

  useEffect(() => {
    if (!open) return setStyle({ visibility: 'hidden' });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, anchor, onClose]);

  if (!open) return null;
  return createPortal(
    <div className={cx('popover', className)} ref={panel} style={style}>
      {children}
    </div>,
    document.body,
  );
}

/** A button that toggles a popover; children receive a `close` callback. */
export function PopoverButton({
  button,
  children,
  align,
  placement,
  className,
  title,
  btnClass = 'icon-btn',
}: {
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  placement?: 'bottom' | 'top';
  className?: string;
  title?: string;
  btnClass?: string;
}) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" ref={setEl} className={btnClass} onClick={() => setOpen((o) => !o)} title={title} aria-label={title} aria-expanded={open}>
        {button}
      </button>
      <Popover anchor={el} open={open} onClose={close} align={align} placement={placement} className={className}>
        {children(close)}
      </Popover>
    </>
  );
}

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

export function MenuList({ items, close }: { items: (MenuAction | 'divider')[]; close: () => void }) {
  return (
    <div className="menu" role="menu">
      {items
        .filter((i) => i === 'divider' || !i.hidden)
        .map((it, i) =>
          it === 'divider' ? (
            <div key={i} className="menu-divider" />
          ) : (
            <button
              key={it.label}
              role="menuitem"
              className={cx('menu-item', it.danger && 'danger')}
              onClick={() => {
                close();
                it.onSelect();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ),
        )}
    </div>
  );
}

/* ------------------------------------------------------------------ emoji */

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '✅', '🙏'];
export const EMOJI = [
  '😀', '😄', '😁', '😅', '😂', '🤣', '😊', '🙂', '😉', '😍', '🥰', '😎', '🤩', '🤔', '🤨', '😐', '😴', '😮', '😢', '😭', '😤', '😡', '🤯', '🥳',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '🤝', '✌️', '👌', '👋', '🫡', '🤞', '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '✨', '⭐', '🎉', '🎯', '🚀',
  '💡', '📈', '📉', '💰', '💸', '🧠', '⚡', '✅', '❌', '⚠️', '❓', '❗', '👀', '⏰', '📌', '📎', '📅', '☕', '🍕', '🌴',
];

export function EmojiGrid({ onPick }: { onPick: (e: string) => void }) {
  return (
    <div className="emoji-grid">
      {EMOJI.map((e) => (
        <button key={e} type="button" onClick={() => onPick(e)} aria-label={`Emoji ${e}`}>
          {e}
        </button>
      ))}
    </div>
  );
}

export const SWATCHES = ['#0d9488', '#0284c7', '#6366f1', '#7c3aed', '#db2777', '#e11d48', '#ea580c', '#d97706', '#16a34a', '#475569'];

export function Swatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="swatches">
      {SWATCHES.map((c) => (
        <button type="button" key={c} className={cx('swatch', c === value && 'selected')} style={{ background: c }} onClick={() => onChange(c)} aria-label={`Color ${c}`}>
          {c === value && <Check size={13} strokeWidth={3} color="#fff" />}
        </button>
      ))}
    </div>
  );
}

/** Long-press detection for touch devices (opens message actions). */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onTouchStart: (e: React.TouchEvent) => {
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      clear();
      timer.current = setTimeout(() => {
        navigator.vibrate?.(15);
        onLongPress();
      }, ms);
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (!start.current) return;
      const dx = Math.abs(e.touches[0].clientX - start.current.x);
      const dy = Math.abs(e.touches[0].clientY - start.current.y);
      if (dx > 8 || dy > 8) clear();
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
  };
}
