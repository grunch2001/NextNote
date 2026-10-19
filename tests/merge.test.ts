import { describe, expect, it } from 'vitest';
import { mergeBodies, mergeFields } from '../src/model/merge';
import { stableStringify } from '../src/model/util';
import { inkEl, textEl, withElements } from './helpers';

describe('mergeFields', () => {
  it('takes the newer value per field and is symmetric', () => {
    const a = { name: 'A', color: 'red', times: { name: 10, color: 30 } };
    const b = { name: 'B', color: 'blue', times: { name: 20, color: 5 } };
    const ab = mergeFields(a, b, ['name', 'color']);
    const ba = mergeFields(b, a, ['name', 'color']);
    expect(ab.name).toBe('B');
    expect(ab.color).toBe('red');
    expect(stableStringify(ab)).toBe(stableStringify(ba));
  });

  it('breaks ties deterministically', () => {
    const a = { name: 'A', times: { name: 10 } };
    const b = { name: 'B', times: { name: 10 } };
    expect(mergeFields(a, b, ['name']).name).toBe(mergeFields(b, a, ['name']).name);
  });
});

describe('mergeBodies', () => {
  it('unions elements added on both sides', () => {
    const t1 = textEl('eins');
    const s1 = inkEl();
    const r = mergeBodies({ elements: withElements(t1), tombstones: {} }, { elements: withElements(s1), tombstones: {} }, {});
    expect(Object.keys(r.elements).sort()).toEqual([t1.id, s1.id].sort());
    expect(r.conflicts).toBe(0);
  });

  it('applies deletions that are newer than the element', () => {
    const t1 = textEl('weg');
    const r = mergeBodies({ elements: withElements(t1), tombstones: {} }, { elements: {}, tombstones: { [t1.id]: t1.updatedAt + 5 } }, {});
    expect(r.elements[t1.id]).toBeUndefined();
    expect(r.tombstones[t1.id]).toBe(t1.updatedAt + 5);
  });

  it('keeps an element edited after it was deleted elsewhere', () => {
    const t1 = textEl('bleibt');
    const r = mergeBodies({ elements: withElements(t1), tombstones: {} }, { elements: {}, tombstones: { [t1.id]: t1.updatedAt - 5 } }, {});
    expect(r.elements[t1.id]).toBeDefined();
  });

  it('keeps a conflict copy when the same text box changed on both sides', () => {
    const base = textEl('Basis');
    const local = { ...base, updatedAt: base.updatedAt + 10, doc: textEl('lokal').doc };
    const remote = { ...base, updatedAt: base.updatedAt + 20, doc: textEl('remote').doc };
    const baseTimes = { [base.id]: base.updatedAt };
    const r1 = mergeBodies({ elements: withElements(local), tombstones: {} }, { elements: withElements(remote), tombstones: {} }, baseTimes);
    const r2 = mergeBodies({ elements: withElements(remote), tombstones: {} }, { elements: withElements(local), tombstones: {} }, baseTimes);
    expect(r1.conflicts).toBe(1);
    expect(Object.keys(r1.elements)).toHaveLength(2);
    expect(stableStringify(r1.elements)).toBe(stableStringify(r2.elements));
    const winner = r1.elements[base.id];
    expect(winner.type === 'text' && winner.doc).toEqual(remote.doc);
    const copy = Object.values(r1.elements).find((e) => e.id !== base.id);
    expect(copy?.type === 'text' && copy.conflictOf).toBe(base.id);
    // merging again does not create a second copy
    const r3 = mergeBodies({ elements: r1.elements, tombstones: {} }, { elements: withElements(local), tombstones: {} }, baseTimes);
    expect(Object.keys(r3.elements)).toHaveLength(2);
  });
});
