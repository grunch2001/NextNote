import type { FieldTimes, ID, PageElement, TextElement } from './types';
import { stableStringify } from './util';

/**
 * Last-writer-wins merge of selected fields. Ties are broken deterministically so that
 * merge(a, b) and merge(b, a) produce the same result on every device.
 */
export function mergeFields<T extends { times: FieldTimes }>(local: T, remote: T, fields: readonly (keyof T & string)[]): T {
  const out = { ...local, times: { ...local.times } } as T;
  for (const f of fields) {
    const tl = local.times[f] ?? 0;
    const tr = remote.times[f] ?? 0;
    let useRemote = tr > tl;
    if (tr === tl && stableStringify(remote[f]) > stableStringify(local[f])) useRemote = true;
    if (useRemote) {
      (out as Record<string, unknown>)[f] = remote[f];
      out.times[f] = tr;
    }
  }
  return out;
}

export interface BodyLike {
  elements: Record<ID, PageElement>;
  tombstones: Record<ID, number>;
}

export interface BodyMergeResult {
  elements: Record<ID, PageElement>;
  tombstones: Record<ID, number>;
  conflicts: number;
}

function pickNewer(a: PageElement, b: PageElement): [PageElement, PageElement] {
  if (a.updatedAt > b.updatedAt) return [a, b];
  if (b.updatedAt > a.updatedAt) return [b, a];
  return stableStringify(a) >= stableStringify(b) ? [a, b] : [b, a];
}

export function conflictCopyId(id: ID, loser: PageElement): ID {
  return `${id}~${loser.updatedAt.toString(36)}`;
}

/**
 * State based merge of two page bodies.
 * Elements are merged last-writer-wins, deletions win over older edits.
 * If the same text box was changed on both sides since the last sync (`base`),
 * the older version is kept as a separate "conflict copy" instead of being lost.
 */
export function mergeBodies(local: BodyLike, remote: BodyLike, base: Record<ID, number>): BodyMergeResult {
  const tombstones: Record<ID, number> = { ...local.tombstones };
  for (const [id, t] of Object.entries(remote.tombstones)) {
    if (!(id in tombstones) || tombstones[id] < t) tombstones[id] = t;
  }
  const elements: Record<ID, PageElement> = {};
  let conflicts = 0;
  const ids = new Set([...Object.keys(local.elements), ...Object.keys(remote.elements)]);
  const extra: PageElement[] = [];
  for (const id of ids) {
    const l = local.elements[id];
    const r = remote.elements[id];
    let el: PageElement;
    if (l && r) {
      const [winner, loser] = pickNewer(l, r);
      el = winner;
      const b = base[id];
      if (
        winner.type === 'text' &&
        loser.type === 'text' &&
        b !== undefined &&
        l.updatedAt !== b &&
        r.updatedAt !== b &&
        stableStringify(winner.doc) !== stableStringify(loser.doc)
      ) {
        const copyId = conflictCopyId(id, loser);
        if (!ids.has(copyId)) {
          const copy: TextElement = {
            ...loser,
            id: copyId,
            y: loser.y + 28,
            x: loser.x + 28,
            conflictOf: id,
          };
          extra.push(copy);
          conflicts++;
        }
      }
    } else {
      el = (l ?? r) as PageElement;
    }
    const tomb = tombstones[id];
    if (tomb !== undefined && tomb >= el.updatedAt) continue;
    elements[id] = el;
  }
  for (const copy of extra) {
    const tomb = tombstones[copy.id];
    if (tomb !== undefined && tomb >= copy.updatedAt) continue;
    elements[copy.id] = copy;
  }
  return { elements, tombstones, conflicts };
}

/** Drop tombstones older than maxAge (default 120 days). */
export function pruneTombstones(tombstones: Record<ID, number>, nowTs: number, maxAge = 120 * 24 * 3600 * 1000): Record<ID, number> {
  const out: Record<ID, number> = {};
  for (const [id, t] of Object.entries(tombstones)) if (nowTs - t < maxAge) out[id] = t;
  return out;
}

export function elementTimes(body: BodyLike): Record<ID, number> {
  const out: Record<ID, number> = {};
  for (const [id, el] of Object.entries(body.elements)) out[id] = el.updatedAt;
  return out;
}

export function bodiesEqual(a: BodyLike, b: BodyLike): boolean {
  return stableStringify(a.elements) === stableStringify(b.elements) && stableStringify(a.tombstones) === stableStringify(b.tombstones);
}

export const NOTEBOOK_FIELDS = ['name', 'color', 'order'] as const;
export const SECTION_FIELDS = ['name', 'color', 'order', 'deletedAt'] as const;
export const PAGE_FIELDS = ['title', 'sectionId', 'order', 'level', 'deletedAt', 'bgColor', 'rule'] as const;
