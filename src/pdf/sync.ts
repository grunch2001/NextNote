import { emptyBody } from '../db/repo';
import { bodiesEqual, elementTimes, mergeBodies } from '../model/merge';
import type { ID, PageBody, PdfDoc, Section } from '../model/types';
import { newId } from '../model/util';
import { NetworkError } from '../platform/types';
import { DavError, joinPath, type DavEntry, type WebDavClient } from '../sync/webdav';
import { readAnnotatedPdf, writeAnnotatedPdf, type ReadResult, type WriteOptions } from './annotate';
import { relayout, sameLayout } from './layout';
import { isPdfDirty, isPdfName, uniquePath, type PdfRepo } from './repo';

/**
 * Keeps the PDF sections in step with their Nextcloud folders: every PDF of the folder (and its
 * sub folders) is kept on the device, annotated PDFs are uploaded. The annotations live in the
 * PDF files, so a conflict is resolved like for pages: download, merge per element, upload.
 */

export interface PdfSyncReport {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  errors: string[];
  changedDocs: Set<ID>;
  structureChanged: boolean;
  /** Some PDFs were held back because they are being edited: sync again in this many ms. */
  retryInMs: number | null;
}

export interface PdfSyncOptions {
  /** Text defaults and on-screen sizes for writing text annotations. */
  writeOptions(): Omit<WriteOptions, 'asset'>;
  /** Upload PDFs that are being edited right now as well (explicit save, app goes to the background). */
  force?: boolean;
  onProgress?(message: string): void;
}

const MAX_DEPTH = 8;
const MAX_FILES = 3000;
const isFatal = (e: unknown) => e instanceof NetworkError || (e instanceof DavError && (e.status === 401 || e.status === 507 || e.status === 503));

export class PdfSync {
  private report!: PdfSyncReport;

  constructor(
    private repo: PdfRepo,
    private client: WebDavClient,
    private opts: PdfSyncOptions,
  ) {}

  private get db() {
    return this.repo.db;
  }

  async sync(): Promise<PdfSyncReport> {
    this.report = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: [], changedDocs: new Set(), structureChanged: false, retryInMs: null };
    const all = await this.db.sections.toArray();
    for (const s of all.filter((x) => x.pdfFolder)) {
      try {
        await this.syncSection(s);
      } catch (e) {
        if (isFatal(e)) throw e;
        this.report.errors.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // copies of PDFs whose section is gone (e.g. its notebook was deleted on another device)
    const sectionIds = new Set(all.filter((x) => x.pdfFolder).map((x) => x.id));
    for (const doc of await this.db.pdfDocs.toArray()) {
      if (!sectionIds.has(doc.sectionId) && (!isPdfDirty(doc) || doc.etag === null)) await this.repo.purge(doc.id);
    }
    return this.report;
  }

  private progress(msg: string) {
    this.opts.onProgress?.(msg);
  }

  private async syncSection(section: Section) {
    const { db, client } = this;
    const folder = section.pdfFolder as string;
    const locals = await db.pdfDocs.where('sectionId').equals(section.id).toArray();
    const missingFiles = locals.length - (await db.pdfFiles.where('id').anyOf(locals.map((d) => d.id)).count());
    const pending = locals.some((d) => isPdfDirty(d) || d.deletedAt !== null) || missingFiles > 0;
    // trashed sections: only bring what was written here to the server
    if (section.deletedAt !== null && !pending) return;
    const key = `pdfRoot:${section.id}`;
    const rootInfo = await client.propfind(folder, 0);
    if (!rootInfo) {
      this.report.errors.push(`${section.name}: Der Ordner „${folder}“ wurde in Nextcloud nicht gefunden.`);
      return;
    }
    const rootEtag = rootInfo[0]?.etag ?? null;
    if (!pending && rootEtag && rootEtag === (await db.getKV<string>(key))) return;

    this.progress(`PDFs in „${section.name}“ …`);
    const remote = await this.listTree(folder);
    const byFileId = new Map(locals.filter((d) => d.fileId).map((d) => [d.fileId as string, d]));
    // a PDF added here that was never uploaded is never matched by name: it may be another file with the same name
    const byPath = new Map(locals.filter((d) => d.etag !== null).map((d) => [d.path.toLowerCase(), d]));
    const matched = new Set<ID>();
    let touched = false;
    let i = 0;

    for (const [path, entry] of remote) {
      i++;
      let local = (entry.fileId ? byFileId.get(entry.fileId) : undefined) ?? byPath.get(path.toLowerCase());
      if (local && matched.has(local.id)) local = undefined;
      try {
        if (!local) {
          if (section.deletedAt !== null) continue;
          this.progress(`„${section.name}“: PDF ${i} von ${remote.size} wird geladen …`);
          await this.downloadNew(section, path, entry);
          continue;
        }
        matched.add(local.id);
        if (local.deletedAt !== null) {
          await client.delete(joinPath(folder, path));
          await this.repo.purge(local.id);
          this.report.deleted++;
          this.report.structureChanged = true;
          touched = true;
          continue;
        }
        if (local.path !== path || local.fileId !== (entry.fileId ?? local.fileId)) {
          await db.pdfDocs.update(local.id, { path, fileId: entry.fileId ?? local.fileId });
          local = { ...local, path, fileId: entry.fileId ?? local.fileId };
          this.report.structureChanged = true;
        }
        const hasFile = (await db.pdfFiles.where('id').equals(local.id).count()) > 0;
        if (!hasFile || !entry.etag || entry.etag !== local.etag) {
          this.progress(`„${section.name}“: PDF ${i} von ${remote.size} wird geladen …`);
          const file = await client.get(joinPath(folder, path));
          if (!file) continue;
          local = await this.applyRemote(local, file.data, file.etag ?? entry.etag, entry);
        }
        if (isPdfDirty(local)) touched = (await this.maybeUpload(local, folder)) || touched;
      } catch (e) {
        if (isFatal(e)) throw e;
        this.report.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    for (const local of locals) {
      if (matched.has(local.id)) continue;
      try {
        if (local.deletedAt !== null) {
          await this.repo.purge(local.id);
          continue;
        }
        if (local.etag !== null) {
          // deleted (or moved out of the folder) in Nextcloud
          if (!isPdfDirty(local)) {
            await this.repo.purge(local.id);
            this.report.changedDocs.add(local.id);
            this.report.structureChanged = true;
            continue;
          }
          // … but annotated here in the meantime: put it back
          await db.pdfDocs.update(local.id, { etag: null, fileId: null });
          local.etag = null;
          local.fileId = null;
        }
        if (section.deletedAt === null || local.rev > 1) touched = (await this.maybeUpload(local, folder)) || touched;
      } catch (e) {
        if (isFatal(e)) throw e;
        this.report.errors.push(`${local.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await db.setKV(key, touched ? null : rootEtag);
    await db.setKV(`pdfSynced:${section.id}`, Date.now());
  }

  /** All PDFs below the folder, by path relative to it. */
  private async listTree(folder: string): Promise<Map<string, DavEntry>> {
    const out = new Map<string, DavEntry>();
    const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
    while (queue.length && out.size < MAX_FILES) {
      const { rel, depth } = queue.shift()!;
      const listing = await this.client.list(joinPath(folder, rel));
      if (!listing) continue;
      for (const c of listing.children) {
        if (c.name.startsWith('.')) continue;
        const childRel = rel ? `${rel}/${c.name}` : c.name;
        if (c.isDir) {
          if (depth < MAX_DEPTH) queue.push({ rel: childRel, depth: depth + 1 });
        } else if (isPdfName(c.name)) {
          out.set(childRel, c);
        }
      }
    }
    return out;
  }

  private async read(bytes: Uint8Array): Promise<{ read: ReadResult | null; readOnly: string | null }> {
    try {
      return { read: await readAnnotatedPdf(bytes), readOnly: null };
    } catch (e) {
      return { read: null, readOnly: e instanceof Error ? e.message : String(e) };
    }
  }

  private async downloadNew(section: Section, path: string, entry: DavEntry) {
    const file = await this.client.get(joinPath(section.pdfFolder as string, path));
    if (!file) return;
    const { read, readOnly } = await this.read(file.data);
    const doc: PdfDoc = {
      id: newId(),
      sectionId: section.id,
      path,
      fileId: entry.fileId ?? null,
      etag: file.etag ?? entry.etag,
      size: file.data.byteLength,
      lastModified: entry.lastModified || Date.now(),
      pages: null,
      rev: 1,
      syncedRev: 1,
      base: {},
      deletedAt: null,
      readOnly: null,
      dataVersion: 0,
      baseId: null,
    };
    const body: PageBody = { id: doc.id, elements: Object.fromEntries((read?.elements ?? []).map((e) => [e.id, e])), tombstones: read?.tombstones ?? {} };
    await this.repo.storeFile({ ...doc, base: elementTimes(body) }, file.data, read, readOnly, body);
    this.report.downloaded++;
    this.report.structureChanged = true;
  }

  /** Takes over a newer version from Nextcloud; local changes that were not uploaded yet are merged into it. */
  private async applyRemote(local: PdfDoc, bytes: Uint8Array, etag: string | null, entry: DavEntry | null): Promise<PdfDoc> {
    const { read, readOnly } = await this.read(bytes);
    const remoteBody: PageBody = {
      id: local.id,
      elements: Object.fromEntries((read?.elements ?? []).map((e) => [e.id, e])),
      tombstones: read?.tombstones ?? {},
    };
    const cur = (await this.db.pdfDocs.get(local.id)) ?? local;
    const curBody = (await this.db.pdfBodies.get(local.id)) ?? emptyBody(local.id);
    let body = remoteBody;
    let rev = cur.rev;
    let syncedRev = cur.rev;
    // a file that was never uploaded from here is "dirty" by its missing etag, not by its revision
    if (cur.rev > cur.syncedRev) {
      let mine = curBody;
      if (read && cur.pages && !sameLayout(cur.pages, read.pages)) {
        const moved = relayout(Object.values(curBody.elements), cur.pages, read.pages);
        mine = { ...curBody, elements: Object.fromEntries(moved.map((e) => [e.id, e])) };
      }
      const merged = mergeBodies(mine, remoteBody, cur.base);
      this.report.conflicts += merged.conflicts;
      body = { id: local.id, elements: merged.elements, tombstones: merged.tombstones };
      if (!bodiesEqual(body, remoteBody)) {
        rev = cur.rev + 1;
        syncedRev = cur.syncedRev;
      }
    }
    const next = await this.repo.storeFile(
      {
        ...cur,
        etag,
        size: bytes.byteLength,
        lastModified: entry?.lastModified || Date.now(),
        rev,
        syncedRev,
        base: elementTimes(remoteBody),
      },
      bytes,
      read,
      readOnly,
      body,
    );
    this.report.downloaded++;
    this.report.changedDocs.add(local.id);
    return next;
  }

  /** Uploads unless the PDF is being edited right now. Returns true if something was written. */
  private async maybeUpload(doc: PdfDoc, folder: string): Promise<boolean> {
    if (doc.readOnly) return false;
    const wait = this.opts.force ? 0 : this.repo.uploadDelay(doc.id);
    if (wait > 0) {
      this.report.retryInMs = Math.min(this.report.retryInMs ?? wait, wait + 500);
      return false;
    }
    await this.upload(doc.id, folder);
    return true;
  }

  private async upload(id: ID, folder: string) {
    const { db, client } = this;
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = await db.pdfDocs.get(id);
      const file = await db.pdfFiles.get(id);
      if (!doc || !file || !doc.pages || doc.deletedAt !== null) return;
      const body = await this.repo.getBody(id);
      const revAt = doc.rev;
      this.progress(`„${doc.path}“ wird gespeichert …`);
      const bytes = await writeAnnotatedPdf(new Uint8Array(file.data), doc.pages, { ...body, baseId: doc.baseId }, {
        ...this.opts.writeOptions(),
        asset: (assetId) => this.repo.assetForPdf(assetId),
      });
      const path = joinPath(folder, doc.path);
      const res = await client.put(path, bytes, { contentType: 'application/pdf', ifMatch: doc.etag, ifNoneMatch: doc.etag === null });
      if (res === 'precondition') {
        if (doc.etag === null) {
          // a file with this name appeared in the meantime: keep both
          const dir = doc.path.split('/').slice(0, -1).join('/');
          const listing = await client.list(joinPath(folder, dir));
          const taken = [...(await db.pdfDocs.where('sectionId').equals(doc.sectionId).toArray()).map((d) => d.path), ...(listing?.children ?? []).map((c) => joinPath(dir, c.name))];
          await db.pdfDocs.update(id, { path: uniquePath(doc.path, taken) });
          this.report.structureChanged = true;
          continue;
        }
        const fresh = await client.get(path);
        if (!fresh) {
          await db.pdfDocs.update(id, { etag: null, fileId: null });
          continue;
        }
        await this.applyRemote(doc, fresh.data, fresh.etag, null);
        continue;
      }
      let fileId = doc.fileId;
      if (!fileId) fileId = (await client.propfind(path, 0))?.[0]?.fileId ?? null;
      await db.transaction('rw', db.pdfDocs, async () => {
        const cur = await db.pdfDocs.get(id);
        if (!cur) return;
        await db.pdfDocs.put({
          ...cur,
          etag: res.etag,
          fileId,
          syncedRev: Math.max(cur.syncedRev, revAt),
          base: elementTimes(body),
          size: bytes.byteLength,
          lastModified: Date.now(),
        });
      });
      this.report.uploaded++;
      this.report.structureChanged = true;
      return;
    }
    throw new Error('Die PDF wurde gleichzeitig woanders geändert, es wird später erneut versucht.');
  }
}
