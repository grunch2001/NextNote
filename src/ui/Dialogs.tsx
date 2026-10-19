import { useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { X } from 'lucide-react';

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  className,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`dialog${wide ? ' wide' : ''}${className ? ' ' + className : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Schließen">
            <X size={18} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- imperative prompt / confirm

type Pending =
  | { kind: 'prompt'; title: string; label: string; value: string; ok: string; resolve(v: string | null): void }
  | { kind: 'confirm'; title: string; message: string; ok: string; danger: boolean; resolve(v: boolean): void };

const useDialogs = create<{ current: Pending | null }>(() => ({ current: null }));

export function promptDialog(opts: { title: string; label?: string; value?: string; ok?: string }): Promise<string | null> {
  return new Promise((resolve) =>
    useDialogs.setState({ current: { kind: 'prompt', title: opts.title, label: opts.label ?? '', value: opts.value ?? '', ok: opts.ok ?? 'OK', resolve } }),
  );
}

export function confirmDialog(opts: { title: string; message: string; ok?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) =>
    useDialogs.setState({
      current: { kind: 'confirm', title: opts.title, message: opts.message, ok: opts.ok ?? 'OK', danger: !!opts.danger, resolve },
    }),
  );
}

function PromptBody({ p }: { p: Extract<Pending, { kind: 'prompt' }> }) {
  const [value, setValue] = useState(p.value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const close = (v: string | null) => {
    useDialogs.setState({ current: null });
    p.resolve(v);
  };
  return (
    <Modal
      title={p.title}
      onClose={() => close(null)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            Abbrechen
          </button>
          <button type="button" className="btn primary" onClick={() => close(value)}>
            {p.ok}
          </button>
        </>
      }
    >
      <label className="field">
        {p.label && <span>{p.label}</span>}
        <input
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') close(value);
          }}
        />
      </label>
    </Modal>
  );
}

function ConfirmBody({ p }: { p: Extract<Pending, { kind: 'confirm' }> }) {
  const close = (v: boolean) => {
    useDialogs.setState({ current: null });
    p.resolve(v);
  };
  return (
    <Modal
      title={p.title}
      onClose={() => close(false)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(false)}>
            Abbrechen
          </button>
          <button type="button" className={`btn ${p.danger ? 'danger' : 'primary'}`} onClick={() => close(true)} autoFocus>
            {p.ok}
          </button>
        </>
      }
    >
      <p className="confirm-text">{p.message}</p>
    </Modal>
  );
}

export function DialogHost() {
  const current = useDialogs((s) => s.current);
  if (!current) return null;
  return current.kind === 'prompt' ? <PromptBody p={current} /> : <ConfirmBody p={current} />;
}

// ---------------------------------------------------------------- context menu

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** Renders a row of colour swatches instead of a button. */
  swatches?: { colors: string[]; current?: string; apply(color: string): void };
  run?(): void;
}

const useMenu = create<{ menu: { x: number; y: number; items: MenuItem[] } | null }>(() => ({ menu: null }));

export function openMenu(x: number, y: number, items: MenuItem[]) {
  useMenu.setState({ menu: { x, y, items } });
}

export function openMenuAt(el: Element, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  openMenu(r.left, r.bottom + 2, items);
}

export function MenuHost() {
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    setPos(null);
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      useMenu.setState({ menu: null });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useMenu.setState({ menu: null });
    };
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', close, true);
      window.addEventListener('resize', close);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);
  useEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8));
    const y = menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height - 4) : menu.y;
    setPos({ x, y });
  }, [menu]);
  if (!menu) return null;
  return (
    <div ref={ref} className="context-menu popover" role="menu" style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}>
      {menu.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : it.swatches ? (
          <div key={i} className="menu-swatches" aria-label={it.label}>
            <span className="menu-swatches-label">{it.label}</span>
            <div className="swatch-grid">
              {it.swatches.colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch${it.swatches?.current === c ? ' current' : ''}`}
                  style={{ background: c }}
                  aria-label={c}
                  onClick={() => {
                    useMenu.setState({ menu: null });
                    it.swatches?.apply(c);
                  }}
                />
              ))}
            </div>
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              useMenu.setState({ menu: null });
              it.run?.();
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

/** Long press (touch) or right click opens a context menu. */
export function useContextMenu(items: () => MenuItem[]) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, items());
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      start.current = { x: e.clientX, y: e.clientY };
      const { clientX, clientY } = e;
      timer.current = setTimeout(() => {
        timer.current = null;
        openMenu(clientX, clientY, items());
      }, 520);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (timer.current && start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    },
    onPointerUp: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
  };
}
