import type { ID, InkElement, PageElement } from '../model/types';
import { newId, now } from '../model/util';
import { directRadius } from './direct';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DEFAULT_TEXT_SIZE = { w: 160, h: 28 };

const isAxes = (shape: InkElement['shape']) => shape === 'axes1' || shape === 'axes2' || shape === 'axes4';

/**
 * Lines (flat x,y pairs) of a coordinate system spanning the dragged rectangle:
 * x axis, its arrow head, y axis, its arrow head.
 */
export function axesPolylines(el: InkElement): number[][] {
  const [x1, y1, , x2 = x1, y2 = y1] = el.pts;
  const l = Math.min(x1, x2);
  const r = Math.max(x1, x2);
  const t = Math.min(y1, y2);
  const b = Math.max(y1, y2);
  // origin: bottom left (axes1), middle left (axes2) or center (axes4)
  const ox = el.shape === 'axes4' ? (l + r) / 2 : l;
  const oy = el.shape === 'axes1' ? b : (t + b) / 2;
  const head = Math.max(8, el.size * 3);
  const hx = Math.min(head, (r - l) / 3);
  const hy = Math.min(head, (b - t) / 3);
  const c = Math.cos(0.45);
  const s = Math.sin(0.45);
  return [
    [l, oy, r, oy],
    [r - hx * c, oy - hx * s, r, oy, r - hx * c, oy + hx * s],
    [ox, b, ox, t],
    [ox - hy * s, t + hy * c, ox, t, ox + hy * s, t + hy * c],
  ];
}

function pushSegment(out: number[], ax: number, ay: number, bx: number, by: number) {
  const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 4));
  for (let i = 0; i <= n; i++) out.push(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n);
}

/** Points along the visible geometry of a stroke as flat x,y pairs, one list per connected piece. */
export function strokeRuns(el: InkElement): number[][] {
  if (isAxes(el.shape)) {
    return axesPolylines(el).map((line) => {
      const out: number[] = [];
      for (let i = 0; i + 3 < line.length; i += 2) pushSegment(out, line[i], line[i + 1], line[i + 2], line[i + 3]);
      return out;
    });
  }
  return [strokeSamples(el)];
}

/** Points along the visible geometry of a stroke as flat x,y pairs. */
export function strokeSamples(el: InkElement): number[] {
  if (!el.shape || el.shape === 'poly') {
    const out: number[] = [];
    for (let i = 0; i < el.pts.length; i += 3) out.push(el.pts[i], el.pts[i + 1]);
    return out;
  }
  if (isAxes(el.shape)) return strokeRuns(el).flat();
  const [x1, y1, , x2 = x1, y2 = y1] = el.pts;
  const out: number[] = [];
  const seg = (ax: number, ay: number, bx: number, by: number) => pushSegment(out, ax, ay, bx, by);
  switch (el.shape) {
    case 'line':
    case 'arrow':
      seg(x1, y1, x2, y2);
      break;
    case 'rect':
      seg(x1, y1, x2, y1);
      seg(x2, y1, x2, y2);
      seg(x2, y2, x1, y2);
      seg(x1, y2, x1, y1);
      break;
    case 'ellipse': {
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2;
      const ry = Math.abs(y2 - y1) / 2;
      const n = Math.max(24, Math.ceil(((rx + ry) * Math.PI) / 4));
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
      }
      break;
    }
  }
  return out;
}

export function strokeBounds(el: InkElement): Rect {
  const s = strokeSamples(el);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < s.length; i += 2) {
    if (s[i] < minX) minX = s[i];
    if (s[i] > maxX) maxX = s[i];
    if (s[i + 1] < minY) minY = s[i + 1];
    if (s[i + 1] > maxY) maxY = s[i + 1];
  }
  const pad = (el.direct ? directRadius(el.size, 1, !!el.sim) : el.size / 2) + (el.shape === 'arrow' ? el.size * 4 : 0);
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

export function elementBounds(el: PageElement, measured?: Map<ID, { w: number; h: number }>): Rect {
  if (el.type === 'ink') return strokeBounds(el);
  if (el.type === 'image') return { x: el.x, y: el.y, w: el.w, h: el.h };
  const m = measured?.get(el.id);
  return { x: el.x, y: el.y, w: m?.w ?? el.w ?? DEFAULT_TEXT_SIZE.w, h: m?.h ?? DEFAULT_TEXT_SIZE.h };
}

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/** Is the point within radius r of the stroke? */
export function strokeHit(el: InkElement, x: number, y: number, r: number): boolean {
  const b = strokeBounds(el);
  if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) return false;
  const rr = r + el.size / 2;
  const rr2 = rr * rr;
  for (const s of strokeRuns(el)) {
    if (s.length === 2 && (s[0] - x) ** 2 + (s[1] - y) ** 2 <= rr2) return true;
    for (let i = 0; i + 3 < s.length; i += 2) {
      if (distToSegmentSq(x, y, s[i], s[i + 1], s[i + 2], s[i + 3]) <= rr2) return true;
    }
  }
  return false;
}

/**
 * Point eraser: removes the parts of the stroke within radius r of (x, y).
 * Returns null if the stroke is not touched, otherwise the remaining pieces (possibly empty).
 */
export function eraseFromStroke(el: InkElement, x: number, y: number, r: number): InkElement[] | null {
  if (!strokeHit(el, x, y, r)) return null;
  // convert shapes to polylines first
  let runs = [el.pts];
  let shape = el.shape;
  if (el.shape && el.shape !== 'poly') {
    runs = strokeRuns(el).map((s) => {
      const pts: number[] = [];
      for (let i = 0; i < s.length; i += 2) pts.push(s[i], s[i + 1], 0.5);
      return pts;
    });
    shape = 'poly';
  }
  const rr = r + el.size / 2;
  const rr2 = rr * rr;
  const pieces: number[][] = [];
  for (const pts of runs) {
    let cur: number[] = [];
    for (let i = 0; i < pts.length; i += 3) {
      const inside = (pts[i] - x) ** 2 + (pts[i + 1] - y) ** 2 <= rr2;
      if (inside) {
        if (cur.length >= 6) pieces.push(cur);
        cur = [];
      } else {
        cur.push(pts[i], pts[i + 1], pts[i + 2]);
      }
    }
    if (cur.length >= 6) pieces.push(cur);
  }
  if (pieces.length === 1 && pieces[0].length === el.pts.length && shape === el.shape) return null;
  const ts = now();
  return pieces.map((p, i) => ({ ...el, id: newId(), pts: p, shape, z: el.z + i * 1e-6, updatedAt: ts }));
}

export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i];
    const yi = poly[i + 1];
    const xj = poly[j];
    const yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Elements that are (mostly) inside a lasso polygon. */
export function elementsInLasso(elements: PageElement[], poly: number[], measured: Map<ID, { w: number; h: number }>): ID[] {
  const out: ID[] = [];
  for (const el of elements) {
    if (el.type === 'ink') {
      const s = strokeSamples(el);
      let inside = 0;
      let total = 0;
      for (let i = 0; i < s.length; i += 2) {
        total++;
        if (pointInPolygon(s[i], s[i + 1], poly)) inside++;
      }
      if (total > 0 && inside / total >= 0.6) out.push(el.id);
    } else {
      const b = elementBounds(el, measured);
      const corners = [b.x, b.y, b.x + b.w, b.y, b.x, b.y + b.h, b.x + b.w, b.y + b.h, b.x + b.w / 2, b.y + b.h / 2];
      let inside = 0;
      for (let i = 0; i < corners.length; i += 2) if (pointInPolygon(corners[i], corners[i + 1], poly)) inside++;
      if (inside >= 3) out.push(el.id);
    }
  }
  return out;
}

export function elementsInRect(elements: PageElement[], rect: Rect, measured: Map<ID, { w: number; h: number }>): ID[] {
  return elements.filter((el) => rectsIntersect(elementBounds(el, measured), rect)).map((e) => e.id);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function translateElement<T extends PageElement>(el: T, dx: number, dy: number): T {
  if (el.type === 'ink') {
    const pts = el.pts.slice();
    for (let i = 0; i < pts.length; i += 3) {
      pts[i] = round1(pts[i] + dx);
      pts[i + 1] = round1(pts[i + 1] + dy);
    }
    return { ...el, pts };
  }
  return { ...el, x: round1((el as { x: number }).x + dx), y: round1((el as { y: number }).y + dy) };
}

/**
 * Top-left corner of where elements sit: text box and image corners, ink points (without the stroke
 * width). Nothing may go left of or above 0, the page is cut off there.
 */
export function elementsOrigin(els: Iterable<PageElement>): { x: number; y: number } | null {
  let x = Infinity;
  let y = Infinity;
  for (const el of els) {
    if (el.type === 'ink') {
      for (let i = 0; i + 1 < el.pts.length; i += 3) {
        if (el.pts[i] < x) x = el.pts[i];
        if (el.pts[i + 1] < y) y = el.pts[i + 1];
      }
    } else {
      x = Math.min(x, el.x);
      y = Math.min(y, el.y);
    }
  }
  return x === Infinity ? null : { x, y };
}

/** Scales an element around origin (ox, oy). Text boxes are only moved. */
export function scaleElement<T extends PageElement>(el: T, ox: number, oy: number, s: number): T {
  if (el.type === 'ink') {
    const pts = el.pts.slice();
    for (let i = 0; i < pts.length; i += 3) {
      pts[i] = round1(ox + (pts[i] - ox) * s);
      pts[i + 1] = round1(oy + (pts[i + 1] - oy) * s);
    }
    return { ...el, pts, size: Math.max(0.5, Math.round(el.size * s * 100) / 100) };
  }
  if (el.type === 'image') {
    return { ...el, x: round1(ox + (el.x - ox) * s), y: round1(oy + (el.y - oy) * s), w: round1(el.w * s), h: round1(el.h * s) };
  }
  return { ...el, x: round1(ox + (el.x - ox) * s), y: round1(oy + (el.y - oy) * s) };
}

export function topmostStrokeAt(elements: PageElement[], x: number, y: number, r: number): InkElement | null {
  let best: InkElement | null = null;
  for (const el of elements) {
    if (el.type !== 'ink') continue;
    if (strokeHit(el, x, y, r) && (!best || el.z > best.z)) best = el;
  }
  return best;
}
