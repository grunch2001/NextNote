import type { NextNoteDB } from '../db/db';
import { emptyBody, pdfAssetOwner, purgePdfDocInTx } from '../db/repo';
import { mergeBodies, pruneTombstones } from '../model/merge';
import type { ID, PageBody, PdfDoc, PdfPageBox } from '../model/types';
import { newId, now } from '../model/util';
import { readAnnotatedPdf, type ReadResult } from './annotate';

/** Hooks that need the browser (pdf.js, canvas); not available in the tests. */
export const pdfHooks: {
  /** Page sizes of a PDF that pdf-lib cannot open (e.g. password protected). */
  pageBoxes: ((bytes: Uint8Array) => Promise<PdfPageBox[]>) | null;
  /** Converts a picture to PNG (for GIF, WebP, SVG). */
  toPng: ((data: ArrayBuffer, mime: string) => Promise<Uint8Array>) | null;
} = { pageBoxes: null, toPng: null };

/** While a PDF is open and was edited recently, it is not uploaded yet (every upload sends the whole file). */
export const UPLOAD_IDLE_MS = 30_000;

export const isPdfName = (name: string) => /\.pdf$/i.test(name);

/** "Übungen/Blatt 1.pdf" -> "Blatt 1" */
export function pdfTitle(path: string): string {
  return (path.split('/').at(-1) ?? path).replace(/\.pdf$/i, '');
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
export const comparePaths = (a: string, b: string) => {
  const sa = a.split('/');
  const sb = b.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    // files before sub folders
    const fa = i === sa.length - 1;
    const fb = i === sb.length - 1;
    if (fa !== fb) return fa ? -1 : 1;
    const c = collator.compare(sa[i], sb[i]);
    if (c) return c;
  }
  return sa.length - sb.length;
};

/** A free file name in the folder, "Name (2).pdf" if "Name.pdf" exists. */
export function uniquePath(path: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((p) => p.toLowerCase()));
  if (!used.has(path.toLowerCase())) return path;
  const dot = path.toLowerCase().endsWith('.pdf') ? path.length - 4 : path.length;
  for (let i = 2; ; i++) {
    const candidate = `${path.slice(0, dot)} (${i})${path.slice(dot)}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export const isPdfDirty = (d: PdfDoc) => d.rev > d.syncedRev || d.etag === null;

export class PdfRepo {
  /** Called after the annotations of a PDF changed locally (used to schedule an upload). */
  onChange: ((docId: ID) => void) | null = null;
  /** Called when a PDF that is only in Nextcloud was opened and has to be loaded. */
  onWanted: ((docId: ID) => void) | null = null;
  /** The PDF open in the editor. */
  openId: ID | null = null;
  private lastEdit = new Map<ID, number>();

  constructor(public db: NextNoteDB) {}

  /** Milliseconds until the PDF may be uploaded (0: now). */
  uploadDelay(id: ID): number {
    if (id !== this.openId) return 0;
    const t = this.lastEdit.get(id);
    return t === undefined ? 0 : Math.max(0, t + UPLOAD_IDLE_MS - Date.now());
  }

  async listDocs(sectionId: ID): Promise<PdfDoc[]> {
    const all = await this.db.pdfDocs.where('sectionId').equals(sectionId).toArray();
    return all.filter((d) => d.deletedAt === null).sort((a, b) => comparePaths(a.path, b.path));
  }

  getDoc(id: ID) {
    return this.db.pdfDocs.get(id);
  }

  /** The PDF was opened: from now on it is kept on this device (it is loaded with the next sync). */
  async want(id: ID): Promise<void> {
    const doc = await this.db.pdfDocs.get(id);
    if (!doc || doc.offline !== false) return;
    await this.db.pdfDocs.update(id, { offline: true });
    this.onWanted?.(id);
  }

  /** Tries again to load a PDF whose loading was interrupted (see PdfDoc.loadFailed). */
  async retryLoad(id: ID): Promise<void> {
    await this.db.pdfDocs.update(id, { offline: true, loadFailed: false });
    this.onWanted?.(id);
  }

  async getBody(id: ID): Promise<PageBody> {
    return (await this.db.pdfBodies.get(id)) ?? emptyBody(id);
  }

  /** Saves the annotations; like pages, changes a sync wrote in the meantime are merged, not overwritten. */
  async saveBody(id: ID, body: PageBody): Promise<void> {
    const db = this.db;
    await db.transaction('rw', db.pdfDocs, db.pdfBodies, async () => {
      const doc = await db.pdfDocs.get(id);
      if (!doc) return;
      const stored = await db.pdfBodies.get(id);
      const merged = stored ? mergeBodies(stored, body, {}) : body;
      await db.pdfBodies.put({ id, elements: merged.elements, tombstones: pruneTombstones(merged.tombstones, now()) });
      await db.pdfDocs.put({ ...doc, rev: doc.rev + 1 });
    });
    this.lastEdit.set(id, Date.now());
    const cb = this.onChange;
    if (cb) queueMicrotask(() => cb(id));
  }

  /** Stores what was read from a PDF file: the file without annotations, pages, annotations, pictures. */
  async storeFile(doc: PdfDoc, bytes: Uint8Array, read: ReadResult | null, readOnly: string | null, body: PageBody): Promise<PdfDoc> {
    const db = this.db;
    const pages = read?.pages ?? (pdfHooks.pageBoxes ? await pdfHooks.pageBoxes(bytes).catch(() => null) : null);
    const keepFile = !!read?.baseId && read.baseId === doc.baseId && (await db.pdfFiles.where('id').equals(doc.id).count()) > 0;
    const next: PdfDoc = {
      ...doc,
      pages,
      readOnly: pages ? readOnly : (readOnly ?? 'Die PDF konnte nicht gelesen werden.'),
      baseId: read?.baseId ?? (keepFile ? doc.baseId : newId()),
      dataVersion: keepFile ? doc.dataVersion : doc.dataVersion + 1,
    };
    const file = read?.clean ?? bytes;
    await db.transaction('rw', [db.pdfDocs, db.pdfBodies, db.pdfFiles, db.assets], async () => {
      if (!keepFile) await db.pdfFiles.put({ id: doc.id, data: file.slice().buffer as ArrayBuffer });
      await db.pdfBodies.put(body);
      await db.pdfDocs.put(next);
      for (const img of read?.images ?? []) {
        if (await db.assets.get(img.id)) continue;
        await db.assets.put({ id: img.id, notebookId: pdfAssetOwner(doc.id), mime: img.mime, data: img.data.slice().buffer as ArrayBuffer, uploaded: 1 });
      }
    });
    return next;
  }

  /** Adds a PDF from this device to the folder of a section; it is uploaded with the next sync. */
  async addFile(sectionId: ID, name: string, bytes: Uint8Array, folder = ''): Promise<PdfDoc> {
    const existing = (await this.db.pdfDocs.where('sectionId').equals(sectionId).toArray()).map((d) => d.path);
    const clean = name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Dokument.pdf';
    const path = uniquePath((folder ? `${folder}/` : '') + (isPdfName(clean) ? clean : `${clean}.pdf`), existing);
    let read: ReadResult | null = null;
    let readOnly: string | null = null;
    try {
      read = await readAnnotatedPdf(bytes);
    } catch (e) {
      readOnly = e instanceof Error ? e.message : String(e);
    }
    const doc: PdfDoc = {
      id: newId(),
      sectionId,
      path,
      fileId: null,
      etag: null,
      size: bytes.byteLength,
      lastModified: now(),
      pages: null,
      rev: 1,
      syncedRev: 0,
      base: {},
      deletedAt: null,
      readOnly: null,
      dataVersion: 0,
      baseId: null,
      offline: true,
    };
    const body: PageBody = { id: doc.id, elements: Object.fromEntries((read?.elements ?? []).map((e) => [e.id, e])), tombstones: read?.tombstones ?? {} };
    const stored = await this.storeFile(doc, bytes, read, readOnly, body);
    this.onChange?.(stored.id);
    return stored;
  }

  /** Deletes the PDF here and (with the next sync) in Nextcloud. */
  async trash(id: ID): Promise<void> {
    const db = this.db;
    await db.transaction('rw', [db.pdfDocs, db.pdfBodies, db.pdfFiles, db.assets], async () => {
      const doc = await db.pdfDocs.get(id);
      if (!doc) return;
      if (doc.etag === null) await purgePdfDocInTx(db, id);
      else await db.pdfDocs.put({ ...doc, deletedAt: now() });
    });
    this.onChange?.(id);
  }

  async setPath(id: ID, path: string): Promise<void> {
    await this.db.pdfDocs.update(id, { path });
  }

  async purge(id: ID): Promise<void> {
    const db = this.db;
    await db.transaction('rw', [db.pdfDocs, db.pdfBodies, db.pdfFiles, db.assets], () => purgePdfDocInTx(db, id));
  }

  /** The picture of an image element as PNG or JPEG, for writing it into the PDF. */
  async assetForPdf(id: ID): Promise<{ data: Uint8Array; mime: string } | null> {
    const a = await this.db.assets.get(id);
    if (!a) return null;
    if (a.mime === 'image/png' || a.mime === 'image/jpeg') return { data: new Uint8Array(a.data), mime: a.mime };
    if (!pdfHooks.toPng) return null;
    return { data: await pdfHooks.toPng(a.data, a.mime), mime: 'image/png' };
  }
}
