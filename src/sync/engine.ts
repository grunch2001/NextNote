import type { NextNoteDB } from '../db/db';
import { derivePage, emptyBody } from '../db/repo';
import { bodiesEqual, elementTimes, mergeBodies, mergeFields, NOTEBOOK_FIELDS, PAGE_FIELDS, SECTION_FIELDS } from '../model/merge';
import {
  notebookToRemote,
  pageToRemote,
  parseNotebook,
  parsePage,
  parseSection,
  remoteBody,
  sectionToRemote,
  type RemotePage,
} from '../model/serialize';
import type { ID, Notebook, PageMeta, Section, SyncFields } from '../model/types';
import { decodeUtf8, extForMime, mimeForExt, sanitizeFolderName, stableStringify } from '../model/util';
import { NetworkError } from '../platform/types';
import { DavError, joinPath, type DavEntry, type WebDavClient } from './webdav';

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  errors: string[];
  changedPages: Set<ID>;
  structureChanged: boolean;
  assetsChanged: boolean;
}

export interface SyncEvents {
  onProgress?(message: string): void;
}

interface ApplyResult {
  dirtyAfter: boolean;
  changed: boolean;
}

interface Adapter<L extends SyncFields> {
  label: string;
  load(id: ID): Promise<L | undefined>;
  serialize(local: L): Promise<{ text: string; snapshot: unknown }>;
  applyRemote(id: ID, text: string, etag: string | null): Promise<ApplyResult | 'invalid'>;
  markUploaded(id: ID, revAt: number, etag: string | null, snapshot: unknown): Promise<void>;
  /** Deletes the local copy if it is not dirty. Returns false if it was kept. */
  deleteLocalIfClean(id: ID): Promise<boolean>;
  resetEtag(id: ID): Promise<void>;
}

const isDirty = (r: SyncFields) => r.rev > r.syncedRev;

const DIRS = ['sections', 'pages', 'assets'] as const;

/** Resets every sync marker so that the next sync treats all local data as new (e.g. after switching account or folder). */
export async function resetSyncState(db: NextNoteDB): Promise<void> {
  await db.transaction('rw', [db.notebooks, db.sections, db.pages, db.assets, db.deletions, db.kv], async () => {
    await db.notebooks.toCollection().modify((n) => {
      n.folder = null;
      n.folderEtag = null;
      n.etag = null;
      n.syncedRev = 0;
    });
    await db.sections.toCollection().modify((s) => {
      s.etag = null;
      s.syncedRev = 0;
    });
    await db.pages.toCollection().modify((p) => {
      p.etag = null;
      p.syncedRev = 0;
      p.base = {};
    });
    await db.assets.toCollection().modify((a) => {
      a.uploaded = 0;
    });
    await db.deletions.clear();
    const keys = (await db.kv.toCollection().primaryKeys()).filter((k) => k.startsWith('dirEtag:') || k.startsWith('pdfRoot:') || k === 'ignoredFolders');
    await db.kv.bulkDelete(keys);
    for (const id of await db.notebooks.toCollection().primaryKeys()) await db.kv.put({ k: `dirty:${id}`, v: 1 });
  });
}

export class SyncEngine {
  private report!: SyncReport;

  constructor(
    private db: NextNoteDB,
    private client: WebDavClient,
    private root: string,
    private events: SyncEvents = {},
  ) {
    this.root = joinPath(root);
  }

  private progress(msg: string) {
    this.events.onProgress?.(msg);
  }

  async sync(): Promise<SyncReport> {
    this.report = {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: [],
      changedPages: new Set(),
      structureChanged: false,
      assetsChanged: false,
    };
    const { db, client } = this;
    this.progress('Verbinde …');
    let rootList = await client.list(this.root);
    if (!rootList) {
      await client.ensureDir(this.root);
      rootList = await client.list(this.root);
      if (!rootList) throw new Error(`Ordner „${this.root}“ konnte nicht angelegt werden.`);
    }
    let folders = rootList.children.filter((c) => c.isDir);

    // whole notebooks deleted locally
    const deletedNotebooks = new Set<ID>();
    for (const d of (await db.deletions.toArray()).filter((x) => x.path === '')) {
      if (folders.some((f) => f.name === d.folder)) {
        await client.delete(joinPath(this.root, d.folder));
        this.report.deleted++;
      }
      folders = folders.filter((f) => f.name !== d.folder);
      deletedNotebooks.add(d.notebookId);
      await db.deletions.delete(d.key);
    }

    const locals = await db.notebooks.toArray();
    const byFolder = new Map(locals.filter((n) => n.folder).map((n) => [n.folder as string, n]));
    const ignored = (await db.getKV<Record<string, string>>('ignoredFolders')) ?? {};
    const seen = new Set<ID>();
    const plan: Array<{ nb: Notebook; entry: DavEntry | null }> = [];
    const usedNames = new Set(folders.map((f) => f.name));

    for (const f of folders) {
      const mapped = byFolder.get(f.name);
      if (mapped && !seen.has(mapped.id)) {
        // closed on this device: left alone until it is opened again
        if (!mapped.closedAt) plan.push({ nb: mapped, entry: f });
        seen.add(mapped.id);
        continue;
      }
      if (ignored[f.name] !== undefined && ignored[f.name] === (f.etag ?? '')) continue;
      const file = await client.get(joinPath(this.root, f.name, 'notebook.json'));
      const remote = file ? parseNotebook(decodeUtf8(file.data)) : null;
      if (!remote || !file) {
        ignored[f.name] = f.etag ?? '';
        continue;
      }
      delete ignored[f.name];
      if (deletedNotebooks.has(remote.id)) {
        // deleted here, but renamed on another device in the meantime
        await client.delete(joinPath(this.root, f.name));
        this.report.deleted++;
        continue;
      }
      if (seen.has(remote.id)) continue; // a copied folder with the same id
      const existing = locals.find((n) => n.id === remote.id);
      if (existing?.closedAt) {
        // renamed on another device while closed here: handled when it is opened again
        seen.add(existing.id);
        continue;
      }
      if (existing) {
        // renamed/moved on another device
        existing.folder = f.name;
        existing.folderEtag = null;
        await db.notebooks.update(existing.id, { folder: f.name, folderEtag: null });
        plan.push({ nb: existing, entry: f });
      } else {
        const nb: Notebook = {
          id: remote.id,
          name: remote.name,
          color: remote.color,
          order: remote.order,
          createdAt: remote.createdAt,
          times: remote.times,
          folder: f.name,
          folderEtag: null,
          rev: 1,
          syncedRev: 1,
          etag: file.etag,
        };
        await db.notebooks.put(nb);
        this.report.structureChanged = true;
        plan.push({ nb, entry: f });
      }
      seen.add(remote.id);
    }
    await db.setKV('ignoredFolders', ignored);

    for (const nb of locals) {
      if (seen.has(nb.id) || nb.closedAt) continue;
      if (nb.folder === null) {
        plan.push({ nb, entry: null });
        continue;
      }
      // the notebook folder disappeared on the server
      if (await this.notebookHasLocalChanges(nb)) {
        await this.resetNotebook(nb.id);
        plan.push({ nb: { ...nb, folder: null, folderEtag: null, etag: null }, entry: null });
      } else {
        await this.deleteNotebookLocally(nb.id);
        this.report.structureChanged = true;
      }
    }

    for (const { nb, entry } of plan) {
      try {
        await this.syncNotebook(nb, entry, usedNames);
      } catch (e) {
        if (e instanceof NetworkError || (e instanceof DavError && (e.status === 401 || e.status === 507 || e.status === 503))) throw e;
        this.report.errors.push(`${nb.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.progress('');
    return this.report;
  }

  private async notebookHasLocalChanges(nb: Notebook): Promise<boolean> {
    if (isDirty(nb)) return true;
    const sections = await this.db.sections.where('notebookId').equals(nb.id).toArray();
    if (sections.some(isDirty)) return true;
    const pages = await this.db.pages.where('notebookId').equals(nb.id).toArray();
    if (pages.some(isDirty)) return true;
    return (await this.db.assets.where('[notebookId+uploaded]').equals([nb.id, 0]).count()) > 0;
  }

  private async resetNotebook(id: ID) {
    const db = this.db;
    await db.transaction('rw', [db.notebooks, db.sections, db.pages, db.assets, db.kv, db.deletions], async () => {
      await db.notebooks.update(id, { folder: null, folderEtag: null, etag: null, syncedRev: 0 });
      await db.sections.where('notebookId').equals(id).modify((s) => {
        s.etag = null;
        s.syncedRev = 0;
      });
      await db.pages.where('notebookId').equals(id).modify((p) => {
        p.etag = null;
        p.syncedRev = 0;
        p.base = {};
      });
      await db.assets.where('notebookId').equals(id).modify((a) => {
        a.uploaded = 0;
      });
      await db.deletions.where('notebookId').equals(id).delete();
      for (const d of DIRS) await db.kv.delete(`dirEtag:${id}:${d}`);
    });
  }

  private async deleteNotebookLocally(id: ID) {
    const db = this.db;
    await db.transaction('rw', [db.notebooks, db.sections, db.pages, db.bodies, db.assets, db.deletions, db.kv], async () => {
      const pageIds = await db.pages.where('notebookId').equals(id).primaryKeys();
      await db.bodies.bulkDelete(pageIds);
      await db.pages.where('notebookId').equals(id).delete();
      await db.sections.where('notebookId').equals(id).delete();
      await db.assets.where('notebookId').equals(id).delete();
      await db.deletions.where('notebookId').equals(id).delete();
      await db.notebooks.delete(id);
      await db.kv.delete(`dirty:${id}`);
      for (const d of DIRS) await db.kv.delete(`dirEtag:${id}:${d}`);
    });
  }

  private async createNotebookFolder(nb: Notebook, usedNames: Set<string>): Promise<string> {
    const base = sanitizeFolderName(nb.name);
    for (let i = 1; i < 100; i++) {
      const name = i === 1 ? base : `${base} (${i})`;
      if (usedNames.has(name)) continue;
      const created = await this.client.mkcol(joinPath(this.root, name));
      usedNames.add(name);
      if (created) return name;
    }
    throw new Error('Kein freier Ordnername gefunden.');
  }

  private async syncNotebook(nbIn: Notebook, entry: DavEntry | null, usedNames: Set<string>) {
    const { db, client } = this;
    let nb = nbIn;
    const hint = (await db.kv.get(`dirty:${nb.id}`)) !== undefined;
    const hasDeletions = (await db.deletions.where('notebookId').equals(nb.id).count()) > 0;
    if (entry && entry.etag && entry.etag === nb.folderEtag && !hint && !hasDeletions) return;
    this.progress(`Synchronisiere „${nb.name}“ …`);

    let folder = nb.folder;
    if (!entry || !folder) {
      folder = await this.createNotebookFolder(nb, usedNames);
      await db.notebooks.update(nb.id, { folder, folderEtag: null });
      nb = { ...nb, folder };
    } else if (isDirty(nb)) {
      // renamed locally: try to rename the folder as well
      const desired = sanitizeFolderName(nb.name);
      if (desired !== folder && !usedNames.has(desired)) {
        if (await client.move(joinPath(this.root, folder), joinPath(this.root, desired))) {
          usedNames.delete(folder);
          usedNames.add(desired);
          folder = desired;
          await db.notebooks.update(nb.id, { folder, folderEtag: null });
          nb = { ...nb, folder };
        }
      }
    }
    await db.kv.delete(`dirty:${nb.id}`);

    const nbPath = joinPath(this.root, folder);
    const listing = await client.list(nbPath);
    if (!listing) return; // vanished meanwhile, handled next time
    const children = new Map(listing.children.map((c) => [c.name, c]));
    let touched = false;
    for (const d of DIRS) {
      if (!children.get(d)?.isDir) {
        await client.mkcol(joinPath(nbPath, d));
        touched = true;
      }
    }

    touched = (await this.syncEntity(this.notebookAdapter(nb.id), nb.id, joinPath(nbPath, 'notebook.json'), children.get('notebook.json'))) || touched;
    touched = (await this.syncSections(nb, nbPath, children.get('sections'))) || touched;
    touched = (await this.syncPages(nb, nbPath, children.get('pages'))) || touched;
    touched = (await this.syncAssets(nb, nbPath, children.get('assets'))) || touched;

    const stillDirty = (await db.kv.get(`dirty:${nb.id}`)) !== undefined;
    await db.notebooks.update(nb.id, { folderEtag: !touched && !stillDirty && entry ? entry.etag : null });
  }

  private async dirSkippable(key: string, entry: DavEntry | undefined): Promise<boolean> {
    if (!entry?.etag) return false;
    return (await this.db.getKV<string>(key)) === entry.etag;
  }

  private async syncSections(nb: Notebook, nbPath: string, dirEntry: DavEntry | undefined): Promise<boolean> {
    const { db, client } = this;
    const key = `dirEtag:${nb.id}:sections`;
    const locals = await db.sections.where('notebookId').equals(nb.id).toArray();
    const dels = (await db.deletions.where('notebookId').equals(nb.id).toArray()).filter((d) => d.path.startsWith('sections/'));
    if (!locals.some(isDirty) && dels.length === 0 && (await this.dirSkippable(key, dirEntry))) return false;
    const dirPath = joinPath(nbPath, 'sections');
    const listing = await client.list(dirPath);
    const remote = new Map((listing?.children ?? []).filter((f) => !f.isDir && f.name.endsWith('.json')).map((f) => [f.name.slice(0, -5), f]));
    let touched = false;
    for (const d of dels) {
      const id = d.path.slice('sections/'.length, -'.json'.length);
      if (remote.has(id)) {
        await client.delete(joinPath(nbPath, d.path));
        remote.delete(id);
        this.report.deleted++;
        touched = true;
      }
      await db.deletions.delete(d.key);
    }
    const adapter = this.sectionAdapter(nb.id);
    const ids = new Set([...locals.map((s) => s.id), ...remote.keys()]);
    for (const id of ids) {
      touched = (await this.syncEntity(adapter, id, joinPath(dirPath, `${id}.json`), remote.get(id))) || touched;
    }
    await db.setKV(key, touched ? null : (listing?.self.etag ?? null));
    return touched;
  }

  private async syncPages(nb: Notebook, nbPath: string, dirEntry: DavEntry | undefined): Promise<boolean> {
    const { db, client } = this;
    const key = `dirEtag:${nb.id}:pages`;
    const locals = await db.pages.where('notebookId').equals(nb.id).toArray();
    const dels = (await db.deletions.where('notebookId').equals(nb.id).toArray()).filter((d) => d.path.startsWith('pages/'));
    if (!locals.some(isDirty) && dels.length === 0 && (await this.dirSkippable(key, dirEntry))) return false;
    const dirPath = joinPath(nbPath, 'pages');
    const listing = await client.list(dirPath);
    const remote = new Map((listing?.children ?? []).filter((f) => !f.isDir && f.name.endsWith('.json')).map((f) => [f.name.slice(0, -5), f]));
    let touched = false;
    for (const d of dels) {
      const id = d.path.slice('pages/'.length, -'.json'.length);
      if (remote.has(id)) {
        await client.delete(joinPath(nbPath, d.path));
        remote.delete(id);
        this.report.deleted++;
        touched = true;
      }
      await db.deletions.delete(d.key);
    }
    const adapter = this.pageAdapter(nb.id);
    const ids = new Set([...locals.map((p) => p.id), ...remote.keys()]);
    let i = 0;
    for (const id of ids) {
      i++;
      if (ids.size > 20 && i % 10 === 0) this.progress(`„${nb.name}“: Seite ${i} von ${ids.size}`);
      touched = (await this.syncEntity(adapter, id, joinPath(dirPath, `${id}.json`), remote.get(id))) || touched;
    }
    await db.setKV(key, touched ? null : (listing?.self.etag ?? null));
    return touched;
  }

  private async syncAssets(nb: Notebook, nbPath: string, dirEntry: DavEntry | undefined): Promise<boolean> {
    const { db, client } = this;
    const key = `dirEtag:${nb.id}:assets`;
    const pending = await db.assets.where('[notebookId+uploaded]').equals([nb.id, 0]).primaryKeys();
    if (pending.length === 0 && (await this.dirSkippable(key, dirEntry))) return false;
    const dirPath = joinPath(nbPath, 'assets');
    const listing = await client.list(dirPath);
    const remote = new Map<string, DavEntry>();
    for (const f of listing?.children ?? []) {
      if (f.isDir) continue;
      const dot = f.name.lastIndexOf('.');
      remote.set(dot > 0 ? f.name.slice(0, dot) : f.name, f);
    }
    let touched = false;
    for (const id of pending) {
      const asset = await db.assets.get(id);
      if (!asset) continue;
      if (!remote.has(id)) {
        this.progress(`Lade Bild hoch …`);
        const res = await client.put(joinPath(dirPath, `${id}.${extForMime(asset.mime)}`), new Uint8Array(asset.data), {
          contentType: asset.mime,
          ifNoneMatch: true,
        });
        if (res !== 'precondition') this.report.uploaded++;
        touched = true;
      }
      await db.assets.update(id, { uploaded: 1 });
    }
    const localIds = new Set(await db.assets.where('notebookId').equals(nb.id).primaryKeys());
    for (const [id, entry] of remote) {
      if (localIds.has(id)) continue;
      this.progress(`Lade Bild herunter …`);
      const file = await client.get(joinPath(dirPath, entry.name));
      if (!file) continue;
      const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.') + 1) : '';
      const data = file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer;
      await db.assets.put({ id, notebookId: nb.id, mime: mimeForExt(ext), data, uploaded: 1 });
      this.report.downloaded++;
      this.report.assetsChanged = true;
    }
    await db.setKV(key, touched ? null : (listing?.self.etag ?? null));
    return touched;
  }

  // ------------------------------------------------------------- generic file sync

  /** Returns true if something was written to the server. */
  private async syncEntity<L extends SyncFields>(adapter: Adapter<L>, id: ID, path: string, remote: DavEntry | undefined): Promise<boolean> {
    const local = await adapter.load(id);
    if (remote && local) {
      if (remote.etag && remote.etag === local.etag) {
        return isDirty(local) ? this.upload(adapter, id, path) : false;
      }
      const r = await this.download(adapter, id, path);
      if (r === 'gone') {
        if (await adapter.deleteLocalIfClean(id)) return false;
        await adapter.resetEtag(id);
        return this.upload(adapter, id, path);
      }
      return r.dirtyAfter ? this.upload(adapter, id, path) : false;
    }
    if (remote && !local) {
      await this.download(adapter, id, path);
      return false;
    }
    if (!remote && local) {
      if (local.etag === null) return this.upload(adapter, id, path);
      if (await adapter.deleteLocalIfClean(id)) {
        this.report.structureChanged = true;
        return false;
      }
      await adapter.resetEtag(id);
      return this.upload(adapter, id, path);
    }
    return false;
  }

  private async download<L extends SyncFields>(adapter: Adapter<L>, id: ID, path: string): Promise<ApplyResult | 'gone'> {
    const file = await this.client.get(path);
    if (!file) return 'gone';
    let etag = file.etag;
    if (!etag) etag = (await this.client.propfind(path, 0))?.[0]?.etag ?? null;
    const r = await adapter.applyRemote(id, decodeUtf8(file.data), etag);
    if (r === 'invalid') {
      this.report.errors.push(`${adapter.label} ${id}: ungültige Datei auf dem Server wurde übersprungen.`);
      return { dirtyAfter: false, changed: false };
    }
    if (r.changed) this.report.downloaded++;
    return r;
  }

  private async upload<L extends SyncFields>(adapter: Adapter<L>, id: ID, path: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const local = await adapter.load(id);
      if (!local) return false;
      const revAt = local.rev;
      const { text, snapshot } = await adapter.serialize(local);
      const res = await this.client.put(path, text, {
        contentType: 'application/json; charset=utf-8',
        ifMatch: local.etag,
        ifNoneMatch: local.etag === null,
      });
      if (res === 'precondition') {
        const r = await this.download(adapter, id, path);
        if (r === 'gone') {
          await adapter.resetEtag(id);
          continue;
        }
        if (!r.dirtyAfter) return false;
        continue;
      }
      await adapter.markUploaded(id, revAt, res.etag, snapshot);
      this.report.uploaded++;
      return true;
    }
    throw new Error(`${adapter.label}: Konflikt konnte nicht aufgelöst werden, wird später erneut versucht.`);
  }

  // ------------------------------------------------------------- adapters

  private notebookAdapter(nbId: ID): Adapter<Notebook> {
    const db = this.db;
    return {
      label: 'Notizbuch',
      load: (id) => db.notebooks.get(id),
      serialize: async (l) => ({ text: JSON.stringify(notebookToRemote(l)), snapshot: null }),
      applyRemote: async (id, text, etag) => {
        const r = parseNotebook(text);
        if (!r || r.id !== nbId) return 'invalid';
        return db.transaction('rw', db.notebooks, async () => {
          const cur = await db.notebooks.get(id);
          if (!cur) return { dirtyAfter: false, changed: false };
          const remoteRec: Notebook = { ...cur, name: r.name, color: r.color, order: r.order, times: r.times };
          const before = stableStringify(notebookToRemote(cur));
          if (!isDirty(cur)) {
            await db.notebooks.put({ ...remoteRec, etag, syncedRev: cur.rev });
            const changed = before !== stableStringify(notebookToRemote(remoteRec));
            if (changed) this.report.structureChanged = true;
            return { dirtyAfter: false, changed };
          }
          const merged = mergeFields(cur, remoteRec, NOTEBOOK_FIELDS);
          const same = stableStringify(notebookToRemote(merged)) === stableStringify(notebookToRemote(remoteRec));
          await db.notebooks.put({ ...merged, etag, rev: same ? cur.rev : cur.rev + 1, syncedRev: same ? cur.rev : cur.syncedRev });
          if (before !== stableStringify(notebookToRemote(merged))) this.report.structureChanged = true;
          return { dirtyAfter: !same, changed: true };
        });
      },
      markUploaded: async (id, revAt, etag) => {
        await db.transaction('rw', db.notebooks, async () => {
          const cur = await db.notebooks.get(id);
          if (cur) await db.notebooks.put({ ...cur, etag, syncedRev: Math.max(cur.syncedRev, revAt) });
        });
      },
      deleteLocalIfClean: async () => false,
      resetEtag: async (id) => {
        await db.notebooks.update(id, { etag: null });
      },
    };
  }

  private sectionAdapter(nbId: ID): Adapter<Section> {
    const db = this.db;
    return {
      label: 'Abschnitt',
      load: (id) => db.sections.get(id),
      serialize: async (l) => ({ text: JSON.stringify(sectionToRemote(l)), snapshot: null }),
      applyRemote: async (id, text, etag) => {
        const r = parseSection(text);
        if (!r || r.id !== id) return 'invalid';
        return db.transaction('rw', db.sections, async () => {
          const cur = await db.sections.get(id);
          const fromRemote = (base: Partial<Section>): Section => ({
            id,
            notebookId: nbId,
            name: r.name,
            color: r.color,
            order: r.order,
            createdAt: r.createdAt,
            deletedAt: r.deletedAt,
            times: r.times,
            pdfFolder: r.pdfFolder,
            rev: base.rev ?? 1,
            syncedRev: base.rev ?? 1,
            etag,
          });
          this.report.structureChanged = true;
          if (!cur) {
            await db.sections.put(fromRemote({}));
            return { dirtyAfter: false, changed: true };
          }
          // a section that lives in another notebook locally was moved here on another device
          if (!isDirty(cur) || cur.notebookId !== nbId) {
            await db.sections.put(fromRemote({ rev: cur.rev }));
            return { dirtyAfter: false, changed: true };
          }
          const remoteRec = fromRemote({ rev: cur.rev });
          const merged = mergeFields(cur, remoteRec, SECTION_FIELDS);
          merged.createdAt = Math.min(cur.createdAt, r.createdAt || cur.createdAt);
          const same = stableStringify(sectionToRemote(merged)) === stableStringify(sectionToRemote(remoteRec));
          await db.sections.put({ ...merged, etag, rev: same ? cur.rev : cur.rev + 1, syncedRev: same ? cur.rev : cur.syncedRev });
          return { dirtyAfter: !same, changed: true };
        });
      },
      markUploaded: async (id, revAt, etag) => {
        await db.transaction('rw', db.sections, async () => {
          const cur = await db.sections.get(id);
          if (cur) await db.sections.put({ ...cur, etag, syncedRev: Math.max(cur.syncedRev, revAt) });
        });
      },
      deleteLocalIfClean: async (id) =>
        db.transaction('rw', db.sections, db.pages, db.bodies, async () => {
          const cur = await db.sections.get(id);
          if (!cur) return true;
          if (isDirty(cur)) return false;
          await db.sections.delete(id);
          this.report.structureChanged = true;
          return true;
        }),
      resetEtag: async (id) => {
        await db.sections.update(id, { etag: null });
      },
    };
  }

  private pageAdapter(nbId: ID): Adapter<PageMeta> {
    const db = this.db;
    const metaFromRemote = (r: RemotePage, prev: PageMeta | undefined, etag: string | null): PageMeta => ({
      id: r.id,
      notebookId: nbId,
      sectionId: r.sectionId,
      title: r.title,
      order: r.order,
      level: r.level,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt,
      bgColor: r.bgColor,
      rule: r.rule,
      times: r.times,
      searchText: '',
      tags: [],
      base: {},
      rev: prev?.rev ?? 1,
      syncedRev: prev?.rev ?? 1,
      etag,
    });
    return {
      label: 'Seite',
      load: (id) => db.pages.get(id),
      serialize: async (l) => {
        const body = (await db.bodies.get(l.id)) ?? emptyBody(l.id);
        return { text: JSON.stringify(pageToRemote(l, body)), snapshot: elementTimes(body) };
      },
      applyRemote: async (id, text, etag) => {
        const r = parsePage(text);
        if (!r || r.id !== id) return 'invalid';
        const rBody = remoteBody(r);
        return db.transaction('rw', db.pages, db.bodies, async () => {
          const cur = await db.pages.get(id);
          const curBody = (await db.bodies.get(id)) ?? emptyBody(id);
          // moved here from another notebook on another device: the copy in this notebook wins
          const movedHere = !!cur && cur.notebookId !== nbId;
          if (!cur || !isDirty(cur) || movedHere) {
            const meta = derivePage({ ...metaFromRemote(r, cur, etag), base: elementTimes(rBody) }, rBody);
            const changed = !cur || !bodiesEqual(curBody, rBody) || stableStringify(pageToRemote(cur, curBody)) !== stableStringify(r);
            await db.pages.put(meta);
            await db.bodies.put(rBody);
            if (changed) this.report.changedPages.add(id);
            if (!cur || cur.title !== meta.title || cur.sectionId !== meta.sectionId || cur.order !== meta.order || cur.deletedAt !== meta.deletedAt || cur.level !== meta.level) {
              this.report.structureChanged = true;
            }
            return { dirtyAfter: false, changed };
          }
          // both sides changed: merge
          const remoteMeta = metaFromRemote(r, cur, etag);
          const mergedMeta = mergeFields(cur, remoteMeta, PAGE_FIELDS);
          const mb = mergeBodies(curBody, rBody, cur.base);
          this.report.conflicts += mb.conflicts;
          const mergedBody = { id, elements: mb.elements, tombstones: mb.tombstones };
          const finalMeta = derivePage(
            {
              ...mergedMeta,
              createdAt: Math.min(cur.createdAt, r.createdAt || cur.createdAt),
              updatedAt: Math.max(cur.updatedAt, r.updatedAt),
              base: elementTimes(rBody),
              etag,
            },
            mergedBody,
          );
          const same = stableStringify(pageToRemote(finalMeta, mergedBody)) === stableStringify(r);
          finalMeta.rev = same ? cur.rev : cur.rev + 1;
          finalMeta.syncedRev = same ? cur.rev : cur.syncedRev;
          await db.pages.put(finalMeta);
          await db.bodies.put(mergedBody);
          if (!bodiesEqual(curBody, mergedBody)) this.report.changedPages.add(id);
          this.report.structureChanged = true;
          return { dirtyAfter: !same, changed: true };
        });
      },
      markUploaded: async (id, revAt, etag, snapshot) => {
        await db.transaction('rw', db.pages, async () => {
          const cur = await db.pages.get(id);
          if (cur) await db.pages.put({ ...cur, etag, syncedRev: Math.max(cur.syncedRev, revAt), base: snapshot as Record<ID, number> });
        });
      },
      deleteLocalIfClean: async (id) =>
        db.transaction('rw', db.pages, db.bodies, async () => {
          const cur = await db.pages.get(id);
          if (!cur) return true;
          if (isDirty(cur)) return false;
          await db.pages.delete(id);
          await db.bodies.delete(id);
          this.report.changedPages.add(id);
          this.report.structureChanged = true;
          return true;
        }),
      resetEtag: async (id) => {
        await db.pages.update(id, { etag: null, base: {} });
      },
    };
  }
}
