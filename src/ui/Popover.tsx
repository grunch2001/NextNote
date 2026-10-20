import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** A small floating panel anchored below an element. */
export function Popover({ anchor, onClose, children, className }: { anchor: HTMLElement | null; onClose(): void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      let left = a.left;
      if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
      let top = a.bottom + 4;
      if (top + r.height > window.innerHeight - 8) {
        const above = a.top - r.height - 4;
        top = above >= 8 ? above : Math.max(8, window.innerHeight - r.height - 8);
      }
      setPos({ left, top });
    };
    place();
    // content can grow while open (e.g. the colour picker unfolds)
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onResize = () => {
      // the on-screen keyboard resizes the window when a field inside the popover is focused
      if (!ref.current?.contains(document.activeElement)) onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`popover${className ? ' ' + className : ''}`}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseDown={(e) => {
        if (!(e.target as Element).closest('input, select, textarea')) e.preventDefault();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function usePopover() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return {
    anchor,
    open: !!anchor,
    toggle: (el: HTMLElement) => setAnchor((a) => (a ? null : el)),
    close: () => setAnchor(null),
  };
}
