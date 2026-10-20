import { describe, expect, it } from 'vitest';
import type { InkElement } from '../src/model/types';
import { axesPolylines, eraseFromStroke, strokeBounds, strokeHit } from '../src/ink/geometry';

const axes = (shape: InkElement['shape']): InkElement => ({
  id: 'a',
  type: 'ink',
  tool: 'pen',
  color: '#000000',
  size: 2,
  // dragged from bottom right to top left: the axes still point right and up
  pts: [200, 200, 0.5, 0, 0, 0.5],
  shape,
  sim: true,
  z: 1,
  updatedAt: 1,
});

describe('coordinate system shapes', () => {
  it('places the origin per variant', () => {
    const origin = (shape: InkElement['shape']) => {
      const [xAxis, , yAxis] = axesPolylines(axes(shape));
      return [yAxis[0], xAxis[1]];
    };
    expect(origin('axes1')).toEqual([0, 200]);
    expect(origin('axes2')).toEqual([0, 100]);
    expect(origin('axes4')).toEqual([100, 100]);
  });

  it('points the arrow heads right and up', () => {
    const [xAxis, xHead, yAxis, yHead] = axesPolylines(axes('axes4'));
    expect(xAxis.slice(2)).toEqual([200, 100]);
    expect(xHead.slice(2, 4)).toEqual([200, 100]);
    expect(yAxis.slice(2)).toEqual([100, 0]);
    expect(yHead.slice(2, 4)).toEqual([100, 0]);
  });

  it('hits the axes but not the empty quadrants', () => {
    const el = axes('axes4');
    expect(strokeHit(el, 50, 100, 2)).toBe(true);
    expect(strokeHit(el, 100, 150, 2)).toBe(true);
    expect(strokeHit(el, 50, 50, 2)).toBe(false);
    // the end of the x axis and the start of the y axis are not connected
    expect(strokeHit(el, 150, 150, 2)).toBe(false);
  });

  it('includes the arrow heads in the bounds', () => {
    const b = strokeBounds(axes('axes1'));
    expect(b.y + b.h).toBeGreaterThan(201);
  });

  it('erases into separate pieces without connecting the axes', () => {
    const pieces = eraseFromStroke(axes('axes4'), 50, 100, 4);
    expect(pieces).not.toBeNull();
    for (const p of pieces!) {
      expect(p.shape).toBe('poly');
      for (let i = 3; i < p.pts.length; i += 3) {
        expect(Math.hypot(p.pts[i] - p.pts[i - 3], p.pts[i + 1] - p.pts[i - 2])).toBeLessThan(5);
      }
    }
  });
});
