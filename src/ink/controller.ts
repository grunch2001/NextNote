import { flushSync } from 'react-dom';
import { editorsById, getActiveEditor, setLastInputKind } from '../editor/active';
import type { ID, InkElement, PageElement, ShapeKind } from '../model/types';
import { newId, now } from '../model/util';
import { measured, pageActions, usePage } from '../state/page';
import { useSettings } from '../state/settings';
import { INK_TOOLS, useUI, type Tool } from '../state/ui';
import { eraseFromStroke, elementsInLasso, elementsInRect, strokeHit, topmostStrokeAt } from './geometry';
import { displayInkColor, freehandOutline, HIGHLIGHTER_OPACITY, inkGeometry, outlineToPath, polylinePath } from './render';

export interface ControllerDeps {
  scroller: HTMLDivElement;
  page: HTMLDivElement;
  canvas: HTMLCanvasElement;
  isDark(): boolean;
  createTextAt(x: number, y: number): void;
  /** Long press with the finger or right click on the page (client coordinates). */
  onPageMenu(clientX: number, clientY: number): void;
}

type DrawGesture = {
  kind: 'draw';
  pointerId: number;
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  sim: boolean;
  pts: number[];
  predicted: number[];
  tapAsClick: boolean;
  sx: number;
  sy: number;
  t0: number;
  moved: number;
};

type Gesture =
  | DrawGesture
  | { kind: 'shape'; pointerId: number; shape: Exclude<ShapeKind, 'poly'>; color: string; size: number; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'erase'; pointerId: number; x: number; y: number; r: number; mode: 'stroke' | 'point' }
  | { kind: 'lasso'; pointerId: number; pts: number[] }
  | { kind: 'rect'; pointerId: number; x0: number; y0: number; x1: number; y1: number; started: boolean; cx0: number; cy0: number }
  | { kind: 'move'; pointerId: number; cx0: number; cy0: number }
  | { kind: 'mpan'; pointerId: number; lx: number; ly: number };

interface TouchPt {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
  target: Element;
}

const PALM_MS = 700;
/** The S Pen counts as "in use" this long after its last event (hover included). */
const PEN_NEAR_MS = 1500;
const TAP_SLOP = 9;
const LONG_PRESS_MS = 520;
/** Chrome predicts up to 25 ms ahead, which overshoots in curves and snaps back; use only the near future. */
const PREDICT_MS = 12;
const PREDICT_MAX = 4;
/** A desynchronized canvas reaches the screen before the page; keep finished strokes on it this long. */
const HANDOFF_HOLD_MS = 120;
/** Never wait longer than this for the SVG version of a finished stroke. */
const HANDOFF_MAX_MS = 1000;

const isTextTarget = (t: Element) => !!t.closest('.text-container .ProseMirror, input, textarea, select, [contenteditable="true"]');
const isOwnPointer = (t: Element) => !!t.closest('[data-own-pointer], button, a[href]');

export class CanvasController {
  private gesture: Gesture | null = null;
  private touches = new Map<number, TouchPt>();
  private touchMode: 'idle' | 'pending' | 'pan' | 'pinch' = 'idle';
  private pinch0: { dist: number; zoom: number; px: number; py: number } | null = null;
  private lastPan = { x: 0, y: 0, t: 0 };
  private velocity = { x: 0, y: 0 };
  private inertiaRaf = 0;
  private renderRaf = 0;
  private lastPenTime = -1e9;
  private penDown = false;
  private rejectedUntil = 0;
  private suppressMouseUntil = 0;
  private hover: { x: number; y: number } | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;
  private lastLongPress = -1e9;
  private ctx: CanvasRenderingContext2D;
  private desync: boolean;
  /** Finished strokes that stay on the canvas until their SVG version is on screen (shown: time it appeared in the DOM). */
  private handoff: { el: InkElement; t0: number; shown: number }[] = [];

  constructor(private d: ControllerDeps) {
    const lowLatency = useSettings.getState().inkLowLatency;
    this.ctx = ((lowLatency && d.canvas.getContext('2d', { desynchronized: true })) || d.canvas.getContext('2d')) as CanvasRenderingContext2D;
    this.desync = lowLatency && !!this.ctx.getContextAttributes?.().desynchronized;
    const s = d.scroller;
    s.addEventListener('pointerdown', this.onDown, { capture: true });
    s.addEventListener('pointermove', this.onMove);
    s.addEventListener('pointerup', this.onUp);
    s.addEventListener('pointercancel', this.onCancel);
    s.addEventListener('pointerleave', this.onLeave);
    s.addEventListener('wheel', this.onWheel, { passive: false });
    s.addEventListener('click', this.onClickCapture, { capture: true });
    s.addEventListener('mousedown', this.onMouseDownCapture, { capture: true });
    s.addEventListener('contextmenu', this.onContextMenu);
  }

  destroy() {
    const s = this.d.scroller;
    s.removeEventListener('pointerdown', this.onDown, { capture: true });
    s.removeEventListener('pointermove', this.onMove);
    s.removeEventListener('pointerup', this.onUp);
    s.removeEventListener('pointercancel', this.onCancel);
    s.removeEventListener('pointerleave', this.onLeave);
    s.removeEventListener('wheel', this.onWheel);
    s.removeEventListener('click', this.onClickCapture, { capture: true });
    s.removeEventListener('mousedown', this.onMouseDownCapture, { capture: true });
    s.removeEventListener('contextmenu', this.onContextMenu);
    cancelAnimationFrame(this.inertiaRaf);
    cancelAnimationFrame(this.renderRaf);
    this.cancelLongPress();
  }

  private cancelLongPress() {
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
  }

  private get zoom() {
    return useUI.getState().zoom;
  }

  private penNear() {
    return this.penDown || performance.now() - this.lastPenTime < PEN_NEAR_MS;
  }

  toPage(cx: number, cy: number) {
    const r = this.d.page.getBoundingClientRect();
    const z = this.zoom;
    return { x: (cx - r.left) / z, y: (cy - r.top) / z };
  }

  private elements(): PageElement[] {
    return Object.values(usePage.getState().elements);
  }

  private blurEditor() {
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && this.d.scroller.contains(a)) a.blur();
  }

  // ------------------------------------------------------------------ pointer down

  private onDown = (e: PointerEvent) => {
    const isPen = e.pointerType === 'pen';
    const isTouch = e.pointerType === 'touch';
    if (isPen) {
      this.lastPenTime = performance.now();
      this.penDown = true;
      this.stopInertia();
      this.cancelLongPress(); // a resting hand is not a long press
    }
    if (isTouch && (this.penDown || performance.now() - this.lastPenTime < PALM_MS)) {
      // palm rejection
      this.rejectedUntil = performance.now() + 600;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const target = e.target as Element;
    if (isOwnPointer(target)) return;
    const ui = useUI.getState();
    const st = useSettings.getState();
    let tool: Tool | 'pen-auto' = ui.tool;
    // On Android the app passes strokes with the S Pen side button held as the eraser end (buttons 32)
    if (isPen && ((e.buttons & 32) !== 0 || e.button === 5 || (st.penButtonErases && (e.buttons & 2) !== 0))) tool = 'eraser';
    else if (isPen && tool === 'select' && st.penAlwaysDraws && !target.closest('.ProseMirror-focused, input, textarea, select')) tool = 'pen-auto';

    if (isTouch && !(INK_TOOLS.has(tool as Tool) && st.drawWithFinger)) {
      this.touchDown(e);
      return;
    }
    if (this.gesture) return; // one pointer at a time
    if (e.pointerType === 'mouse' && e.button === 1) {
      e.preventDefault();
      this.capture(e);
      this.gesture = { kind: 'mpan', pointerId: e.pointerId, lx: e.clientX, ly: e.clientY };
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    switch (tool) {
      case 'pen':
      case 'highlighter':
        this.startDraw(e, tool, false);
        return;
      case 'pen-auto':
        this.startDraw(e, 'pen', true);
        return;
      case 'eraser':
        this.startErase(e);
        return;
      case 'lasso':
        e.preventDefault();
        this.capture(e);
        this.blurEditor();
        pageActions.clearSelection();
        {
          const p = this.toPage(e.clientX, e.clientY);
          this.gesture = { kind: 'lasso', pointerId: e.pointerId, pts: [p.x, p.y] };
        }
        this.scheduleRender();
        return;
      case 'shape': {
        e.preventDefault();
        this.capture(e);
        this.blurEditor();
        pageActions.clearSelection();
        const p = this.toPage(e.clientX, e.clientY);
        const pen = ui.pens[ui.penIndex];
        this.gesture = { kind: 'shape', pointerId: e.pointerId, shape: ui.shape, color: pen.color, size: pen.size, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        return;
      }
      case 'select':
        this.selectDown(e, target);
        return;
    }
  };

  private capture(e: PointerEvent) {
    try {
      this.d.scroller.setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone
    }
  }

  private selectDown(e: PointerEvent, target: Element) {
    if (isTextTarget(target)) {
      pageActions.clearSelection();
      return;
    }
    const p = this.toPage(e.clientX, e.clientY);
    const imgEl = target.closest<HTMLElement>('.image-el');
    const sel = usePage.getState().selection;
    if (imgEl?.dataset.el) {
      e.preventDefault();
      this.blurEditor();
      const id = imgEl.dataset.el;
      if (!sel.includes(id)) pageActions.select([id]);
      this.startMove(e);
      return;
    }
    const stroke = topmostStrokeAt(this.elements(), p.x, p.y, 6 / this.zoom);
    if (stroke) {
      e.preventDefault();
      this.blurEditor();
      if (!sel.includes(stroke.id)) pageActions.select([stroke.id]);
      this.startMove(e);
      return;
    }
    if (target.closest('.text-container')) return; // grip/border area of a text box
    e.preventDefault();
    this.blurEditor();
    this.capture(e);
    this.gesture = { kind: 'rect', pointerId: e.pointerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y, started: false, cx0: e.clientX, cy0: e.clientY };
  }

  /** Starts dragging the current selection. */
  startMove(e: PointerEvent) {
    this.capture(e);
    this.gesture = { kind: 'move', pointerId: e.pointerId, cx0: e.clientX, cy0: e.clientY };
    pageActions.setDrag({ dx: 0, dy: 0, s: 1, ox: 0, oy: 0 });
  }

  private pressureOf(e: PointerEvent): number {
    if (e.pointerType !== 'pen') return 0.5;
    return e.pressure > 0 ? Math.round(e.pressure * 100) / 100 : 0.5;
  }

  private startDraw(e: PointerEvent, tool: 'pen' | 'highlighter', tapAsClick: boolean) {
    e.preventDefault();
    e.stopPropagation();
    this.capture(e);
    if (!tapAsClick) this.blurEditor();
    pageActions.clearSelection();
    const ui = useUI.getState();
    const st = useSettings.getState();
    const preset = tool === 'pen' ? ui.pens[ui.penIndex] : ui.highlighters[ui.highlighterIndex];
    const p = this.toPage(e.clientX, e.clientY);
    this.gesture = {
      kind: 'draw',
      pointerId: e.pointerId,
      tool,
      color: preset.color,
      size: preset.size,
      sim: !(e.pointerType === 'pen' && st.pressure),
      pts: [p.x, p.y, this.pressureOf(e)],
      predicted: [],
      tapAsClick,
      sx: e.clientX,
      sy: e.clientY,
      t0: e.timeStamp,
      moved: 0,
    };
    this.scheduleRender();
  }

  private startErase(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.capture(e);
    this.blurEditor();
    pageActions.clearSelection();
    const ui = useUI.getState();
    const p = this.toPage(e.clientX, e.clientY);
    pageActions.beginBatch();
    this.gesture = { kind: 'erase', pointerId: e.pointerId, x: p.x, y: p.y, r: ui.eraserSize / 2 / this.zoom, mode: ui.eraserMode };
    this.eraseAt(p.x, p.y, p.x, p.y);
    this.scheduleRender();
  }

  private eraseAt(x0: number, y0: number, x1: number, y1: number) {
    const g = this.gesture;
    if (!g || g.kind !== 'erase') return;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (g.r / 2)));
    for (let i = 1; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * i) / steps;
      const strokes = this.elements().filter((el): el is InkElement => el.type === 'ink');
      if (g.mode === 'stroke') {
        const hit = strokes.filter((s) => strokeHit(s, x, y, g.r)).map((s) => s.id);
        if (hit.length) pageActions.remove(hit);
      } else {
        const snap: Record<ID, PageElement | null> = {};
        for (const s of strokes) {
          const pieces = eraseFromStroke(s, x, y, g.r);
          if (!pieces) continue;
          snap[s.id] = null;
          for (const piece of pieces) snap[piece.id] = piece;
        }
        if (Object.keys(snap).length) pageActions.replace(snap);
      }
    }
  }

  // ------------------------------------------------------------------ move / up

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'pen') {
      this.lastPenTime = performance.now();
      this.cancelLongPress();
      const ui = useUI.getState();
      if (!this.gesture && ui.tool === 'eraser') {
        this.hover = this.toPage(e.clientX, e.clientY);
        this.scheduleRender();
      }
    }
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touchMove(e);
      return;
    }
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    switch (g.kind) {
      case 'draw': {
        const list = e.getCoalescedEvents?.() ?? [];
        const events = list.length ? list : [e];
        const minDist = 0.35 / this.zoom;
        for (const ev of events) {
          const p = this.toPage(ev.clientX, ev.clientY);
          const n = g.pts.length;
          if (Math.hypot(p.x - g.pts[n - 3], p.y - g.pts[n - 2]) < minDist) continue;
          g.pts.push(p.x, p.y, this.pressureOf(ev));
        }
        g.moved = Math.max(g.moved, Math.hypot(e.clientX - g.sx, e.clientY - g.sy));
        g.predicted = this.prediction(e, events[events.length - 1], g);
        this.scheduleRender();
        return;
      }
      case 'erase': {
        const p = this.toPage(e.clientX, e.clientY);
        this.eraseAt(g.x, g.y, p.x, p.y);
        g.x = p.x;
        g.y = p.y;
        this.scheduleRender();
        return;
      }
      case 'lasso': {
        const p = this.toPage(e.clientX, e.clientY);
        g.pts.push(p.x, p.y);
        this.scheduleRender();
        return;
      }
      case 'shape': {
        const p = this.toPage(e.clientX, e.clientY);
        let { x, y } = p;
        if (g.shape === 'line' || g.shape === 'arrow') {
          // snap to 0/45/90 degrees
          const ang = Math.atan2(y - g.y0, x - g.x0);
          const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
          if (Math.abs(ang - snapped) < 0.08 || e.shiftKey) {
            const len = Math.hypot(x - g.x0, y - g.y0);
            x = g.x0 + len * Math.cos(snapped);
            y = g.y0 + len * Math.sin(snapped);
          }
        } else if (e.shiftKey) {
          const s = Math.max(Math.abs(x - g.x0), Math.abs(y - g.y0));
          x = g.x0 + s * Math.sign(x - g.x0 || 1);
          y = g.y0 + s * Math.sign(y - g.y0 || 1);
        }
        g.x1 = x;
        g.y1 = y;
        this.scheduleRender();
        return;
      }
      case 'rect': {
        const p = this.toPage(e.clientX, e.clientY);
        g.x1 = p.x;
        g.y1 = p.y;
        if (!g.started && Math.hypot(e.clientX - g.cx0, e.clientY - g.cy0) > 4) g.started = true;
        this.scheduleRender();
        return;
      }
      case 'move': {
        const z = this.zoom;
        pageActions.setDrag({ dx: (e.clientX - g.cx0) / z, dy: (e.clientY - g.cy0) / z, s: 1, ox: 0, oy: 0 });
        return;
      }
      case 'mpan': {
        this.d.scroller.scrollLeft -= e.clientX - g.lx;
        this.d.scroller.scrollTop -= e.clientY - g.ly;
        g.lx = e.clientX;
        g.ly = e.clientY;
        return;
      }
    }
  };

  /** Predicted continuation of the live stroke (hides input latency), see the inkPrediction setting. */
  private prediction(e: PointerEvent, last: PointerEvent, g: DrawGesture): number[] {
    const mode = useSettings.getState().inkPrediction;
    const list = mode === 'off' ? [] : (e.getPredictedEvents?.() ?? []);
    const out: number[] = [];
    if (mode === 'full') {
      for (const ev of list) {
        const p = this.toPage(ev.clientX, ev.clientY);
        out.push(p.x, p.y, this.pressureOf(ev));
      }
      return out;
    }
    const n = g.pts.length;
    if (!list.length || n < 6) return out;
    // direction of the last few page units of the stroke
    const lx = g.pts[n - 3];
    const ly = g.pts[n - 2];
    let i = n - 6;
    while (i > 0 && Math.hypot(lx - g.pts[i], ly - g.pts[i + 1]) < 3 / this.zoom) i -= 3;
    const dx = lx - g.pts[i];
    const dy = ly - g.pts[i + 1];
    const dl = Math.hypot(dx, dy);
    for (const ev of list) {
      if (ev.timeStamp - last.timeStamp > PREDICT_MS || out.length >= PREDICT_MAX * 3) break;
      const p = this.toPage(ev.clientX, ev.clientY);
      const px = p.x - lx;
      const py = p.y - ly;
      const pl = Math.hypot(px, py);
      // turning by more than ~45°: the prediction is unreliable
      if (pl && (px * dx + py * dy) / (pl * dl) < 0.7) break;
      out.push(p.x, p.y, g.pts[n - 1]);
    }
    return out;
  }

  private onUp = (e: PointerEvent) => {
    if (e.pointerType === 'pen') {
      this.penDown = false;
      this.lastPenTime = performance.now();
    }
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touchUp(e);
      return;
    }
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    this.gesture = null;
    switch (g.kind) {
      case 'draw':
        this.finishDraw(g, e);
        break;
      case 'erase':
        pageActions.endBatch();
        setLastInputKind('page');
        break;
      case 'lasso': {
        const ids = elementsInLasso(this.elements(), g.pts, measured);
        pageActions.select(ids);
        break;
      }
      case 'shape': {
        if (Math.hypot(g.x1 - g.x0, g.y1 - g.y0) > 3) {
          const ts = now();
          const r1 = (n: number) => Math.round(Math.max(0, n) * 10) / 10;
          const el: InkElement = {
            id: newId(),
            type: 'ink',
            tool: 'pen',
            color: g.color,
            size: g.size,
            pts: [r1(g.x0), r1(g.y0), 0.5, r1(g.x1), r1(g.y1), 0.5],
            shape: g.shape,
            sim: true,
            z: ts,
            updatedAt: ts,
          };
          pageActions.add([el]);
          setLastInputKind('page');
          this.handOff(el);
        }
        break;
      }
      case 'rect': {
        if (g.started) {
          const rect = { x: Math.min(g.x0, g.x1), y: Math.min(g.y0, g.y1), w: Math.abs(g.x1 - g.x0), h: Math.abs(g.y1 - g.y0) };
          pageActions.select(elementsInRect(this.elements(), rect, measured));
        } else if (usePage.getState().selection.length) {
          pageActions.clearSelection();
        } else {
          this.d.createTextAt(g.x0, g.y0);
        }
        break;
      }
      case 'move':
        pageActions.commitDrag();
        setLastInputKind('page');
        break;
      case 'mpan':
        break;
    }
    this.scheduleRender();
  };

  private finishDraw(g: DrawGesture, e: PointerEvent) {
    // use event positions/timestamps: when the main thread is busy, moves arrive late or coalesced
    const moved = Math.max(g.moved, Math.hypot(e.clientX - g.sx, e.clientY - g.sy));
    let extent = 0;
    for (let i = 3; i < g.pts.length; i += 3) extent = Math.max(extent, Math.hypot(g.pts[i] - g.pts[0], g.pts[i + 1] - g.pts[1]) * this.zoom);
    if (g.tapAsClick && moved < 6 && extent < 6 && e.timeStamp - g.t0 < 450) {
      this.clearCanvas();
      this.clickAt(e.clientX, e.clientY);
      return;
    }
    const end = this.toPage(e.clientX, e.clientY);
    const n = g.pts.length;
    if (Math.hypot(end.x - g.pts[n - 3], end.y - g.pts[n - 2]) * this.zoom > 1) g.pts.push(end.x, end.y, g.pts[n - 1]);
    // a stroke that leaves the page (e.g. into the page list) runs along its edge instead
    const r1 = (v: number) => Math.round(Math.max(0, v) * 10) / 10;
    const pts: number[] = [];
    for (let i = 0; i < g.pts.length; i += 3) pts.push(r1(g.pts[i]), r1(g.pts[i + 1]), g.pts[i + 2]);
    if (pts.length === 3) pts.push(pts[0] + 0.1, pts[1] + 0.1, pts[2]);
    const ts = now();
    const el: InkElement = { id: newId(), type: 'ink', tool: g.tool, color: g.color, size: g.size, pts, z: ts, updatedAt: ts };
    if (g.sim) el.sim = true;
    pageActions.add([el]);
    setLastInputKind('page');
    this.handOff(el);
  }

  /** Keeps a finished stroke on the canvas, in its final shape, until the SVG layer shows it. */
  private handOff(el: InkElement) {
    this.handoff.push({ el, t0: performance.now(), shown: 0 });
    this.scheduleRender();
  }

  /** A short pen tap in "pen always draws" mode acts like a click. */
  private clickAt(cx: number, cy: number) {
    const stack = document.elementsFromPoint(cx, cy);
    for (const el of stack) {
      const tc = el.closest<HTMLElement>('.text-container');
      if (tc?.dataset.el) {
        const ed = editorsById.get(tc.dataset.el);
        if (ed) {
          const pos = ed.view.posAtCoords({ left: cx, top: cy });
          ed.chain().focus().setTextSelection(pos?.pos ?? ed.state.doc.content.size).run();
          return;
        }
      }
      const img = el.closest<HTMLElement>('.image-el');
      if (img?.dataset.el) {
        pageActions.select([img.dataset.el]);
        return;
      }
      const input = el.closest<HTMLInputElement>('input, textarea');
      if (input) {
        input.focus();
        return;
      }
      if (el === this.d.page) break;
    }
    const p = this.toPage(cx, cy);
    const stroke = topmostStrokeAt(this.elements(), p.x, p.y, 6 / this.zoom);
    if (stroke) {
      pageActions.select([stroke.id]);
      return;
    }
    if (usePage.getState().selection.length) {
      pageActions.clearSelection();
      return;
    }
    this.d.createTextAt(p.x, p.y);
  }

  private onCancel = (e: PointerEvent) => {
    if (e.pointerType === 'pen') this.penDown = false;
    if (this.touches.has(e.pointerId)) {
      this.touches.delete(e.pointerId);
      this.cancelLongPress();
      this.longPressed = false;
      if (this.touches.size === 0) this.touchMode = 'idle';
      return;
    }
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    this.gesture = null;
    if (g.kind === 'erase') pageActions.endBatch();
    if (g.kind === 'move') pageActions.setDrag(null);
    if (g.kind === 'draw' && g.pts.length > 6) this.finishDraw({ ...g, tapAsClick: false }, e);
    this.scheduleRender();
  };

  private onLeave = (e: PointerEvent) => {
    if (e.pointerType === 'pen' && this.hover) {
      this.hover = null;
      this.scheduleRender();
    }
  };

  // ------------------------------------------------------------------ touch: pan / pinch / tap

  private touchDown(e: PointerEvent) {
    this.stopInertia();
    const target = e.target as Element;
    // On the empty page we handle taps ourselves; prevent the browser from moving focus.
    if (!isTextTarget(target) && !target.closest('.text-container')) e.preventDefault();
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now(), target });
    if (this.touches.size === 1) {
      this.touchMode = 'pending';
      this.lastPan = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.velocity = { x: 0, y: 0 };
      this.longPressed = false;
      this.cancelLongPress();
      // long press on the page (not inside text, where Android shows its own menu)
      if (!isTextTarget(target) && !target.closest('.text-container')) {
        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null;
          const t = [...this.touches.values()][0];
          if (this.touchMode !== 'pending' || this.touches.size !== 1 || !t) return;
          if (Math.hypot(t.x - t.sx, t.y - t.sy) > TAP_SLOP) return;
          this.longPressed = true;
          this.touchMode = 'idle';
          this.lastLongPress = performance.now();
          navigator.vibrate?.(12);
          this.d.onPageMenu(t.x, t.y);
        }, LONG_PRESS_MS);
      }
    } else if (this.touches.size === 2) {
      this.cancelLongPress();
      const [a, b] = [...this.touches.values()];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const p = this.toPage(mx, my);
      this.pinch0 = { dist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), zoom: this.zoom, px: p.x, py: p.y };
      this.touchMode = 'pinch';
    }
  }

  private touchMove(e: PointerEvent) {
    const t = this.touches.get(e.pointerId)!;
    t.x = e.clientX;
    t.y = e.clientY;
    if (this.touchMode === 'pending' && Math.hypot(t.x - t.sx, t.y - t.sy) > TAP_SLOP) {
      // a drag that starts inside the focused editor selects text instead of panning
      const active = getActiveEditor();
      if (active?.isFocused && t.target.closest('.ProseMirror-focused')) {
        this.touchMode = 'idle';
        this.touches.delete(e.pointerId);
        return;
      }
      this.touchMode = 'pan';
      this.cancelLongPress();
      this.lastPan = { x: t.x, y: t.y, t: performance.now() };
    }
    if (this.touchMode === 'pan') {
      const nowT = performance.now();
      const dx = t.x - this.lastPan.x;
      const dy = t.y - this.lastPan.y;
      this.d.scroller.scrollLeft -= dx;
      this.d.scroller.scrollTop -= dy;
      const dt = Math.max(1, nowT - this.lastPan.t);
      this.velocity = { x: 0.8 * (dx / dt) + 0.2 * this.velocity.x, y: 0.8 * (dy / dt) + 0.2 * this.velocity.y };
      this.lastPan = { x: t.x, y: t.y, t: nowT };
    } else if (this.touchMode === 'pinch' && this.pinch0 && this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()];
      const dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      this.zoomAt(this.pinch0.zoom * (dist / this.pinch0.dist), mx, my, this.pinch0.px, this.pinch0.py);
    }
  }

  private touchUp(e: PointerEvent) {
    const t = this.touches.get(e.pointerId)!;
    this.touches.delete(e.pointerId);
    this.cancelLongPress();
    if (this.longPressed) {
      // the menu is open: the lift of the finger is not a tap
      this.longPressed = false;
      if (this.touches.size === 0) this.touchMode = 'idle';
      return;
    }
    if (this.touchMode === 'pending' && performance.now() - t.t0 < 600) {
      this.touchMode = 'idle';
      this.tap(t, e);
      return;
    }
    if (this.touchMode === 'pinch') {
      if (this.touches.size === 1) {
        const rest = [...this.touches.values()][0];
        this.touchMode = 'pan';
        this.lastPan = { x: rest.x, y: rest.y, t: performance.now() };
        this.velocity = { x: 0, y: 0 };
      } else if (this.touches.size === 0) this.touchMode = 'idle';
      return;
    }
    if (this.touchMode === 'pan' && this.touches.size === 0) {
      this.touchMode = 'idle';
      if (performance.now() - this.lastPan.t < 80) this.startInertia();
      return;
    }
    if (this.touches.size === 0) this.touchMode = 'idle';
  }

  private tap(t: TouchPt, e: PointerEvent) {
    const target = t.target;
    if (isTextTarget(target) || target.closest('.text-container')) return; // native caret placement
    const p = this.toPage(e.clientX, e.clientY);
    const img = target.closest<HTMLElement>('.image-el');
    if (img?.dataset.el) {
      pageActions.select([img.dataset.el]);
      return;
    }
    const stroke = topmostStrokeAt(this.elements(), p.x, p.y, 10 / this.zoom);
    if (stroke) {
      pageActions.select([stroke.id]);
      return;
    }
    if (usePage.getState().selection.length) {
      pageActions.clearSelection();
      return;
    }
    const tool = useUI.getState().tool;
    if (tool === 'select') {
      this.suppressMouseUntil = performance.now() + 800;
      this.d.createTextAt(p.x, p.y);
    } else {
      this.blurEditor();
    }
  }

  private startInertia() {
    let last = performance.now();
    let { x: vx, y: vy } = this.velocity;
    const step = (ts: number) => {
      const dt = Math.min(40, ts - last);
      last = ts;
      this.d.scroller.scrollLeft -= vx * dt;
      this.d.scroller.scrollTop -= vy * dt;
      const decay = Math.pow(0.94, dt / 16);
      vx *= decay;
      vy *= decay;
      if (Math.abs(vx) + Math.abs(vy) > 0.02) this.inertiaRaf = requestAnimationFrame(step);
    };
    this.inertiaRaf = requestAnimationFrame(step);
  }

  private stopInertia() {
    cancelAnimationFrame(this.inertiaRaf);
  }

  /** Sets the zoom so that page point (px, py) stays under client point (cx, cy). */
  zoomAt(z: number, cx: number, cy: number, px: number, py: number) {
    flushSync(() => useUI.getState().setZoom(z));
    const zr = this.zoom;
    const pr = this.d.page.getBoundingClientRect();
    this.d.scroller.scrollLeft += pr.left + px * zr - cx;
    this.d.scroller.scrollTop += pr.top + py * zr - cy;
  }

  private onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const p = this.toPage(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
    this.zoomAt(this.zoom * factor, e.clientX, e.clientY, p.x, p.y);
  };

  private onClickCapture = (e: MouseEvent) => {
    const pe = e as PointerEvent;
    if (pe.pointerType === 'touch' && performance.now() < this.rejectedUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private onMouseDownCapture = (e: MouseEvent) => {
    if (performance.now() < this.suppressMouseUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private onContextMenu = (e: MouseEvent) => {
    const t = e.target as Element;
    if (isTextTarget(t)) return; // native menu (copy, paste, spelling) inside text
    e.preventDefault();
    if (isOwnPointer(t) || t.closest('.text-container')) return;
    // touch long presses are handled by our own timer; the pen never opens the menu (its side button erases),
    // even when the WebView does not report the event as pen input
    const pt = (e as PointerEvent).pointerType;
    if (pt === 'touch' || pt === 'pen' || this.gesture || this.penNear() || this.touches.size > 0 || performance.now() - this.lastLongPress < 1000) return;
    this.d.onPageMenu(e.clientX, e.clientY);
  };

  // ------------------------------------------------------------------ live rendering

  private scheduleRender() {
    if (!this.renderRaf) this.renderRaf = requestAnimationFrame(this.render);
  }

  private clearCanvas() {
    const c = this.d.canvas;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, c.width, c.height);
  }

  private render = () => {
    this.renderRaf = 0;
    const c = this.d.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = this.ctx;
    this.clearCanvas();
    const g = this.gesture;
    const finished = this.pendingHandoff();
    const showHover = !g && this.hover && useUI.getState().tool === 'eraser';
    if (!g && !showHover && !finished.length) return;
    const pr = this.d.page.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    const z = this.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (pr.left - cr.left), dpr * (pr.top - cr.top));
    const dark = this.d.isDark();
    const invert = useSettings.getState().invertInkInDark;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (finished.length) {
      const pressure = useSettings.getState().pressure;
      for (const el of finished) this.drawFinished(el, dark, invert, pressure);
      this.scheduleRender(); // until the SVG layer shows them
    }
    if (showHover && this.hover) {
      this.drawEraserCursor(this.hover.x, this.hover.y, useUI.getState().eraserSize / 2 / z);
      return;
    }
    if (!g) return;
    switch (g.kind) {
      case 'draw': {
        const pts = g.predicted.length ? g.pts.concat(g.predicted) : g.pts;
        const color = displayInkColor(g.color, dark, invert);
        if (g.tool === 'highlighter') {
          ctx.globalAlpha = HIGHLIGHTER_OPACITY;
          ctx.strokeStyle = color;
          ctx.lineWidth = g.size;
          ctx.stroke(new Path2D(polylinePath(pts)));
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = color;
          ctx.fill(new Path2D(outlineToPath(freehandOutline(pts, g.size, { uniform: g.sim, last: false }))));
        }
        break;
      }
      case 'shape': {
        const el: InkElement = {
          id: 'preview',
          type: 'ink',
          tool: 'pen',
          color: g.color,
          size: g.size,
          pts: [g.x0, g.y0, 0.5, g.x1, g.y1, 0.5],
          shape: g.shape,
          z: 0,
          updatedAt: 0,
        };
        this.drawFinished(el, dark, invert, false);
        break;
      }
      case 'erase':
        this.drawEraserCursor(g.x, g.y, g.r);
        break;
      case 'lasso': {
        ctx.setLineDash([6 / z, 5 / z]);
        ctx.lineWidth = 1.5 / z;
        ctx.strokeStyle = '#7a3fb8';
        ctx.fillStyle = 'rgba(122,63,184,0.08)';
        const path = new Path2D(polylinePath(g.pts, 2) + 'Z');
        ctx.fill(path);
        ctx.stroke(path);
        ctx.setLineDash([]);
        break;
      }
      case 'rect': {
        if (!g.started) break;
        ctx.setLineDash([5 / z, 4 / z]);
        ctx.lineWidth = 1 / z;
        ctx.strokeStyle = '#7a3fb8';
        ctx.fillStyle = 'rgba(122,63,184,0.08)';
        const x = Math.min(g.x0, g.x1);
        const y = Math.min(g.y0, g.y1);
        ctx.fillRect(x, y, Math.abs(g.x1 - g.x0), Math.abs(g.y1 - g.y0));
        ctx.strokeRect(x, y, Math.abs(g.x1 - g.x0), Math.abs(g.y1 - g.y0));
        ctx.setLineDash([]);
        break;
      }
      default:
        break;
    }
  };

  /** Finished strokes still waiting for their SVG version; drops the ones that are on screen (or gone). */
  private pendingHandoff(): InkElement[] {
    if (!this.handoff.length) return [];
    const t = performance.now();
    const { elements } = usePage.getState();
    this.handoff = this.handoff.filter((h) => {
      if (!elements[h.el.id] || t - h.t0 > HANDOFF_MAX_MS) return false; // undone, another page or never shown
      if (!h.shown) {
        if (!this.d.page.querySelector(`.ink-layer [data-id="${h.el.id}"]`)) return true;
        h.shown = t;
      }
      // a normal canvas changes in the same frame as the page; a desynchronized one gets to the screen
      // before the page has rasterized the new SVG path
      return this.desync && t - h.shown < HANDOFF_HOLD_MS;
    });
    return this.handoff.map((h) => h.el);
  }

  /** Draws a stroke exactly like the SVG layer (InkLayer) does. */
  private drawFinished(el: InkElement, dark: boolean, invert: boolean, pressure: boolean) {
    const ctx = this.ctx;
    const geo = inkGeometry(el, pressure);
    const color = displayInkColor(el.color, dark, invert);
    if (geo.mode === 'fill') {
      ctx.fillStyle = color;
      ctx.fill(new Path2D(geo.d));
      return;
    }
    ctx.globalAlpha = el.tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = el.size;
    ctx.stroke(new Path2D(geo.d));
    ctx.globalAlpha = 1;
  }

  private drawEraserCursor(x: number, y: number, r: number) {
    const ctx = this.ctx;
    const z = this.zoom;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fill();
    ctx.lineWidth = 1.2 / z;
    ctx.strokeStyle = '#666';
    ctx.stroke();
  }
}
