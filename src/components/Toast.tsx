import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleCheck, Info, TriangleAlert, X } from 'lucide-react';

type Kind = 'success' | 'error' | 'info';
interface Item {
  id: number;
  message: ReactNode;
  kind: Kind;
  to?: string;
}

let seq = 0;
let items: Item[] = [];
const subs = new Set<(i: Item[]) => void>();
const emit = () => subs.forEach((s) => s(items));

export function toast(message: ReactNode, kind: Kind = 'success', to?: string) {
  const id = ++seq;
  items = [...items.slice(-2), { id, message, kind, to }];
  emit();
  setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 4000);
}
const dismiss = (id: number) => {
  items = items.filter((t) => t.id !== id);
  emit();
};

export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong', 'error');

export function Toaster() {
  const [list, setList] = useState(items);
  const navigate = useNavigate();
  useEffect(() => {
    subs.add(setList);
    return () => void subs.delete(setList);
  }, []);
  const Icon = { success: CircleCheck, error: TriangleAlert, info: Info };
  return (
    <div className="toaster" role="status" aria-live="polite">
      {list.map((t) => {
        const I = Icon[t.kind];
        return (
          <div
            key={t.id}
            className={`toast toast-${t.kind} ${t.to ? 'clickable' : ''}`}
            onClick={() => {
              if (t.to) {
                navigate(t.to);
                dismiss(t.id);
              }
            }}
          >
            <I size={17} />
            <div className="toast-msg">{t.message}</div>
            <button
              className="icon-btn sm"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
              }}
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
