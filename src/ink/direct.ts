/*
 * Direct pen strokes (since 1.3): a disc at every input point, its radius following the pressure,
 * joined by the tangents between neighbouring discs. Unlike perfect-freehand nothing is smoothed and
 * a new point never changes what is already drawn, so the ink stays exactly where the pen was.
 * The native live ink on Android (NativeInk.java) draws the same shapes.
 */

/** Stroke width as a factor of the pen size: base + pressure * p (NativeInk.java gets these values). */
export const DIRECT_WIDTH = { base: 0.5, pressure: 1.2 };

/** Simplification (page units) of a finished stroke for display; far below what can be seen. */
export const DIRECT_TOLERANCE = 0.05;

export function directRadius(size: number, pressure: number, uniform: boolean): number {
  return (size / 2) * (uniform ? 1 : DIRECT_WIDTH.base + DIRECT_WIDTH.pressure * pressure);
}

export interface DirectShapes {
  /** x, y, r per disc. */
  discs: number[];
  /** Four corners per quad, counter-clockwise on screen (like the discs in directPath). */
  quads: number[];
}

export function directShapes(pts: number[], size: number, uniform: boolean, tolerance = 0): DirectShapes {
  const all: number[] = [];
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const r = directRadius(size, pts[i + 2], uniform);
    const n = all.length;
    if (n && all[n - 3] === pts[i] && all[n - 2] === pts[i + 1] && all[n - 1] === r) continue;
    all.push(pts[i], pts[i + 1], r);
  }
  const discs = tolerance > 0 ? simplify(all, tolerance) : all;
  const quads: number[] = [];
  for (let i = 3; i < discs.length; i += 3) {
    const x1 = discs[i - 3];
    const y1 = discs[i - 2];
    const r1 = discs[i - 1];
    const x2 = discs[i];
    const y2 = discs[i + 1];
    const r2 = discs[i + 2];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len <= Math.abs(r1 - r2)) continue; // one disc contains the other
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    const k = (r1 - r2) / len;
    const s = Math.sqrt(1 - k * k);
    // directions from the centres to the tangent points on either side
    const ax = k * ux - s * uy;
    const ay = k * uy + s * ux;
    const bx = k * ux + s * uy;
    const by = k * uy - s * ux;
    quads.push(x1 + r1 * ax, y1 + r1 * ay, x2 + r2 * ax, y2 + r2 * ay, x2 + r2 * bx, y2 + r2 * by, x1 + r1 * bx, y1 + r1 * by);
  }
  return { discs, quads };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** SVG path of the shapes; all of them run the same way round, so the default fill rule unites them. */
export function directPath({ discs, quads }: DirectShapes): string {
  let d = '';
  for (let i = 0; i < discs.length; i += 3) {
    const r = r2(discs[i + 2]);
    d += `M${r2(discs[i] + r)},${r2(discs[i + 1])}a${r},${r} 0 1,0 ${-2 * r},0a${r},${r} 0 1,0 ${2 * r},0`;
  }
  for (let i = 0; i < quads.length; i += 8) {
    d += `M${r2(quads[i])},${r2(quads[i + 1])}L${r2(quads[i + 2])},${r2(quads[i + 3])}L${r2(quads[i + 4])},${r2(quads[i + 5])}L${r2(quads[i + 6])},${r2(quads[i + 7])}Z`;
  }
  return d;
}

/** Ramer–Douglas–Peucker on x, y, r triples. */
function simplify(d: number[], tolerance: number): number[] {
  const n = d.length / 3;
  if (n < 3) return d;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    let worst = -1;
    let max = tolerance;
    for (let i = a + 1; i < b; i++) {
      const e = distance(d, i, a, b);
      if (e > max) {
        max = e;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push(a, worst, worst, b);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
  return out;
}

/** Distance of triple i from the segment between triples a and b. */
function distance(d: number[], i: number, a: number, b: number): number {
  let len2 = 0;
  let dot = 0;
  for (let k = 0; k < 3; k++) {
    const ab = d[b * 3 + k] - d[a * 3 + k];
    len2 += ab * ab;
    dot += (d[i * 3 + k] - d[a * 3 + k]) * ab;
  }
  const t = len2 ? Math.max(0, Math.min(1, dot / len2)) : 0;
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const v = d[i * 3 + k] - (d[a * 3 + k] + (d[b * 3 + k] - d[a * 3 + k]) * t);
    sum += v * v;
  }
  return Math.sqrt(sum);
}
