import type { PDFDocument, PDFFont, PDFObject, PDFPage, PDFRef as PDFRefT, PDFDict as PDFDictT } from '@cantoo/pdf-lib';
import type { ID, ImageElement, InkElement, PageElement, PdfPageBox, TextElement } from '../model/types';
import { validElement } from '../model/serialize';
import { docToText, paragraphDoc } from '../model/text';
import { decodeUtf8, encodeUtf8 } from '../model/util';
import { axesPolylines, elementBounds, strokeRuns } from '../ink/geometry';
import { DIRECT_TOLERANCE, directShapes } from '../ink/direct';
import { freehandOutline, HIGHLIGHTER_OPACITY } from '../ink/render';
import {
  applyMatrix,
  displayToUser,
  elementPage,
  fromPageLocal,
  invertMatrix,
  pdfLayout,
  PX_PER_PT,
  relayout,
  sameLayout,
  toPageLocal,
  type Matrix,
} from './layout';
import { layoutText, parseColor, type FontRef, type Measurer, type RGB, type TextDefaults, type TextOp } from './textLayout';

/**
 * NextNote's annotations are stored in the PDF as standard annotations (Ink, FreeText, Stamp)
 * with an appearance stream, so every PDF viewer shows them. Each one also carries the
 * original NextNote element as JSON (key /NextNote), so NextNote can read it back unchanged
 * (pressure, formatted text …). Annotations of other apps are left alone.
 */

type PdfLib = typeof import('@cantoo/pdf-lib');
let libPromise: Promise<PdfLib> | null = null;
export const loadPdfLib = () => (libPromise ??= import('@cantoo/pdf-lib'));

/** Values as accepted by PDFContext.obj() (strings become names). */
type Literal = PDFObject | string | number | boolean | Literal[] | LiteralDict;
type LiteralDict = { [key: string]: Literal };

const MARK = 'nextnote:';
const DATA_KEY = 'NextNote';
const IMAGE_KEY = 'NextNoteImage';
const FORMAT = 1;

export interface ReadResult {
  /** The file without NextNote's annotations, null if it had none (then the original is that file). */
  clean: Uint8Array | null;
  pages: PdfPageBox[];
  /** Elements in the coordinates of the stacked page layout (see layout.ts). */
  elements: PageElement[];
  tombstones: Record<ID, number>;
  /** Pictures of image elements, by asset id. */
  images: Array<{ id: ID; mime: string; data: Uint8Array }>;
  /** Identifies the file without annotations, so that a device can keep its copy when only the annotations changed. */
  baseId: string | null;
}

export interface WriteOptions extends TextDefaults {
  /** On-screen sizes of text containers, if known. */
  measured?: Map<ID, { w: number; h: number }>;
  /** Picture of an image element as PNG or JPEG. */
  asset(id: ID): Promise<{ data: Uint8Array; mime: string } | null>;
}

/** Thrown when a PDF cannot be opened for writing (e.g. a password is needed). */
export class PdfAccessError extends Error {}

interface PageInfo {
  box: PdfPageBox;
  toUser: Matrix;
}

/** UTF-8 bytes of a JSON value (copied, so pdf-lib recognises the array in every JS realm). */
const jsonBytes = (v: unknown) => new Uint8Array(encodeUtf8(JSON.stringify(v)));

const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: number) => {
  const r = r2(v);
  return Object.is(r, -0) ? '0' : String(r);
};

/** The first bytes of an object as written to the file. */
function headOf(obj: PDFObject): string {
  const bytes = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(bytes, 0);
  return String.fromCharCode(...bytes.subarray(0, 400));
}

async function openDoc(lib: PdfLib, bytes: Uint8Array): Promise<PDFDocument> {
  try {
    // an empty password opens files that are only protected against changes (common for lecture notes)
    const doc = await lib.PDFDocument.load(bytes, { password: '', updateMetadata: false, throwOnInvalidObject: false });
    // Old cross-reference streams would be written again (a fresh one is written anyway). In a
    // decrypted file they still name the encryption, and the saved file could not be opened.
    const { PDFName, PDFRawStream, PDFInvalidObject, PDFDict } = lib;
    const decrypted = (doc.context as unknown as { isDecrypted?: boolean }).isDecrypted;
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      const xref =
        (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Type')) === PDFName.of('XRef')) ||
        (obj instanceof PDFInvalidObject && /\/Type\s*\/XRef/.test(headOf(obj)));
      const encryptDict = decrypted && obj instanceof PDFDict && obj.get(PDFName.of('Filter')) === PDFName.of('Standard') && obj.has(PDFName.of('O'));
      if (xref || encryptDict) doc.context.delete(ref);
    }
    return doc;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|encrypt/i.test(msg)) throw new PdfAccessError('Die PDF ist mit einem Passwort geschützt.');
    throw new PdfAccessError(`Die PDF konnte nicht gelesen werden (${msg}).`);
  }
}

function pageInfo(page: PDFPage): PageInfo {
  const norm = (r: { x: number; y: number; width: number; height: number }) => ({
    x0: Math.min(r.x, r.x + r.width),
    y0: Math.min(r.y, r.y + r.height),
    x1: Math.max(r.x, r.x + r.width),
    y1: Math.max(r.y, r.y + r.height),
  });
  const media = norm(page.getMediaBox());
  const crop = norm(page.getCropBox());
  // like pdf.js: the crop box, clipped to the media box
  let box = { x0: Math.max(crop.x0, media.x0), y0: Math.max(crop.y0, media.y0), x1: Math.min(crop.x1, media.x1), y1: Math.min(crop.y1, media.y1) };
  if (box.x1 - box.x0 < 1 || box.y1 - box.y0 < 1) box = media;
  const rotate = (((page.getRotation().angle % 360) + 360) % 360) as number;
  const swap = rotate === 90 || rotate === 270;
  const wPt = box.x1 - box.x0;
  const hPt = box.y1 - box.y0;
  return {
    box: { w: r2((swap ? hPt : wPt) * PX_PER_PT), h: r2((swap ? wPt : hPt) * PX_PER_PT) },
    toUser: displayToUser(box, rotate),
  };
}

/** Page sizes of a PDF (without reading annotations). */
export async function readPdfPages(bytes: Uint8Array): Promise<PdfPageBox[]> {
  const lib = await loadPdfLib();
  const doc = await openDoc(lib, bytes);
  return doc.getPages().map((p) => pageInfo(p).box);
}

function userRect(m: Matrix, x: number, y: number, w: number, h: number): number[] {
  const pts = [applyMatrix(m, x, y), applyMatrix(m, x + w, y), applyMatrix(m, x, y + h), applyMatrix(m, x + w, y + h)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(r2);
}

function readStreamBytes(lib: PdfLib, obj: PDFObject | undefined, decode: boolean): Uint8Array | null {
  if (!(obj instanceof lib.PDFRawStream)) return null;
  if (!decode) return obj.contents;
  try {
    return lib.decodePDFRawStream(obj).decode();
  } catch {
    return null;
  }
}

function textOf(lib: PdfLib, obj: PDFObject | undefined): string | null {
  if (obj instanceof lib.PDFString || obj instanceof lib.PDFHexString) return obj.decodeText();
  return null;
}

/** All objects reachable from an annotation, except its page. */
function collectRefs(lib: PdfLib, doc: PDFDocument, obj: PDFObject | undefined, out: Set<PDFRefT>) {
  if (!obj) return;
  if (obj instanceof lib.PDFRef) {
    if (out.has(obj)) return;
    out.add(obj);
    collectRefs(lib, doc, doc.context.lookup(obj), out);
  } else if (obj instanceof lib.PDFDict) {
    for (const [key, value] of obj.entries()) {
      if (key === lib.PDFName.of('P') || key === lib.PDFName.of('Parent')) continue;
      collectRefs(lib, doc, value, out);
    }
  } else if (obj instanceof lib.PDFArray) {
    for (let i = 0; i < obj.size(); i++) collectRefs(lib, doc, obj.get(i), out);
  } else if (obj instanceof lib.PDFStream) {
    collectRefs(lib, doc, obj.dict, out);
  }
}

// ------------------------------------------------------------------ reading

export async function readAnnotatedPdf(bytes: Uint8Array): Promise<ReadResult> {
  const lib = await loadPdfLib();
  const doc = await openDoc(lib, bytes);
  const { PDFName, PDFArray, PDFDict, PDFRef } = lib;
  const pages = doc.getPages();
  const infos = pages.map(pageInfo);
  const slots = pdfLayout(infos.map((i) => i.box)).slots;
  const elements: PageElement[] = [];
  const images: ReadResult['images'] = [];
  const garbage = new Set<PDFRefT>();
  let changed = false;

  pages.forEach((page, pi) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return;
    const keep: PDFObject[] = [];
    let removed = false;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = raw instanceof PDFRef ? doc.context.lookupMaybe(raw, PDFDict) : raw instanceof PDFDict ? raw : undefined;
      const name = dict ? textOf(lib, dict.lookup(PDFName.of('NM'))) : null;
      const parsed = dict && name?.startsWith(MARK) ? parseAnnotation(lib, dict, name.slice(MARK.length), infos[pi], i) : null;
      if (!parsed) {
        keep.push(raw);
        continue;
      }
      elements.push(fromPageLocal(parsed.el, slots[pi]));
      if (parsed.image) images.push(parsed.image);
      collectRefs(lib, doc, raw, garbage);
      removed = true;
    }
    if (removed) {
      changed = true;
      if (keep.length) page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
      else page.node.delete(PDFName.of('Annots'));
    }
  });

  let tombstones: Record<ID, number> = {};
  let baseId: string | null = null;
  const meta = doc.catalog.lookupMaybe(PDFName.of(DATA_KEY), PDFDict);
  if (meta) {
    baseId = textOf(lib, meta.lookup(PDFName.of('Base')));
    const json = readStreamBytes(lib, meta.lookup(PDFName.of('Tombstones')), true);
    try {
      const v = json ? JSON.parse(decodeUtf8(json)) : null;
      if (v && typeof v === 'object') for (const [k, t] of Object.entries(v)) if (typeof t === 'number') tombstones[k] = t;
    } catch {
      tombstones = {};
    }
    collectRefs(lib, doc, doc.catalog.get(PDFName.of(DATA_KEY)), garbage);
    doc.catalog.delete(PDFName.of(DATA_KEY));
    changed = true;
  }

  let clean: Uint8Array | null = null;
  if (changed) {
    for (const ref of garbage) doc.context.delete(ref);
    clean = await doc.save({ updateFieldAppearances: false, addDefaultPage: false });
  }
  return { clean, pages: infos.map((i) => i.box), elements, tombstones, images, baseId };
}

interface StoredData {
  v: number;
  el: PageElement;
  /** /Rect at the time of writing: if another app moved the annotation, the element follows. */
  rect?: number[];
}

function parseAnnotation(
  lib: PdfLib,
  dict: PDFDictT,
  id: string,
  info: PageInfo,
  index: number,
): { el: PageElement; image?: { id: ID; mime: string; data: Uint8Array } } | null {
  const { PDFName, PDFArray, PDFNumber } = lib;
  const rectArr = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
  const rect = rectArr ? rectArr.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0)) : null;
  const toDisplay = invertMatrix(info.toUser);
  const json = readStreamBytes(lib, dict.lookup(PDFName.of(DATA_KEY)), true);
  if (json) {
    let data: StoredData | null = null;
    try {
      data = JSON.parse(decodeUtf8(json)) as StoredData;
    } catch {
      data = null;
    }
    if (data && validElement(data.el) && data.el.id === id) {
      let el = data.el;
      if (typeof el.z !== 'number') el = { ...el, z: el.updatedAt };
      // moved in another PDF app (same size, other place): follow it
      if (rect && data.rect?.length === 4) {
        const dx = rect[0] - data.rect[0];
        const dy = rect[1] - data.rect[1];
        const sameSize = Math.abs(rect[2] - rect[0] - (data.rect[2] - data.rect[0])) < 0.5 && Math.abs(rect[3] - rect[1] - (data.rect[3] - data.rect[1])) < 0.5;
        if (sameSize && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
          const [u, v] = [toDisplay[0] * dx + toDisplay[2] * dy, toDisplay[1] * dx + toDisplay[3] * dy];
          el = moveBy(el, u, v);
        }
      }
      if (el.type === 'image') {
        const raw = readStreamBytes(lib, dict.lookup(PDFName.of(IMAGE_KEY)), false);
        if (!raw) return null;
        return { el, image: { id: el.asset, mime: el.mime, data: raw } };
      }
      return { el };
    }
  }
  // the NextNote data got lost (e.g. another app rewrote the annotation): rebuild what we can
  const subtype = dict.lookup(PDFName.of('Subtype'));
  const color = dict.lookupMaybe(PDFName.of('C'), PDFArray)?.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
  const hex = color && color.length === 3 ? '#' + color.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('') : '#000000';
  if (subtype === PDFName.of('Ink')) {
    const lists = dict.lookupMaybe(PDFName.of('InkList'), PDFArray);
    const bs = dict.lookupMaybe(PDFName.of('BS'), lib.PDFDict);
    const w = bs?.lookupMaybe(PDFName.of('W'), PDFNumber)?.asNumber() ?? 1.5;
    const first = lists?.lookupMaybe(0, PDFArray);
    if (!first) return null;
    const nums = first.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
    const pts: number[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const [u, v] = applyMatrix(toDisplay, nums[i], nums[i + 1]);
      pts.push(r2(u), r2(v), 0.5);
    }
    if (pts.length < 3) return null;
    const el: InkElement = { id, type: 'ink', tool: 'pen', color: hex, size: r2(w * PX_PER_PT), pts, sim: true, z: index, updatedAt: 1 };
    return { el };
  }
  if (subtype === PDFName.of('FreeText') && rect) {
    const text = textOf(lib, dict.lookup(PDFName.of('Contents'))) ?? '';
    const corners = [applyMatrix(toDisplay, rect[0], rect[1]), applyMatrix(toDisplay, rect[2], rect[3])];
    const el: TextElement = {
      id,
      type: 'text',
      x: r2(Math.min(corners[0][0], corners[1][0])),
      y: r2(Math.min(corners[0][1], corners[1][1])),
      w: null,
      doc: paragraphDoc(text),
      z: index,
      updatedAt: 1,
    };
    return { el };
  }
  return null;
}

function moveBy(el: PageElement, dx: number, dy: number): PageElement {
  if (el.type === 'ink') {
    const pts = el.pts.slice();
    for (let i = 0; i < pts.length; i += 3) {
      pts[i] = r2(pts[i] + dx);
      pts[i + 1] = r2(pts[i + 1] + dy);
    }
    return { ...el, pts };
  }
  return { ...el, x: r2(el.x + dx), y: r2(el.y + dy) };
}

// ------------------------------------------------------------------ writing

/** Draw order: pictures, text, highlighter, pen (like on a NextNote page). */
function layer(el: PageElement): number {
  if (el.type === 'image') return 0;
  if (el.type === 'text') return 1;
  return el.tool === 'highlighter' ? 2 : 3;
}

const rgbOps = (c: RGB, stroke: boolean) => `${c.map(num).join(' ')} ${stroke ? 'RG' : 'rg'}`;

/** perfect-freehand outline -> closed path with the same smoothing as outlineToPath (quadratic curves as cubics). */
function outlineOps(points: number[][]): string {
  const len = points.length;
  if (len < 4) return '';
  const avg = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const quad = (p0: number[], c: number[], p1: number[]) =>
    `${num(p0[0] + (2 / 3) * (c[0] - p0[0]))} ${num(p0[1] + (2 / 3) * (c[1] - p0[1]))} ${num(p1[0] + (2 / 3) * (c[0] - p1[0]))} ${num(p1[1] + (2 / 3) * (c[1] - p1[1]))} ${num(p1[0])} ${num(p1[1])} c`;
  const out: string[] = [`${num(points[0][0])} ${num(points[0][1])} m`];
  let cur = avg(points[1], points[2]);
  let ctrl = points[1];
  out.push(quad(points[0], ctrl, cur));
  for (let i = 2; i < len - 1; i++) {
    const target = avg(points[i], points[i + 1]);
    ctrl = [2 * cur[0] - ctrl[0], 2 * cur[1] - ctrl[1]];
    out.push(quad(cur, ctrl, target));
    cur = target;
  }
  out.push('h f');
  return out.join('\n');
}

function polylineOps(pts: number[], stride: number): string {
  if (pts.length < 2) return '';
  const out = [`${num(pts[0])} ${num(pts[1])} m`];
  if (pts.length <= stride) out.push(`${num(pts[0] + 0.01)} ${num(pts[1] + 0.01)} l`);
  for (let i = stride; i + 1 < pts.length; i += stride) out.push(`${num(pts[i])} ${num(pts[i + 1])} l`);
  return out.join(' ');
}

function ellipseOps(cx: number, cy: number, rx: number, ry: number): string {
  const k = 0.5522847498;
  const ox = rx * k;
  const oy = ry * k;
  return [
    `${num(cx - rx)} ${num(cy)} m`,
    `${num(cx - rx)} ${num(cy - oy)} ${num(cx - ox)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`,
    `${num(cx + ox)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - oy)} ${num(cx + rx)} ${num(cy)} c`,
    `${num(cx + rx)} ${num(cy + oy)} ${num(cx + ox)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`,
    `${num(cx - ox)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + oy)} ${num(cx - rx)} ${num(cy)} c h`,
  ].join(' ');
}

/** Drawing operators of a stroke in page-local CSS pixels, and whether it needs transparency. */
function inkOps(el: InkElement): { ops: string; alpha: number } {
  const color = parseColor(el.color, [0, 0, 0]) as RGB;
  const strokeStyle = `${rgbOps(color, true)} ${num(el.size)} w 1 J 1 j`;
  if (el.shape) {
    const [x1, y1, , x2 = x1, y2 = y1] = el.pts;
    let path = '';
    switch (el.shape) {
      case 'line':
        path = `${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l`;
        break;
      case 'arrow': {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(10, el.size * 4);
        const a1 = ang + Math.PI - 0.45;
        const a2 = ang + Math.PI + 0.45;
        path =
          `${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l ` +
          `${num(x2 + head * Math.cos(a1))} ${num(y2 + head * Math.sin(a1))} m ${num(x2)} ${num(y2)} l ${num(x2 + head * Math.cos(a2))} ${num(y2 + head * Math.sin(a2))} l`;
        break;
      }
      case 'rect':
        path = `${num(Math.min(x1, x2))} ${num(Math.min(y1, y2))} ${num(Math.abs(x2 - x1))} ${num(Math.abs(y2 - y1))} re`;
        break;
      case 'ellipse':
        path = ellipseOps((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2);
        break;
      case 'axes1':
      case 'axes2':
      case 'axes4':
        path = axesPolylines(el)
          .map((line) => polylineOps(line, 2))
          .join(' ');
        break;
      default:
        path = polylineOps(el.pts, 3);
    }
    return { ops: `${strokeStyle}\n${path} S`, alpha: 1 };
  }
  if (el.tool === 'highlighter') return { ops: `${strokeStyle}\n${polylineOps(el.pts, 3)} S`, alpha: HIGHLIGHTER_OPACITY };
  if (el.direct) {
    const { discs, quads } = directShapes(el.pts, el.size, !!el.sim, DIRECT_TOLERANCE);
    const parts: string[] = [];
    for (let i = 0; i < discs.length; i += 3) parts.push(ellipseOps(discs[i], discs[i + 1], discs[i + 2], discs[i + 2]));
    // ellipseOps runs the other way round than the quads: reversed, all shapes add up under the nonzero rule
    for (let i = 0; i < quads.length; i += 8) {
      parts.push(`${num(quads[i + 6])} ${num(quads[i + 7])} m ${num(quads[i + 4])} ${num(quads[i + 5])} l ${num(quads[i + 2])} ${num(quads[i + 3])} l ${num(quads[i])} ${num(quads[i + 1])} l h`);
    }
    return { ops: `${rgbOps(color, false)}\n${parts.join(' ')} f`, alpha: 1 };
  }
  const outline = freehandOutline(el.pts, el.size, { uniform: !!el.sim, last: true });
  if (outline.length < 4) {
    const r = el.size / 2;
    return { ops: `${rgbOps(color, false)} ${ellipseOps(el.pts[0], el.pts[1], r, r)} f`, alpha: 1 };
  }
  return { ops: `${rgbOps(color, false)}\n${outlineOps(outline)}`, alpha: 1 };
}

const STANDARD_FONTS: Record<string, string> = {
  'sans--': 'Helvetica',
  'sans-b-': 'Helvetica-Bold',
  'sans--i': 'Helvetica-Oblique',
  'sans-b-i': 'Helvetica-BoldOblique',
  'serif--': 'Times-Roman',
  'serif-b-': 'Times-Bold',
  'serif--i': 'Times-Italic',
  'serif-b-i': 'Times-BoldItalic',
  'mono--': 'Courier',
  'mono-b-': 'Courier-Bold',
  'mono--i': 'Courier-Oblique',
  'mono-b-i': 'Courier-BoldOblique',
  // characters the text fonts lack (Greek letters, math symbols, check marks)
  'symbol--': 'Symbol',
  'dingbats--': 'ZapfDingbats',
};

const FALLBACK_KEYS = ['symbol--', 'dingbats--'];

const fontKey = (f: FontRef) => `${f.face}-${f.bold ? 'b' : ''}-${f.italic ? 'i' : ''}`;

/**
 * The standard fonts: measured in a scratch document, embedded into the PDF only when used
 * (unused font objects would stay in the file and pile up with every save).
 */
class FontSet implements Measurer {
  private fonts = new Map<string, PDFFont>();
  private charsets = new Map<string, Set<number>>();
  private embedded = new Map<string, PDFFont>();
  constructor(
    private lib: PdfLib,
    private doc: PDFDocument,
  ) {}

  async prepare() {
    const scratch = await this.lib.PDFDocument.create();
    for (const [k, name] of Object.entries(STANDARD_FONTS)) {
      const font = await scratch.embedFont(name);
      this.fonts.set(k, font);
      this.charsets.set(k, new Set(font.getCharacterSet()));
    }
  }

  /** The font objects in the PDF for these fonts. */
  async refs(keys: Iterable<string>): Promise<Map<string, PDFRefT>> {
    const out = new Map<string, PDFRefT>();
    for (const k of keys) {
      let font = this.embedded.get(k);
      if (!font) {
        font = await this.doc.embedFont(STANDARD_FONTS[k] ?? 'Helvetica');
        this.embedded.set(k, font);
      }
      out.set(k, font.ref);
    }
    return out;
  }

  fontOf(key: string): PDFFont {
    return this.fonts.get(key) ?? (this.fonts.get('sans--') as PDFFont);
  }

  /** Splits text into runs per font: the text's own font, or Symbol/ZapfDingbats for characters it lacks. */
  segments(text: string, f: FontRef): Array<{ key: string; text: string }> {
    const own = fontKey(f);
    const out: Array<{ key: string; text: string }> = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0) as number;
      const key = this.charsets.get(own)?.has(cp) ? own : (FALLBACK_KEYS.find((k) => this.charsets.get(k)?.has(cp)) ?? own);
      const last = out[out.length - 1];
      if (last?.key === key) last.text += ch;
      else out.push({ key, text: ch });
    }
    return out;
  }

  /** Replaces characters that none of the fonts can show. */
  clean(text: string, f: FontRef): string {
    const sets = [this.charsets.get(fontKey(f)), ...FALLBACK_KEYS.map((k) => this.charsets.get(k))].filter((x): x is Set<number> => !!x);
    if (!sets.length) return text;
    let out = '';
    for (const ch of text) out += ch === '\n' || sets.some((set) => set.has(ch.codePointAt(0) as number)) ? ch : '?';
    return out;
  }

  width(text: string, f: FontRef, size: number): number {
    return this.segments(text, f).reduce((w, seg) => w + this.fontOf(seg.key).widthOfTextAtSize(seg.text, size), 0);
  }
}

function textOpsToPdf(ops: TextOp[], ox: number, oy: number, fonts: FontSet, fontNames: Map<string, string>): string {
  const out: string[] = [];
  for (const op of ops) {
    switch (op.kind) {
      case 'rect':
        if (op.stroke) out.push(`${rgbOps(op.color, true)} ${num(op.stroke)} w ${num(ox + op.x)} ${num(oy + op.y)} ${num(op.w)} ${num(op.h)} re S`);
        else out.push(`${rgbOps(op.color, false)} ${num(ox + op.x)} ${num(oy + op.y)} ${num(op.w)} ${num(op.h)} re f`);
        break;
      case 'line':
        out.push(`${rgbOps(op.color, true)} ${num(op.width)} w 1 J ${num(ox + op.x1)} ${num(oy + op.y1)} m ${num(ox + op.x2)} ${num(oy + op.y2)} l S`);
        break;
      case 'circle':
        out.push(`${rgbOps(op.color, false)} ${ellipseOps(ox + op.cx, oy + op.cy, op.r, op.r)} f`);
        break;
      case 'text': {
        // y points down in our coordinates: flip the text back upright
        const parts = [`BT ${rgbOps(op.color, false)} 1 0 0 -1 ${num(ox + op.x)} ${num(oy + op.y)} Tm`];
        for (const seg of fonts.segments(op.text, op.font)) {
          let name = fontNames.get(seg.key);
          if (!name) {
            name = `F${fontNames.size}`;
            fontNames.set(seg.key, name);
          }
          parts.push(`/${name} ${num(op.size)} Tf ${fonts.fontOf(seg.key).encodeText(seg.text).toString()} Tj`);
        }
        out.push(`${parts.join(' ')} ET`);
        break;
      }
    }
  }
  return out.join('\n');
}

export async function writeAnnotatedPdf(
  clean: Uint8Array,
  storedPages: PdfPageBox[],
  body: { elements: Record<ID, PageElement>; tombstones: Record<ID, number>; baseId?: string | null },
  opts: WriteOptions,
): Promise<Uint8Array> {
  const lib = await loadPdfLib();
  const doc = await openDoc(lib, clean);
  const { PDFName, PDFArray, PDFString, PDFHexString } = lib;
  const ctx = doc.context;
  const pages = doc.getPages();
  const infos = pages.map(pageInfo);
  const boxes = infos.map((i) => i.box);
  const slots = pdfLayout(boxes).slots;
  let elements = Object.values(body.elements);
  if (!sameLayout(storedPages, boxes)) elements = relayout(elements, storedPages, boxes);
  elements.sort((a, b) => layer(a) - layer(b) || a.z - b.z || (a.id < b.id ? -1 : 1));

  const fonts = new FontSet(lib, doc);
  if (elements.some((e) => e.type === 'text')) await fonts.prepare();

  for (const el of elements) {
    if (!slots.length) break;
    const pi = elementPage(el, slots);
    const page = pages[pi];
    const { toUser } = infos[pi];
    const local = toPageLocal(el, slots[pi]);
    const cm = `${toUser.map(num).join(' ')} cm`;
    const resources: LiteralDict = {};
    const extra: LiteralDict = {};
    let stored: PageElement = local;
    let content = '';
    let bounds = elementBounds(local, opts.measured);
    let subtype = 'Ink';

    if (local.type === 'ink') {
      const { ops, alpha } = inkOps(local);
      if (alpha < 1) {
        resources.ExtGState = { G0: { CA: alpha, ca: alpha } };
        content = `/G0 gs\n${ops}`;
      } else content = ops;
      const pad = local.size / 2 + 2;
      bounds = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + 2 * pad, h: bounds.h + 2 * pad };
      const runs = local.shape ? strokeRuns(local) : [local.pts.filter((_, i) => i % 3 !== 2)];
      extra.InkList = runs.map((run) => {
        const arr: number[] = [];
        for (let i = 0; i + 1 < run.length; i += 2) arr.push(...applyMatrix(toUser, run[i], run[i + 1]).map(r2));
        return arr;
      });
      extra.C = (parseColor(local.color, [0, 0, 0]) as RGB).map(r2);
      extra.BS = { W: r2(local.size / PX_PER_PT), S: 'S' };
    } else if (local.type === 'text') {
      subtype = 'FreeText';
      const m = opts.measured?.get(local.id);
      const lay = layoutText(local.doc, { w: local.w, measuredW: m?.w }, opts, fonts);
      const fontNames = new Map<string, string>();
      content = textOpsToPdf(lay.ops, local.x, local.y, fonts, fontNames);
      const refs = await fonts.refs(fontNames.keys());
      const fontRes: Record<string, PDFRefT> = {};
      for (const [key, name] of fontNames) fontRes[name] = refs.get(key) as PDFRefT;
      if (fontNames.size) resources.Font = fontRes;
      bounds = { x: local.x, y: local.y, w: lay.width, h: Math.max(lay.height, m?.h ?? 0) };
      extra.Contents = PDFHexString.fromText(docToText(local.doc));
      extra.DA = PDFString.of(`/Helv ${num(opts.fontSize)} Tf 0 g`);
      extra.BS = { W: 0 };
    } else {
      subtype = 'Stamp';
      const pic = await opts.asset(local.asset);
      if (!pic) continue;
      const jpeg = pic.mime === 'image/jpeg';
      const img = jpeg ? await doc.embedJpg(pic.data) : await doc.embedPng(pic.data);
      resources.XObject = { Im0: img.ref };
      content = `q ${num(local.w)} 0 0 ${num(-local.h)} ${num(local.x)} ${num(local.y + local.h)} cm /Im0 Do Q`;
      // the picture itself, to read it back: for JPEG the image object is the file
      extra[IMAGE_KEY] = jpeg ? img.ref : ctx.register(ctx.stream(pic.data, { Subtype: 'NextNoteImage' }));
      stored = { ...local, mime: jpeg ? 'image/jpeg' : 'image/png' } as ImageElement;
    }

    const rect = userRect(toUser, bounds.x, bounds.y, bounds.w, bounds.h);
    const ap = ctx.flateStream(`q ${cm}\n${content}\nQ`, { Type: 'XObject', Subtype: 'Form', BBox: rect, Resources: resources });
    const data: StoredData = { v: FORMAT, el: stored, rect };
    const annot = ctx.obj({
      Type: 'Annot',
      Subtype: subtype,
      Rect: rect,
      F: 4,
      P: page.ref,
      NM: PDFString.of(MARK + el.id),
      M: PDFString.fromDate(new Date(el.updatedAt > 1 ? el.updatedAt : Date.now())),
      T: PDFHexString.fromText('NextNote'),
      AP: { N: ctx.register(ap) },
      [DATA_KEY]: ctx.register(ctx.flateStream(jsonBytes(data))),
      ...extra,
    });
    const ref = ctx.register(annot);
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (annots) annots.push(ref);
    else page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  }

  const tomb = ctx.register(ctx.flateStream(jsonBytes(body.tombstones)));
  doc.catalog.set(PDFName.of(DATA_KEY), ctx.obj({ V: FORMAT, Tombstones: tomb, ...(body.baseId ? { Base: PDFString.of(body.baseId) } : {}) }));
  return doc.save({ updateFieldAppearances: false, addDefaultPage: false });
}
