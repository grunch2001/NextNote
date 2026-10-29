import { getStroke } from 'perfect-freehand';
import type { InkElement } from '../model/types';
import { DIRECT_TOLERANCE, directPath, directShapes } from './direct';
import { axesPolylines } from './geometry';

/** Fill outline of a freehand pen stroke from before 1.3 (pressure sensitive, smoothed). */
export function freehandOutline(pts: number[], size: number, opts: { uniform: boolean; last: boolean }): number[][] {
  const input: number[][] = [];
  for (let i = 0; i + 2 < pts.length + 1; i += 3) input.push([pts[i], pts[i + 1], pts[i + 2] ?? 0.5]);
  return getStroke(input, {
    size: size * (opts.uniform ? 1 : 1.25),
    thinning: opts.uniform ? 0 : 0.6,
    smoothing: 0.55,
    streamline: 0.35,
    simulatePressure: false,
    last: opts.last,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  });
}

const avg = (a: number, b: number) => (a + b) / 2;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** perfect-freehand outline -> smooth closed SVG path. */
export function outlineToPath(points: number[][]): string {
  const len = points.length;
  if (len < 4) {
    if (len === 0) return '';
    // a dot
    const [x, y] = points[0];
    return `M${r2(x)},${r2(y)}Z`;
  }
  let a = points[0];
  let b = points[1];
  const c = points[2];
  let d = `M${r2(a[0])},${r2(a[1])} Q${r2(b[0])},${r2(b[1])} ${r2(avg(b[0], c[0]))},${r2(avg(b[1], c[1]))} T`;
  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${r2(avg(a[0], b[0]))},${r2(avg(a[1], b[1]))} `;
  }
  return d + 'Z';
}

export function polylinePath(pts: number[], stride = 3): string {
  if (pts.length < stride) return '';
  let d = `M${r2(pts[0])},${r2(pts[1])}`;
  if (pts.length === stride) return d + `L${r2(pts[0] + 0.01)},${r2(pts[1] + 0.01)}`;
  for (let i = stride; i < pts.length; i += stride) d += `L${r2(pts[i])},${r2(pts[i + 1])}`;
  return d;
}

export interface InkGeometry {
  d: string;
  /** 'fill' paths are outlines, 'stroke' paths are center lines drawn with stroke-width. */
  mode: 'fill' | 'stroke';
}

/** Geometry for shapes. pts contains the two corner/end points. */
function shapePath(el: InkElement): string {
  const [x1, y1, , x2 = x1, y2 = y1] = el.pts;
  switch (el.shape) {
    case 'line':
      return `M${r2(x1)},${r2(y1)}L${r2(x2)},${r2(y2)}`;
    case 'arrow': {
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(10, el.size * 4);
      const a1 = ang + Math.PI - 0.45;
      const a2 = ang + Math.PI + 0.45;
      return (
        `M${r2(x1)},${r2(y1)}L${r2(x2)},${r2(y2)}` +
        `M${r2(x2 + head * Math.cos(a1))},${r2(y2 + head * Math.sin(a1))}L${r2(x2)},${r2(y2)}L${r2(x2 + head * Math.cos(a2))},${r2(y2 + head * Math.sin(a2))}`
      );
    }
    case 'rect': {
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      return `M${r2(x)},${r2(y)}h${r2(w)}v${r2(h)}h${r2(-w)}Z`;
    }
    case 'ellipse': {
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2;
      const ry = Math.abs(y2 - y1) / 2;
      return `M${r2(cx - rx)},${r2(cy)}a${r2(rx)},${r2(ry)} 0 1,0 ${r2(rx * 2)},0a${r2(rx)},${r2(ry)} 0 1,0 ${r2(-rx * 2)},0`;
    }
    case 'axes1':
    case 'axes2':
    case 'axes4':
      return axesPolylines(el)
        .map((line) => polylinePath(line, 2))
        .join('');
    default:
      return polylinePath(el.pts);
  }
}

const cache = new WeakMap<InkElement, InkGeometry>();

/** Geometry of a stroke; whether its width follows the pressure was decided when it was written (sim). */
export function inkGeometry(el: InkElement): InkGeometry {
  const hit = cache.get(el);
  if (hit) return hit;
  let geo: InkGeometry;
  if (el.shape) geo = { d: shapePath(el), mode: 'stroke' };
  else if (el.tool === 'highlighter') geo = { d: polylinePath(el.pts), mode: 'stroke' };
  else if (el.direct) geo = { d: directPath(directShapes(el.pts, el.size, !!el.sim, DIRECT_TOLERANCE)), mode: 'fill' };
  else geo = { d: outlineToPath(freehandOutline(el.pts, el.size, { uniform: !!el.sim, last: true })), mode: 'fill' };
  cache.set(el, geo);
  return geo;
}

export const HIGHLIGHTER_OPACITY = 0.42;

/** Dark ink is shown light in dark mode (like OneNote), other colours stay. */
export function displayInkColor(color: string, dark: boolean, invert: boolean): string {
  if (!dark || !invert) return color;
  const c = color.toLowerCase();
  if (c === '#000000' || c === '#000' || c === 'black') return '#f2f2f2';
  if (c === '#5a5a5a') return '#bdbdbd';
  if (c === '#ffffff' || c === '#fff') return '#1e1e1e';
  if (c === '#283593') return '#8c9eff';
  return color;
}
