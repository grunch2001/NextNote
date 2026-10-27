import { create } from 'zustand';
import type { JSONContent } from '@tiptap/core';
import { pdfRepo, repo } from './repo';
import { pdfAssetOwner } from '../db/repo';
import { isPdfDirty } from '../pdf/repo';
import { mergeBodies } from '../model/merge';
import type { ID, PageElement } from '../model/types';
import { debounce, now } from '../model/util';
import { elementsOrigin, scaleElement, translateElement } from '../ink/geometry';

type Snapshot = Record<ID, PageElement | null>;

interface Op {
  before: Snapshot;
  after: Snapshot;
}

interface PageState {
  pageId: ID | null;
  /** 'pdf': a PDF of a PDF section, its annotations are saved into the file. */
  kind: 'page' | 'pdf';
  /** Owner of new pictures: the notebook, or for a PDF the PDF itself. */
  notebookId: ID | null;
  loading: boolean;
  elements: Record<ID, PageElement>;
  tombstones: Record<ID, number>;
  selection: ID[];
  undoStack: Op[];
  redoStack: Op[];
  /** A text element that should receive focus once mounted. */
  focusRequest: { id: ID; atEnd?: boolean; clientX?: number; clientY?: number } | null;
  /** Increments whenever measured element sizes change. */
  measureVersion: number;
  /** Live transform of the selection while it is dragged or scaled. */
  drag: DragTransform | null;
}

export interface DragTransform {
  dx: number;
  dy: number;
  /** uniform scale around (ox, oy) */
  s: number;
  ox: number;
  oy: number;
}

export const usePage = create<PageState>(() => ({
  pageId: null,
  kind: 'page',
  notebookId: null,
  loading: false,
  elements: {},
  tombstones: {},
  selection: [],
  undoStack: [],
  redoStack: [],
  focusRequest: null,
  measureVersion: 0,
  drag: null,
}));

/** Measured on-screen size (page units) of text elements, maintained by the text containers. */
export const measured = new Map<ID, { w: number; h: number }>();
let measureTimer: ReturnType<typeof setTimeout> | null = null;
export function reportMeasure(id: ID, w: number, h: number) {
  const prev = measured.get(id);
  if (prev && Math.abs(prev.w - w) < 0.5 && Math.abs(prev.h - h) < 0.5) return;
  measured.set(id, { w, h });
  if (!measureTimer)
    measureTimer = setTimeout(() => {
      measureTimer = null;
      usePage.setState((s) => ({ measureVersion: s.measureVersion + 1 }));
    }, 60);
}

let dirty = false;
/** Freshly created, still empty text boxes are not persisted until something is typed. */
export const draftTexts = new Set<ID>();
let batch: Op | null = null;
let loadSeq = 0;

const save = debounce(() => void persist(), 500);

async function persist() {
  const s = usePage.getState();
  if (!s.pageId || !dirty) return;
  dirty = false;
  let elements = s.elements;
  if (draftTexts.size) {
    elements = { ...elements };
    for (const id of draftTexts) delete elements[id];
  }
  const body = { id: s.pageId, elements, tombstones: s.tombstones };
  if (s.kind === 'pdf') await pdfRepo.saveBody(s.pageId, body);
  else await repo.savePageBody(s.pageId, body);
}

/** A closed PDF with unsaved annotations may be uploaded now. */
function closedPdf(id: ID) {
  void pdfRepo.getDoc(id).then((d) => {
    if (d && isPdfDirty(d)) pdfRepo.onChange?.(id);
  });
}

/** Loads a page or a PDF document. */
async function loadDoc(id: ID): Promise<{ kind: PageState['kind']; notebookId: ID; body: { elements: Record<ID, PageElement>; tombstones: Record<ID, number> } } | null> {
  const page = await repo.getPage(id);
  if (page) return { kind: 'page', notebookId: page.meta.notebookId, body: page.body };
  const doc = await pdfRepo.getDoc(id);
  if (!doc || doc.deletedAt !== null) return null;
  return { kind: 'pdf', notebookId: pdfAssetOwner(id), body: await pdfRepo.getBody(id) };
}

function markDirty() {
  dirty = true;
  save();
}

/** Applies element states (null = delete) without touching the undo history. */
function applySnapshot(snap: Snapshot, bumpTime = true) {
  usePage.setState((s) => {
    const elements = { ...s.elements };
    const tombstones = { ...s.tombstones };
    const ts = now();
    for (const [id, el] of Object.entries(snap)) {
      if (el === null) {
        if (elements[id]) {
          delete elements[id];
          tombstones[id] = ts;
        }
      } else {
        elements[id] = bumpTime ? ({ ...el, updatedAt: ts } as PageElement) : el;
        delete tombstones[id];
      }
    }
    const selection = s.selection.filter((id) => elements[id]);
    return { elements, tombstones, selection };
  });
  markDirty();
}

function record(op: Op) {
  if (batch) {
    for (const [id, el] of Object.entries(op.before)) if (!(id in batch.before)) batch.before[id] = el;
    Object.assign(batch.after, op.after);
    return;
  }
  usePage.setState((s) => ({ undoStack: [...s.undoStack.slice(-199), op], redoStack: [] }));
}

let originCache: { selection: ID[]; elements: Record<ID, PageElement>; origin: { x: number; y: number } | null } | null = null;

/** Limits a live move/scale of the selection so that it does not go past the left or top edge. */
function clampToPage(drag: DragTransform): DragTransform {
  const { selection, elements } = usePage.getState();
  if (originCache?.selection !== selection || originCache.elements !== elements) {
    originCache = { selection, elements, origin: elementsOrigin(selection.map((id) => elements[id]).filter((el): el is PageElement => !!el)) };
  }
  const o = originCache.origin;
  if (!o) return drag;
  const x = drag.ox + (o.x - drag.ox) * drag.s;
  const y = drag.oy + (o.y - drag.oy) * drag.s;
  return { ...drag, dx: Math.max(drag.dx, -x), dy: Math.max(drag.dy, -y) };
}

function change(snap: Snapshot, undoable = true) {
  const { elements } = usePage.getState();
  const before: Snapshot = {};
  for (const id of Object.keys(snap)) before[id] = elements[id] ?? null;
  applySnapshot(snap);
  if (undoable) {
    const after: Snapshot = {};
    const cur = usePage.getState().elements;
    for (const id of Object.keys(snap)) after[id] = cur[id] ?? null;
    record({ before, after });
  }
}

export const pageActions = {
  async load(pageId: ID | null) {
    await this.flush();
    const seq = ++loadSeq;
    batch = null;
    measured.clear();
    draftTexts.clear();
    const prevPdf = usePage.getState().kind === 'pdf' ? usePage.getState().pageId : null;
    if (prevPdf && prevPdf !== pageId) pdfRepo.openId = null;
    if (!pageId) {
      usePage.setState({ pageId: null, kind: 'page', notebookId: null, elements: {}, tombstones: {}, selection: [], undoStack: [], redoStack: [], loading: false });
      if (prevPdf) closedPdf(prevPdf);
      return;
    }
    usePage.setState({ loading: true });
    const page = await loadDoc(pageId);
    if (seq !== loadSeq) return;
    if (page?.kind === 'pdf') pdfRepo.openId = pageId;
    if (prevPdf && prevPdf !== pageId) closedPdf(prevPdf);
    usePage.setState({
      pageId,
      kind: page?.kind ?? 'page',
      notebookId: page?.notebookId ?? null,
      elements: page?.body.elements ?? {},
      tombstones: page?.body.tombstones ?? {},
      selection: [],
      undoStack: [],
      redoStack: [],
      loading: false,
      focusRequest: null,
    });
  },

  /** Re-read the page from the database after a sync changed it, keeping unsaved local edits. */
  async reloadFromDb() {
    const s = usePage.getState();
    if (!s.pageId) return;
    const page = await loadDoc(s.pageId);
    if (!page || usePage.getState().pageId !== s.pageId) return;
    const cur = usePage.getState();
    if (!dirty) {
      usePage.setState({
        elements: page.body.elements,
        tombstones: page.body.tombstones,
        notebookId: page.notebookId,
        selection: cur.selection.filter((id) => page.body.elements[id]),
      });
      return;
    }
    const merged = mergeBodies({ elements: cur.elements, tombstones: cur.tombstones }, page.body, {});
    usePage.setState({ elements: merged.elements, tombstones: merged.tombstones, notebookId: page.notebookId });
    markDirty();
  },

  async flush() {
    save.cancel();
    await persist();
  },

  add(els: PageElement[], undoable = true) {
    const snap: Snapshot = {};
    for (const el of els) snap[el.id] = el;
    change(snap, undoable);
  },

  update(patches: Record<ID, Partial<PageElement>>, undoable = true) {
    const { elements } = usePage.getState();
    const snap: Snapshot = {};
    for (const [id, patch] of Object.entries(patches)) {
      const el = elements[id];
      if (el) snap[id] = { ...el, ...patch } as PageElement;
    }
    change(snap, undoable);
  },

  /** Replace elements by new versions (and remove others), e.g. after point-erasing. */
  replace(snap: Snapshot, undoable = true) {
    change(snap, undoable);
  },

  remove(ids: ID[], undoable = true) {
    const snap: Snapshot = {};
    for (const id of ids) snap[id] = null;
    change(snap, undoable);
  },

  /** Text edits are handled by the editor's own undo history. */
  setTextDoc(id: ID, doc: JSONContent) {
    const el = usePage.getState().elements[id];
    if (!el || el.type !== 'text') return;
    draftTexts.delete(id);
    applySnapshot({ [id]: { ...el, doc } });
  },

  beginBatch() {
    batch = { before: {}, after: {} };
  },

  endBatch() {
    const b = batch;
    batch = null;
    if (!b || Object.keys(b.after).length === 0) return;
    // drop no-ops (e.g. element created and erased in the same gesture)
    for (const id of Object.keys(b.after)) {
      if (b.before[id] === null && b.after[id] === null) {
        delete b.before[id];
        delete b.after[id];
      }
    }
    if (Object.keys(b.after).length) usePage.setState((s) => ({ undoStack: [...s.undoStack.slice(-199), b], redoStack: [] }));
  },

  canUndo: () => usePage.getState().undoStack.length > 0,
  canRedo: () => usePage.getState().redoStack.length > 0,

  undo() {
    const s = usePage.getState();
    const op = s.undoStack.at(-1);
    if (!op) return;
    usePage.setState({ undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, op] });
    applySnapshot(op.before);
  },

  redo() {
    const s = usePage.getState();
    const op = s.redoStack.at(-1);
    if (!op) return;
    usePage.setState({ redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, op] });
    applySnapshot(op.after);
  },

  select(ids: ID[]) {
    usePage.setState({ selection: ids });
  },

  clearSelection() {
    if (usePage.getState().selection.length) usePage.setState({ selection: [] });
  },

  requestFocus(req: PageState['focusRequest']) {
    usePage.setState({ focusRequest: req });
  },

  setDrag(drag: DragTransform | null) {
    usePage.setState({ drag: drag && clampToPage(drag) });
  },

  /** Bakes the live drag transform into the selected elements (one undo step). */
  commitDrag() {
    const { drag, selection, elements } = usePage.getState();
    usePage.setState({ drag: null });
    if (!drag || (drag.dx === 0 && drag.dy === 0 && drag.s === 1)) return;
    const snap: Snapshot = {};
    for (const id of selection) {
      const el = elements[id];
      if (!el) continue;
      let next = drag.s !== 1 ? scaleElement(el, drag.ox, drag.oy, drag.s) : el;
      next = translateElement(next, drag.dx, drag.dy);
      snap[id] = next;
    }
    change(snap, true);
  },
};

/** Elements copied with Ctrl+C on the canvas. */
export let elementClipboard: PageElement[] = [];
export function setElementClipboard(els: PageElement[]) {
  elementClipboard = els.map((e) => structuredClone(e));
}
