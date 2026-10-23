/**
 * Imports OneNote notebooks (via Microsoft Graph) as new NextNote notebooks. Section groups are
 * flattened into "Group › Section" names. Pages keep their order, level, dates, positioned text,
 * images and ink; the regular sync then uploads everything to Nextcloud.
 */
import type { Repo } from '../../db/repo';
import { translateElement } from '../../ink/geometry';
import type { ID, PageElement } from '../../model/types';
import { newId, now } from '../../model/util';
import { CancelledError, MsAuthError } from './auth';
import type { GraphClient, GraphNotebook, GraphPage, GraphSection } from './graph';
import { convertPageHtml, type MeasureFn, type PageImage } from './html';
import { parseInkML, type InkStroke } from './inkml';

export interface PreparedImage {
  data: ArrayBuffer;
  mime: string;
  width: number;
  height: number;
}

/** Turns downloaded image bytes into what NextNote stores (e.g. shrinks huge photos). */
export type ImageProcessor = (data: Uint8Array, mime: string) => Promise<PreparedImage>;

export interface ImportProgress {
  notebook: string;
  section: string;
  page: string;
  done: number;
  /** 0 while the table of contents is loaded. */
  total: number;
}

export interface ImportSummary {
  notebooks: Array<{ id: ID; name: string }>;
  sections: number;
  pages: number;
  images: number;
  strokes: number;
  attachments: number;
  videos: number;
  failedImages: number;
  failedPages: Array<{ title: string; error: string }>;
  cancelled: boolean;
  /** Set when the import stopped early because of an error. */
  error: string | null;
}

export interface ImportOptions {
  graph: GraphClient;
  repo: Repo;
  notebooks: GraphNotebook[];
  onProgress?(p: ImportProgress): void;
  isCancelled?(): boolean;
  measure?: MeasureFn;
  processImage?: ImageProcessor;
}

/** Width for images whose size the page does not state. */
const DEFAULT_IMAGE_WIDTH = 640;
/** Minimum distance of imported content from the left and top edge of the page. */
const EDGE_MARGIN = 8;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const toArrayBuffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const passThrough: ImageProcessor = async (data, mime) => ({ data: toArrayBuffer(data), mime, width: 0, height: 0 });

/** Display size: the size stated on the page, completed from the natural size. */
function displaySize(img: PageImage, natural: PreparedImage): { w: number; h: number } {
  const nw = natural.width || 400;
  const nh = natural.height || 300;
  if (img.w && img.h) return { w: img.w, h: img.h };
  if (img.w) return { w: img.w, h: Math.round((img.w * nh) / nw) };
  if (img.h) return { w: Math.round((img.h * nw) / nh), h: img.h };
  const s = Math.min(1, DEFAULT_IMAGE_WIDTH / nw);
  return { w: Math.round(nw * s), h: Math.round(nh * s) };
}

/**
 * OneNote still shows ink that reaches a little past the left or top edge of the page (it comes with
 * negative coordinates), NextNote cuts everything off there. Such pages are moved as a whole, so the
 * layout stays as it was.
 */
export function moveIntoView(elements: PageElement[]): PageElement[] {
  let minX = Infinity;
  let minY = Infinity;
  for (const el of elements) {
    if (el.type === 'ink') {
      const r = el.size / 2;
      for (let i = 0; i < el.pts.length; i += 3) {
        minX = Math.min(minX, el.pts[i] - r);
        minY = Math.min(minY, el.pts[i + 1] - r);
      }
    } else {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
    }
  }
  const dx = minX < EDGE_MARGIN ? Math.ceil(EDGE_MARGIN - minX) : 0;
  const dy = minY < EDGE_MARGIN ? Math.ceil(EDGE_MARGIN - minY) : 0;
  if (!dx && !dy) return elements;
  return elements.map((el) => translateElement(el, dx, dy));
}

export async function importFromOneNote(opts: ImportOptions): Promise<ImportSummary> {
  const { graph, repo } = opts;
  const processImage = opts.processImage ?? passThrough;
  const summary: ImportSummary = {
    notebooks: [],
    sections: 0,
    pages: 0,
    images: 0,
    strokes: 0,
    attachments: 0,
    videos: 0,
    failedImages: 0,
    failedPages: [],
    cancelled: false,
    error: null,
  };
  const check = () => {
    if (opts.isCancelled?.()) throw new CancelledError();
  };
  const progress = (p: ImportProgress) => opts.onProgress?.(p);

  const image = async (notebookId: ID, img: PageImage, ts: number, z: number): Promise<PageElement | null> => {
    const sources = [
      { src: img.src, mime: img.mime },
      ...(img.fallbackSrc ? [{ src: img.fallbackSrc, mime: img.fallbackMime }] : []),
    ].filter((s) => graph.isGraphUrl(s.src));
    for (const s of sources) {
      check();
      try {
        const res = await graph.resource(s.src);
        const mime = res.mime?.startsWith('image/') ? res.mime : (s.mime ?? 'image/png');
        const prepared = await processImage(res.data, mime);
        const { w, h } = displaySize(img, prepared);
        const asset = await repo.addAsset(notebookId, prepared.data, prepared.mime);
        return { id: newId(), type: 'image', x: img.x, y: img.y, w, h, asset, mime: prepared.mime, z, updatedAt: ts };
      } catch (e) {
        if (e instanceof CancelledError || e instanceof MsAuthError) throw e;
      }
    }
    return null;
  };

  const importPage = async (page: GraphPage, notebookId: ID, sectionId: ID) => {
    const content = await graph.pageContent(page.id);
    const converted = convertPageHtml(content.html, { measure: opts.measure });
    const strokes: InkStroke[] = [];
    for (const part of content.inkml) strokes.push(...parseInkML(part));
    const ts = now();
    let z = ts;
    const elements: PageElement[] = [];
    // images at the bottom, text above them, ink on top (like annotations on a printout)
    for (const img of converted.images) {
      const el = await image(notebookId, img, ts, z++);
      if (el) {
        elements.push(el);
        summary.images++;
      } else {
        summary.failedImages++;
      }
    }
    for (const t of converted.texts) elements.push({ id: newId(), type: 'text', x: t.x, y: t.y, w: t.w, doc: t.doc, z: z++, updatedAt: ts });
    for (const s of strokes) {
      elements.push({
        id: newId(),
        type: 'ink',
        tool: s.highlighter ? 'highlighter' : 'pen',
        color: s.color,
        size: Math.round(Math.min(48, Math.max(0.5, s.width)) * 100) / 100,
        pts: s.pts,
        ...(s.pressure ? {} : { sim: true }),
        z: z++,
        updatedAt: ts,
      });
    }
    summary.strokes += strokes.length;
    summary.attachments += converted.attachments;
    summary.videos += converted.videos;
    const createdAt = Date.parse(page.createdDateTime ?? '') || ts;
    const updatedAt = Date.parse(page.lastModifiedDateTime ?? '') || createdAt;
    await repo.addPage(sectionId, { title: page.title ?? converted.title, level: page.level ?? 0, createdAt, updatedAt, elements: moveIntoView(elements) });
  };

  try {
    // table of contents first, so that the progress has a total
    const plan: Array<{ nb: GraphNotebook; sections: Array<{ section: GraphSection; pages: GraphPage[] }> }> = [];
    for (const nb of opts.notebooks) {
      progress({ notebook: nb.displayName, section: '', page: '', done: 0, total: 0 });
      const sections: Array<{ section: GraphSection; pages: GraphPage[] }> = [];
      for (const section of await graph.sections(nb.id)) {
        check();
        progress({ notebook: nb.displayName, section: section.displayName, page: '', done: 0, total: 0 });
        sections.push({ section, pages: await graph.pages(section.id) });
      }
      plan.push({ nb, sections });
    }
    const total = plan.reduce((n, p) => n + p.sections.reduce((m, s) => m + s.pages.length, 0), 0);
    let done = 0;
    const names = new Set((await repo.listNotebooks()).map((n) => n.name));
    for (const { nb, sections } of plan) {
      check();
      let name = nb.displayName.trim() || 'OneNote';
      if (names.has(name)) {
        let i = 1;
        while (names.has(`${nb.displayName} (OneNote${i > 1 ? ` ${i}` : ''})`)) i++;
        name = `${nb.displayName} (OneNote${i > 1 ? ` ${i}` : ''})`;
      }
      names.add(name);
      const notebook = await repo.addNotebook(name);
      summary.notebooks.push({ id: notebook.id, name: notebook.name });
      for (const { section, pages } of sections) {
        check();
        const sec = await repo.createSection(notebook.id, [...section.groups, section.displayName].join(' › '), { withPage: false });
        summary.sections++;
        for (const page of pages) {
          check();
          const title = page.title?.trim() || 'Ohne Titel';
          progress({ notebook: notebook.name, section: sec.name, page: title, done, total });
          try {
            await importPage(page, notebook.id, sec.id);
            summary.pages++;
          } catch (e) {
            if (e instanceof CancelledError || e instanceof MsAuthError) throw e;
            summary.failedPages.push({ title: `${sec.name} › ${title}`, error: errorText(e) });
          }
          done++;
        }
      }
    }
    progress({ notebook: '', section: '', page: '', done, total });
  } catch (e) {
    if (e instanceof CancelledError) summary.cancelled = true;
    else summary.error = errorText(e);
  }
  return summary;
}
