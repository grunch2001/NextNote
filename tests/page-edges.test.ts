import { describe, expect, it } from 'vitest';
import { elementsOrigin } from '../src/ink/geometry';
import type { InkElement } from '../src/model/types';
import { pageActions, usePage } from '../src/state/page';
import { repo } from '../src/state/repo';
import { inkEl, textEl, withElements } from './helpers';

function ink(pts: number[]): InkElement {
  return { ...inkEl(), pts };
}

describe('page edges', () => {
  it('finds the top-left corner of element positions', () => {
    expect(elementsOrigin([textEl('a', 40, 120), ink([-5, 300, 0.5, 10, 10, 0.5])])).toEqual({ x: -5, y: 10 });
    expect(elementsOrigin([])).toBeNull();
  });

  it('does not let a moved or scaled selection leave the page', async () => {
    const { page } = await repo.createNotebook('Ziehen');
    const a = textEl('A', 30, 150);
    const b = ink([50, 40, 0.5, 90, 80, 0.5]);
    await repo.savePageBody(page.id, { id: page.id, elements: withElements(a, b), tombstones: {} });
    await pageActions.load(page.id);
    pageActions.select([a.id, b.id]);

    pageActions.setDrag({ dx: -500, dy: -500, s: 1, ox: 0, oy: 0 });
    expect(usePage.getState().drag).toMatchObject({ dx: -30, dy: -40 });
    pageActions.setDrag({ dx: 25, dy: -10, s: 1, ox: 0, oy: 0 });
    expect(usePage.getState().drag).toMatchObject({ dx: 25, dy: -10 });
    pageActions.commitDrag();
    expect(elementsOrigin(Object.values(usePage.getState().elements))).toEqual({ x: 55, y: 30 });

    // scaling around a point to the right: the left side grows outwards and stops at the edge
    pageActions.setDrag({ dx: 0, dy: 0, s: 3, ox: 200, oy: 300 });
    const d = usePage.getState().drag!;
    expect(200 + (55 - 200) * 3 + d.dx).toBeCloseTo(0);
    expect(300 + (30 - 300) * 3 + d.dy).toBeCloseTo(0);
    pageActions.setDrag(null);
  });
});
