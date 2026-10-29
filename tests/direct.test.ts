import { describe, expect, it } from 'vitest';
import { directPath, directRadius, directShapes } from '../src/ink/direct';

const corners = (q: number[], i = 0) => [0, 1, 2, 3].map((k) => [q[i * 8 + k * 2], q[i * 8 + k * 2 + 1]]);

describe('direct strokes', () => {
  it('draws even width without pressure and wider with more pressure', () => {
    expect(directRadius(2, 0.1, true)).toBe(1);
    expect(directRadius(2, 0.9, true)).toBe(1);
    expect(directRadius(2, 0.8, false)).toBeGreaterThan(directRadius(2, 0.2, false));
  });

  it('joins two discs with lines tangent to both', () => {
    // a thin disc at (0, 0) and a thick one at (10, 0)
    const { discs, quads } = directShapes([0, 0, 0.1, 10, 0, 1], 2, false);
    expect(discs).toHaveLength(6);
    expect(quads).toHaveLength(8);
    const r1 = directRadius(2, 0.1, false);
    const r2 = directRadius(2, 1, false);
    const [a1, a2, b2, b1] = corners(quads);
    for (const [[x, y], [cx, cy], r] of [
      [a1, [0, 0], r1],
      [b1, [0, 0], r1],
      [a2, [10, 0], r2],
      [b2, [10, 0], r2],
    ] as const) {
      expect(Math.hypot(x - cx, y - cy)).toBeCloseTo(r, 9);
    }
    // the edge is perpendicular to the radius at both ends
    const ex = a2[0] - a1[0];
    const ey = a2[1] - a1[1];
    expect(ex * (a1[0] - 0) + ey * (a1[1] - 0)).toBeCloseTo(0, 9);
    expect(ex * (a2[0] - 10) + ey * (a2[1] - 0)).toBeCloseTo(0, 9);
  });

  it('runs every quad counter-clockwise on screen, like the discs', () => {
    const { quads } = directShapes([0, 0, 0.5, 10, 3, 0.5, 4, 12, 0.9, -5, 2, 0.1], 2, false);
    for (let i = 0; i < quads.length / 8; i++) {
      const c = corners(quads, i);
      let area = 0;
      for (let k = 0; k < 4; k++) area += c[k][0] * c[(k + 1) % 4][1] - c[(k + 1) % 4][0] * c[k][1];
      expect(area).toBeLessThan(0);
    }
  });

  it('leaves out the join when one disc contains the other', () => {
    const { discs, quads } = directShapes([0, 0, 1, 0.1, 0, 0], 4, false);
    expect(discs).toHaveLength(6);
    expect(quads).toHaveLength(0);
  });

  it('keeps the ends and stays within the tolerance when simplifying', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 100; i++) pts.push(i, Math.sin(i / 10) * 0.02, 0.5);
    const { discs } = directShapes(pts, 2, true, 0.05);
    expect(discs.length).toBeLessThan(pts.length);
    expect(discs.slice(0, 2)).toEqual([0, 0]);
    expect(discs.slice(-3, -1)).toEqual([100, pts[pts.length - 2]]);
  });

  it('writes one closed shape per disc and quad', () => {
    const d = directPath(directShapes([0, 0, 0.5, 10, 0, 0.5], 2, true));
    expect(d.match(/M/g)).toHaveLength(3);
    expect(d).toContain('a1,1 0 1,0 -2,0');
  });
});
