/**
 * Minimal InkML reader for the ink that OneNote returns (`includeInkML=true`).
 * Supports trace formats with units/resolution, explicit, first- and second-difference values
 * (the compact `'` / `"` notation), brushes with width/height/colour/transparency and pressure.
 * Coordinates are converted to page pixels (96 dpi), with the origin at the top-left of the page.
 */

const INKML_NS = 'http://www.w3.org/2003/InkML';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** HiMetric (1/1000 cm) per unit. */
const HIMETRIC_PER_UNIT: Record<string, number> = {
  himetric: 1,
  m: 100000,
  cm: 1000,
  mm: 100,
  in: 2540,
  pt: 35.27778,
  pc: 423.3333,
  px: 2540 / 96,
};

const PX_PER_HIMETRIC = 96 / 2540;

export interface InkStroke {
  /** Flat list of x, y, pressure triples in page pixels. */
  pts: number[];
  color: string;
  /** Pen width in page pixels. */
  width: number;
  highlighter: boolean;
  /** The trace carried a pressure channel. */
  pressure: boolean;
}

interface Channel {
  name: string;
  /** Factor from raw value to page pixels (X/Y), or range for F. */
  scale: number;
  min: number;
  max: number;
}

interface Brush {
  color: string;
  width: number;
  height: number;
  highlighter: boolean;
  ignorePressure: boolean;
}

const DEFAULT_CHANNELS: Channel[] = [
  { name: 'X', scale: PX_PER_HIMETRIC, min: 0, max: 0 },
  { name: 'Y', scale: PX_PER_HIMETRIC, min: 0, max: 0 },
];

const DEFAULT_BRUSH: Brush = { color: '#000000', width: 2, height: 2, highlighter: false, ignorePressure: false };

function xmlId(el: Element): string | null {
  return el.getAttributeNS(XML_NS, 'id') || el.getAttribute('xml:id') || el.getAttribute('id');
}

function inkChildren(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS(INKML_NS, name));
}

function directChild(el: Element, name: string): Element | null {
  for (const c of Array.from(el.children)) if (c.localName === name && c.namespaceURI === INKML_NS) return c;
  return null;
}

const ref = (v: string | null) => (v ? v.replace(/^#/, '') : null);

/** Converts a length with units to page pixels; unknown units are taken as HiMetric (OneNote's default). */
function lengthToPx(value: number, units: string | null): number {
  return value * (HIMETRIC_PER_UNIT[(units ?? 'himetric').toLowerCase()] ?? 1) * PX_PER_HIMETRIC;
}

function parseTraceFormat(tf: Element | null, props: Element | null): Channel[] {
  if (!tf) return DEFAULT_CHANNELS;
  const resolution = new Map<string, { value: number; units: string | null }>();
  if (props) {
    for (const p of inkChildren(props, 'channelProperty')) {
      if (p.getAttribute('name') !== 'resolution') continue;
      const value = parseFloat(p.getAttribute('value') ?? '');
      const units = (p.getAttribute('units') ?? '').replace(/^1\//, '') || null;
      if (value > 0) resolution.set(p.getAttribute('channel') ?? '', { value, units });
    }
  }
  const channels: Channel[] = [];
  for (const c of inkChildren(tf, 'channel')) {
    const name = c.getAttribute('name') ?? '';
    const min = parseFloat(c.getAttribute('min') ?? '0') || 0;
    const max = parseFloat(c.getAttribute('max') ?? '') || 0;
    let scale = 1;
    if (name === 'X' || name === 'Y') {
      const res = resolution.get(name);
      // raw / resolution = length in the resolution's units
      scale = res ? lengthToPx(1 / res.value, res.units ?? c.getAttribute('units')) : lengthToPx(1, c.getAttribute('units'));
    }
    channels.push({ name, scale, min, max });
  }
  return channels.length ? channels : DEFAULT_CHANNELS;
}

function parseBrush(el: Element): Brush {
  const b: Brush = { ...DEFAULT_BRUSH };
  let transparency = 0;
  let rasterOp = '';
  let tip = '';
  let hasHeight = false;
  for (const p of inkChildren(el, 'brushProperty')) {
    const name = p.getAttribute('name');
    const value = p.getAttribute('value') ?? '';
    const units = p.getAttribute('units');
    if (name === 'color') b.color = normalizeColor(value);
    else if (name === 'width') b.width = lengthToPx(parseFloat(value) || 0, units);
    else if (name === 'height') {
      b.height = lengthToPx(parseFloat(value) || 0, units);
      hasHeight = true;
    } else if (name === 'transparency') transparency = parseFloat(value) || 0;
    else if (name === 'rasterOp') rasterOp = value.toLowerCase();
    else if (name === 'tip') tip = value.toLowerCase();
    else if (name === 'ignorePressure') b.ignorePressure = value === 'true' || value === '1';
  }
  if (!hasHeight) b.height = b.width;
  b.highlighter = transparency > 0 || rasterOp === 'maskpen' || tip === 'rectangle';
  return b;
}

function normalizeColor(v: string): string {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v.trim());
  return m ? '#' + m[1].toUpperCase() : '#000000';
}

const TOKEN = /([!'"]?)\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[*?TF])/g;

/** Decodes the text of a trace into rows of channel values. */
export function decodeTrace(text: string, channelCount: number): number[][] {
  const rows: number[][] = [];
  const prev: number[] = new Array(channelCount).fill(0);
  const velocity: number[] = new Array(channelCount).fill(0);
  const mode: string[] = new Array(channelCount).fill('!');
  for (const point of text.split(',')) {
    if (!point.trim()) continue;
    const row: number[] = [];
    TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    let c = 0;
    while ((m = TOKEN.exec(point)) && c < channelCount) {
      if (m[1]) mode[c] = m[1];
      const raw = m[2];
      let v: number;
      if (raw === '*' || raw === '?') v = prev[c];
      else if (raw === 'T' || raw === 'F') v = raw === 'T' ? 1 : 0;
      else {
        const n = parseFloat(raw);
        if (rows.length === 0 || mode[c] === '!') {
          v = n;
          velocity[c] = rows.length ? n - prev[c] : 0;
        } else if (mode[c] === "'") {
          velocity[c] = n;
          v = prev[c] + n;
        } else {
          velocity[c] += n;
          v = prev[c] + velocity[c];
        }
      }
      prev[c] = v;
      row.push(v);
      c++;
    }
    if (row.length >= 2) rows.push(row);
  }
  return rows;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function parseInkML(xml: string): InkStroke[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Handschrift (InkML) konnte nicht gelesen werden');

  const traceFormats = new Map<string, Channel[]>();
  for (const tf of inkChildren(doc, 'traceFormat')) {
    const id = xmlId(tf);
    if (id) traceFormats.set(id, parseTraceFormat(tf, null));
  }
  const inkSources = new Map<string, Channel[]>();
  for (const src of inkChildren(doc, 'inkSource')) {
    const id = xmlId(src);
    if (id) inkSources.set(id, parseTraceFormat(directChild(src, 'traceFormat'), directChild(src, 'channelProperties')));
  }
  const brushes = new Map<string, Brush>();
  for (const b of inkChildren(doc, 'brush')) {
    const id = xmlId(b);
    if (id) brushes.set(id, parseBrush(b));
  }
  const contexts = new Map<string, { channels: Channel[]; brush: Brush | null }>();
  for (const ctx of inkChildren(doc, 'context')) {
    const id = xmlId(ctx);
    if (!id) continue;
    const src = directChild(ctx, 'inkSource');
    const tf = directChild(ctx, 'traceFormat');
    let channels = DEFAULT_CHANNELS;
    if (src) channels = parseTraceFormat(directChild(src, 'traceFormat'), directChild(src, 'channelProperties'));
    else if (ctx.getAttribute('inkSourceRef')) channels = inkSources.get(ref(ctx.getAttribute('inkSourceRef'))!) ?? DEFAULT_CHANNELS;
    else if (tf) channels = parseTraceFormat(tf, null);
    else if (ctx.getAttribute('traceFormatRef')) channels = traceFormats.get(ref(ctx.getAttribute('traceFormatRef'))!) ?? DEFAULT_CHANNELS;
    const brushEl = directChild(ctx, 'brush');
    const brush = brushEl ? parseBrush(brushEl) : ctx.getAttribute('brushRef') ? (brushes.get(ref(ctx.getAttribute('brushRef'))!) ?? null) : null;
    contexts.set(id, { channels, brush });
  }

  /** contextRef/brushRef of the trace or of the closest traceGroup carrying one. */
  const inherited = (el: Element, attr: string): string | null => {
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      const v = cur.getAttribute(attr);
      if (v) return ref(v);
      if (cur.localName === 'ink') break;
    }
    return null;
  };

  const strokes: InkStroke[] = [];
  for (const trace of inkChildren(doc, 'trace')) {
    const ctxId = inherited(trace, 'contextRef');
    const ctx = ctxId ? contexts.get(ctxId) : contexts.size === 1 ? [...contexts.values()][0] : undefined;
    const channels = ctx?.channels ?? DEFAULT_CHANNELS;
    const brushId = inherited(trace, 'brushRef');
    const brush = (brushId ? brushes.get(brushId) : null) ?? ctx?.brush ?? DEFAULT_BRUSH;
    const xi = channels.findIndex((c) => c.name === 'X');
    const yi = channels.findIndex((c) => c.name === 'Y');
    const fi = channels.findIndex((c) => c.name === 'F');
    if (xi < 0 || yi < 0) continue;
    const rows = decodeTrace(trace.textContent ?? '', channels.length);
    if (!rows.length) continue;
    const f = fi >= 0 && !brush.ignorePressure ? channels[fi] : null;
    const fRange = f ? (f.max > f.min ? f.max - f.min : 32767) : 1;
    const pts: number[] = [];
    for (const row of rows) {
      const x = row[xi] * channels[xi].scale;
      const y = row[yi] * channels[yi].scale;
      const p = f && row[fi] !== undefined ? Math.min(1, Math.max(0.05, (row[fi] - f.min) / fRange)) : 0.5;
      pts.push(r2(x), r2(y), Math.round(p * 100) / 100);
    }
    strokes.push({
      pts,
      color: brush.color,
      width: brush.highlighter ? Math.max(brush.width, brush.height) : brush.width,
      highlighter: brush.highlighter,
      pressure: !!f,
    });
  }
  return strokes;
}
