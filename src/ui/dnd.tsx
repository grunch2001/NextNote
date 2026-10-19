import { create } from 'zustand';
import type { ID } from '../model/types';

export type DragKind = 'page' | 'section' | 'notebook';

export interface DragPayload {
  kind: DragKind;
  id: ID;
  label: string;
}

export interface DropTarget {
  kind: DragKind;
  id: ID;
  /** Drop before (true) or after (false) the target; undefined = into it. */
  before?: boolean;
}

interface DndState {
  payload: DragPayload | null;
  x: number;
  y: number;
  target: DropTarget | null;
}

export const useDnd = create<DndState>(() => ({ payload: null, x: 0, y: 0, target: null }));

type DropHandler = (payload: DragPayload, target: DropTarget) => void;

/** Which drop targets accept which payloads. */
function accepts(payload: DragPayload, kind: DragKind): boolean {
  if (payload.kind === 'page') return kind === 'page' || kind === 'section';
  if (payload.kind === 'section') return kind === 'section' || kind === 'notebook';
  return kind === 'notebook';
}

function findTarget(payload: DragPayload, x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-kind]');
  if (!el) return null;
  const kind = el.dataset.dropKind as DragKind;
  const id = el.dataset.dropId as ID;
  if (!accepts(payload, kind) || (kind === payload.kind && id === payload.id)) return null;
  const r = el.getBoundingClientRect();
  if (kind === payload.kind) return { kind, id, before: y < r.top + r.height / 2 };
  return { kind, id };
}

/**
 * Starts a drag on pointer down. Mouse drags start after a few pixels,
 * touch/pen drags only from elements with the `drag-handle` class.
 */
export function beginDrag(e: React.PointerEvent, payload: DragPayload, onDrop: DropHandler) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const fromHandle = !!(e.target as Element).closest('.drag-handle');
  if (e.pointerType !== 'mouse' && !fromHandle) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const el = e.currentTarget as HTMLElement;
  const pointerId = e.pointerId;
  let active = false;
  if (fromHandle) {
    e.preventDefault();
    el.setPointerCapture(pointerId);
  }
  const start = () => {
    active = true;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // ignore
    }
    useDnd.setState({ payload, x: sx, y: sy, target: null });
  };
  if (fromHandle) start();
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!active) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      start();
    }
    useDnd.setState({ x: ev.clientX, y: ev.clientY, target: findTarget(payload, ev.clientX, ev.clientY) });
  };
  const finish = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', finish);
    el.removeEventListener('pointercancel', cancel);
    if (!active) return;
    const target = findTarget(payload, ev.clientX, ev.clientY);
    useDnd.setState({ payload: null, target: null });
    if (target) onDrop(payload, target);
    // swallow the click that follows a drag
    const swallow = (ce: MouseEvent) => {
      ce.stopPropagation();
      ce.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50);
  };
  const cancel = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', finish);
    el.removeEventListener('pointercancel', cancel);
    if (active) useDnd.setState({ payload: null, target: null });
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', cancel);
}

export function dropClass(kind: DragKind, id: ID, target: DropTarget | null): string {
  if (!target || target.kind !== kind || target.id !== id) return '';
  if (target.before === undefined) return ' drop-into';
  return target.before ? ' drop-before' : ' drop-after';
}

export function DragGhost() {
  const { payload, x, y } = useDnd();
  if (!payload) return null;
  return (
    <div className="drag-ghost" style={{ left: x + 12, top: y + 8 }}>
      {payload.label}
    </div>
  );
}
