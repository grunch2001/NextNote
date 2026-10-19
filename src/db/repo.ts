import type { NextNoteDB } from './db';
import { pickColor, NOTEBOOK_COLORS, SECTION_COLORS } from '../model/colors';
import { mergeBodies, pruneTombstones } from '../model/merge';
import { pageSearchText, pageTags } from '../model/text';
import type {
  AssetRecord,
  ID,
  ImageElement,
  Notebook,
  PageBody,
  PageElement,
  PageMeta,
  RuleStyle,
  Section,
} from '../model/types';
import { newId, now, orderBetween } from '../model/util';

export type NotebookPatch = Partial<Pick<Notebook, 'name' | 'color' | 'order'>>;
export type SectionPatch = Partial<Pick<Section, 'name' | 'color' | 'order' | 'deletedAt'>>;
export type PagePatch = Partial<Pick<PageMeta, 'title' | 'sectionId' | 'order' | 'level' | 'deletedAt' | 'bgColor' | 'rule'>>;

export const TRASH_RETENTION_DAYS = 60;

function applyPatch<T extends { times: Record<string, number>; rev: number }>(rec: T, patch: object, ts = now()): T {
  const out = { ...rec, times: { ...rec.times } } as T;
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if ((out as Record<string, unknown>)[k] === v) continue;
    (out as Record<string, unknown>)[k] = v;
    out.times[k] = ts;
    changed = true;
  }
  if (changed) out.rev = rec.rev + 1;
  return out;
}

/** Derived search/tag fields of a page. */
export function derivePage(meta: PageMeta, body: PageBody): PageMeta {
  return { ...meta, searchText: pageSearchText(meta.title, body), tags: pageTags(body) };
}

export function emptyBody(id: ID): PageBody {
  return { id, elements: {}, tombstones: {} };
}

export class Repo {
  /** Called after every local modification (used to schedule a sync). */
  onChange: ((notebookId: ID) => void) | null = null;

  constructor(public db: NextNoteDB) {}

  private markDirty(notebookId: ID) {
    const cb = this.onChange;
    if (cb) queueMicrotask(() => cb(notebookId));
    return this.db.kv.put({ k: `dirty:${notebookId}`, v: 1 });
  }

  // ---------------------------------------------------------------- notebooks

  async listNotebooks(): Promise<Notebook[]> {
    const all = await this.db.notebooks.toArray();
    return all.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  async createNotebook(name: string, color?: string): Promise<{ notebook: Notebook; section: Section; page: PageMeta }> {
    const ts = now();
    const existing = await this.listNotebooks();
    const notebook: Notebook = {
      id: newId(),
      name: name.trim() || 'Neues Notizbuch',
      color: color ?? pickColor(NOTEBOOK_COLORS, existing.length),
      order: orderBetween(existing.at(-1)?.order, undefined),
      createdAt: ts,
      times: { name: ts, color: ts, order: ts },
      folder: null,
      folderEtag: null,
      rev: 1,
      syncedRev: 0,
      etag: null,
    };
    await this.db.notebooks.put(notebook);
    const section = await this.createSection(notebook.id, 'Neuer Abschnitt');
    const page = (await this.listPages(section.id))[0];
    return { notebook, section, page };
  }

  async updateNotebook(id: ID, patch: NotebookPatch): Promise<void> {
    await this.db.transaction('rw', this.db.notebooks, this.db.kv, async () => {
      const nb = await this.db.notebooks.get(id);
      if (!nb) return;
      const next = applyPatch(nb, patch);
      if (next.rev !== nb.rev) {
        await this.db.notebooks.put(next);
        await this.markDirty(id);
      }
    });
  }

  /** Removes the notebook locally and (after the next sync) its folder in Nextcloud. */
  async deleteNotebook(id: ID): Promise<void> {
    const db = this.db;
    await db.transaction('rw', [db.notebooks, db.sections, db.pages, db.bodies, db.assets, db.deletions, db.kv], async () => {
      const nb = await db.notebooks.get(id);
      if (!nb) return;
      const pageIds = await db.pages.where('notebookId').equals(id).primaryKeys();
      await db.bodies.bulkDelete(pageIds);
      await db.pages.where('notebookId').equals(id).delete();
      await db.sections.where('notebookId').equals(id).delete();
      await db.assets.where('notebookId').equals(id).delete();
      await db.deletions.where('notebookId').equals(id).delete();
      await db.notebooks.delete(id);
      await db.kv.delete(`dirty:${id}`);
      if (nb.folder) {
        await db.deletions.put({ key: `nb|${id}`, notebookId: id, path: '', folder: nb.folder });
      }
    });
  }

  // ---------------------------------------------------------------- sections

  async listSections(notebookId: ID, includeDeleted = false): Promise<Section[]> {
    const all = await this.db.sections.where('notebookId').equals(notebookId).toArray();
    return all
      .filter((s) => includeDeleted || s.deletedAt === null)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  async createSection(notebookId: ID, name: string, opts: { afterId?: ID } = {}): Promise<Section> {
    const ts = now();
    const sections = await this.listSections(notebookId);
    let order: number;
    if (opts.afterId) {
      const idx = sections.findIndex((s) => s.id === opts.afterId);
      order = orderBetween(sections[idx]?.order, sections[idx + 1]?.order);
    } else {
      order = orderBetween(sections.at(-1)?.order, undefined);
    }
    const allSections = await this.db.sections.where('notebookId').equals(notebookId).count();
    const section: Section = {
      id: newId(),
      notebookId,
      name: name.trim() || 'Neuer Abschnitt',
      color: pickColor(SECTION_COLORS, allSections),
      order,
      createdAt: ts,
      deletedAt: null,
      times: { name: ts, color: ts, order: ts, deletedAt: ts },
      rev: 1,
      syncedRev: 0,
      etag: null,
    };
    await this.db.transaction('rw', this.db.sections, this.db.kv, async () => {
      await this.db.sections.put(section);
      await this.markDirty(notebookId);
    });
    await this.createPage(section.id);
    return section;
  }

  async updateSection(id: ID, patch: SectionPatch): Promise<void> {
    await this.db.transaction('rw', this.db.sections, this.db.kv, async () => {
      const s = await this.db.sections.get(id);
      if (!s) return;
      const next = applyPatch(s, patch);
      if (next.rev !== s.rev) {
        await this.db.sections.put(next);
        await this.markDirty(s.notebookId);
      }
    });
  }

  trashSection(id: ID) {
    return this.updateSection(id, { deletedAt: now() });
  }

  restoreSection(id: ID) {
    return this.updateSection(id, { deletedAt: null });
  }

  /** Permanently delete a section and all of its pages. */
  async purgeSection(id: ID): Promise<void> {
    const db = this.db;
    await db.transaction('rw', [db.sections, db.pages, db.bodies, db.deletions, db.kv], async () => {
      const s = await db.sections.get(id);
      if (!s) return;
      const pages = await db.pages.where('sectionId').equals(id).toArray();
      for (const p of pages) await this.purgePageInTx(p);
      await db.sections.delete(id);
      if (s.etag) await db.deletions.put({ key: `${s.notebookId}|sections/${id}.json`, notebookId: s.notebookId, path: `sections/${id}.json`, folder: '' });
      await this.markDirty(s.notebookId);
    });
  }

  /** Move a section (with its pages) into another notebook. */
  async moveSectionToNotebook(sectionId: ID, targetNotebookId: ID): Promise<void> {
    const db = this.db;
    await db.transaction('rw', [db.sections, db.pages, db.bodies, db.assets, db.deletions, db.kv], async () => {
      const s = await db.sections.get(sectionId);
      if (!s || s.notebookId === targetNotebookId) return;
      const oldNb = s.notebookId;
      const targetSections = (await db.sections.where('notebookId').equals(targetNotebookId).toArray()).filter((x) => x.deletedAt === null);
      const maxOrder = Math.max(0, ...targetSections.map((x) => x.order));
      if (s.etag) await db.deletions.put({ key: `${oldNb}|sections/${s.id}.json`, notebookId: oldNb, path: `sections/${s.id}.json`, folder: '' });
      const ts = now();
      await db.sections.put({
        ...s,
        notebookId: targetNotebookId,
        order: maxOrder + 1,
        times: { ...s.times, order: ts, name: ts, color: ts, deletedAt: ts },
        etag: null,
        syncedRev: 0,
        rev: s.rev + 1,
      });
      const pages = await db.pages.where('sectionId').equals(sectionId).toArray();
      for (const p of pages) await this.transferPageInTx(p, targetNotebookId, sectionId, p.order);
      await this.markDirty(oldNb);
      await this.markDirty(targetNotebookId);
    });
  }

  // ---------------------------------------------------------------- pages

  async listPages(sectionId: ID, includeDeleted = false): Promise<PageMeta[]> {
    const all = await this.db.pages.where('sectionId').equals(sectionId).toArray();
    return all.filter((p) => includeDeleted || p.deletedAt === null).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  async getPage(id: ID): Promise<{ meta: PageMeta; body: PageBody } | null> {
    const [meta, body] = await Promise.all([this.db.pages.get(id), this.db.bodies.get(id)]);
    if (!meta) return null;
    return { meta, body: body ?? emptyBody(id) };
  }

  async createPage(sectionId: ID, opts: { afterId?: ID; level?: number; title?: string } = {}): Promise<PageMeta> {
    const section = await this.db.sections.get(sectionId);
    if (!section) throw new Error('Abschnitt nicht gefunden');
    const ts = now();
    const pages = await this.listPages(sectionId);
    let order: number;
    let level = opts.level ?? 0;
    const idx = opts.afterId ? pages.findIndex((p) => p.id === opts.afterId) : -1;
    if (idx >= 0) {
      // insert after the page and its sub pages
      let end = idx;
      while (end + 1 < pages.length && pages[end + 1].level > pages[idx].level) end++;
      order = orderBetween(pages[end].order, pages[end + 1]?.order);
      if (opts.level === undefined) level = pages[idx].level;
    } else {
      order = orderBetween(pages.at(-1)?.order, undefined);
    }
    const meta: PageMeta = {
      id: newId(),
      notebookId: section.notebookId,
      sectionId,
      title: opts.title ?? '',
      order,
      level: Math.max(0, Math.min(2, level)),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      bgColor: null,
      rule: 'none',
      times: { title: ts, sectionId: ts, order: ts, level: ts, deletedAt: ts, bgColor: ts, rule: ts },
      searchText: (opts.title ?? '').toLowerCase(),
      tags: [],
      base: {},
      rev: 1,
      syncedRev: 0,
      etag: null,
    };
    await this.db.transaction('rw', this.db.pages, this.db.bodies, this.db.kv, async () => {
      await this.db.pages.put(meta);
      await this.db.bodies.put(emptyBody(meta.id));
      await this.markDirty(section.notebookId);
    });
    return meta;
  }

  async updatePage(id: ID, patch: PagePatch): Promise<PageMeta | null> {
    let result: PageMeta | null = null;
    await this.db.transaction('rw', this.db.pages, this.db.bodies, this.db.kv, async () => {
      const meta = await this.db.pages.get(id);
      if (!meta) return;
      let next = applyPatch(meta, patch);
      if (next.rev === meta.rev) {
        result = meta;
        return;
      }
      next.updatedAt = now();
      if (patch.title !== undefined) {
        const body = (await this.db.bodies.get(id)) ?? emptyBody(id);
        next = derivePage(next, body);
      }
      await this.db.pages.put(next);
      await this.markDirty(meta.notebookId);
      result = next;
    });
    return result;
  }

  async setPageBackground(id: ID, bg: { bgColor?: string | null; rule?: RuleStyle }) {
    return this.updatePage(id, bg);
  }

  /**
   * Persist the body of a page. The stored version is merged (last writer wins per element),
   * so changes that a sync wrote in the meantime are never overwritten by an older editor state.
   */
  async savePageBody(id: ID, body: PageBody): Promise<void> {
    await this.db.transaction('rw', this.db.pages, this.db.bodies, this.db.kv, async () => {
      const meta = await this.db.pages.get(id);
      if (!meta) return;
      const ts = now();
      const stored = await this.db.bodies.get(id);
      const merged = stored ? mergeBodies(stored, body, {}) : body;
      const clean: PageBody = { id, elements: merged.elements, tombstones: pruneTombstones(merged.tombstones, ts) };
      await this.db.bodies.put(clean);
      const next = derivePage({ ...meta, rev: meta.rev + 1, updatedAt: ts }, clean);
      await this.db.pages.put(next);
      await this.markDirty(meta.notebookId);
    });
  }

  trashPage(id: ID) {
    return this.updatePage(id, { deletedAt: now() });
  }

  restorePage(id: ID) {
    return this.updatePage(id, { deletedAt: null });
  }

  private async purgePageInTx(meta: PageMeta) {
    await this.db.pages.delete(meta.id);
    await this.db.bodies.delete(meta.id);
    if (meta.etag) {
      await this.db.deletions.put({ key: `${meta.notebookId}|pages/${meta.id}.json`, notebookId: meta.notebookId, path: `pages/${meta.id}.json`, folder: '' });
    }
  }

  async purgePage(id: ID): Promise<void> {
    const db = this.db;
    await db.transaction('rw', [db.pages, db.bodies, db.deletions, db.kv], async () => {
      const meta = await db.pages.get(id);
      if (!meta) return;
      await this.purgePageInTx(meta);
      await this.markDirty(meta.notebookId);
    });
  }

  /** Move pages into another section (possibly in another notebook), placed before `beforeId` or at the end. */
  async movePages(ids: ID[], targetSectionId: ID, beforeId?: ID | null, levels?: number[]): Promise<void> {
    const db = this.db;
    await db.transaction('rw', [db.sections, db.pages, db.bodies, db.assets, db.deletions, db.kv], async () => {
      const target = await db.sections.get(targetSectionId);
      if (!target) return;
      const existing = (await db.pages.where('sectionId').equals(targetSectionId).toArray())
        .filter((p) => p.deletedAt === null && !ids.includes(p.id))
        .sort((a, b) => a.order - b.order);
      let idx = beforeId ? existing.findIndex((p) => p.id === beforeId) : existing.length;
      if (idx < 0) idx = existing.length;
      const lo = existing[idx - 1]?.order;
      const hi = existing[idx]?.order;
      const n = ids.length;
      const orderAt = (i: number) => {
        if (lo === undefined && hi === undefined) return i + 1;
        if (lo === undefined) return (hi as number) - (n - i);
        if (hi === undefined) return lo + i + 1;
        return lo + ((hi - lo) * (i + 1)) / (n + 1);
      };
      for (let i = 0; i < ids.length; i++) {
        const meta = await db.pages.get(ids[i]);
        if (!meta) continue;
        const order = orderAt(i);
        const level = levels?.[i] ?? meta.level;
        if (meta.notebookId !== target.notebookId) {
          await this.transferPageInTx(meta, target.notebookId, targetSectionId, order, level);
        } else {
          const next = applyPatch(meta, { sectionId: targetSectionId, order, level });
          if (next.rev !== meta.rev) {
            next.updatedAt = now();
            await db.pages.put(next);
          }
        }
      }
      await this.markDirty(target.notebookId);
    });
  }

  /** Moves a page into another notebook. Must run inside a transaction covering pages, bodies, assets, deletions, kv. */
  private async transferPageInTx(meta: PageMeta, targetNotebookId: ID, targetSectionId: ID, order: number, level = meta.level) {
    const db = this.db;
    const oldNb = meta.notebookId;
    const body = (await db.bodies.get(meta.id)) ?? emptyBody(meta.id);
    if (meta.etag) await db.deletions.put({ key: `${oldNb}|pages/${meta.id}.json`, notebookId: oldNb, path: `pages/${meta.id}.json`, folder: '' });
    const elements: Record<ID, PageElement> = {};
    const ts = now();
    for (const el of Object.values(body.elements)) {
      if (el.type === 'image') {
        const asset = await db.assets.get(el.asset);
        if (asset && asset.notebookId !== targetNotebookId) {
          const copy: AssetRecord = { id: newId(), notebookId: targetNotebookId, mime: asset.mime, data: asset.data, uploaded: 0 };
          await db.assets.put(copy);
          elements[el.id] = { ...el, asset: copy.id, updatedAt: ts } as ImageElement;
          continue;
        }
      }
      elements[el.id] = el;
    }
    const newBody: PageBody = { id: meta.id, elements, tombstones: body.tombstones };
    await db.bodies.put(newBody);
    const times = { ...meta.times };
    for (const k of Object.keys(times)) times[k] = ts;
    await db.pages.put({
      ...meta,
      notebookId: targetNotebookId,
      sectionId: targetSectionId,
      order,
      level,
      times: { ...times, sectionId: ts, order: ts, level: ts },
      etag: null,
      syncedRev: 0,
      rev: meta.rev + 1,
      base: {},
      updatedAt: ts,
    });
    await this.markDirty(oldNb);
  }

  async duplicatePage(id: ID): Promise<PageMeta | null> {
    const src = await this.getPage(id);
    if (!src) return null;
    const copy = await this.createPage(src.meta.sectionId, { afterId: id, level: src.meta.level, title: src.meta.title ? `${src.meta.title} (Kopie)` : '' });
    const ts = now();
    const elements: Record<ID, PageElement> = {};
    for (const el of Object.values(src.body.elements)) {
      const nid = newId();
      elements[nid] = { ...structuredClone(el), id: nid, updatedAt: ts };
    }
    await this.updatePage(copy.id, { bgColor: src.meta.bgColor, rule: src.meta.rule });
    await this.savePageBody(copy.id, { id: copy.id, elements, tombstones: {} });
    return (await this.db.pages.get(copy.id)) ?? null;
  }

  // ---------------------------------------------------------------- assets

  async addAsset(notebookId: ID, data: ArrayBuffer, mime: string): Promise<ID> {
    const id = newId();
    await this.db.transaction('rw', this.db.assets, this.db.kv, async () => {
      await this.db.assets.put({ id, notebookId, mime, data, uploaded: 0 });
      await this.markDirty(notebookId);
    });
    return id;
  }

  getAsset(id: ID) {
    return this.db.assets.get(id);
  }

  // ---------------------------------------------------------------- maintenance

  /** Permanently remove items that have been in the recycle bin for too long. */
  async purgeExpiredTrash(): Promise<void> {
    const limit = Date.now() - TRASH_RETENTION_DAYS * 24 * 3600 * 1000;
    const pages = await this.db.pages.filter((p) => p.deletedAt !== null && p.deletedAt < limit).toArray();
    for (const p of pages) await this.purgePage(p.id);
    const sections = await this.db.sections.filter((s) => s.deletedAt !== null && s.deletedAt < limit).toArray();
    for (const s of sections) await this.purgeSection(s.id);
  }
}
