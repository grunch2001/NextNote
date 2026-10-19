import { create } from 'zustand';
import { X } from 'lucide-react';

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run(): void };
}

const useToasts = create<{ list: Toast[] }>(() => ({ list: [] }));
let seq = 0;

export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms = 5000) {
  const id = ++seq;
  useToasts.setState((s) => ({ list: [...s.list.slice(-3), { id, text, kind, action }] }));
  setTimeout(() => dismiss(id), ms);
}

function dismiss(id: number) {
  useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) }));
}

export function Toasts() {
  const list = useToasts((s) => s.list);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.action?.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="icon-btn small" onClick={() => dismiss(t.id)} aria-label="Schließen">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
