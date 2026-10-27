/**
 * Converts the "output HTML" of a OneNote page (Microsoft Graph) into NextNote text containers
 * and image placements. Absolutely positioned outlines become text containers at the same spot,
 * images inside an outline are cut out and placed where they appeared in the flow.
 */
import { getSchema, type JSONContent } from '@tiptap/core';
import { DOMParser as PMDOMParser, type Schema } from '@tiptap/pm/model';
import { editorExtensions, fontStack, FONTS } from '../../editor/extensions';
import { isDocEmpty } from '../../model/text';

export interface PageText {
  x: number;
  y: number;
  w: number | null;
  doc: JSONContent;
}

export interface PageImage {
  x: number;
  y: number;
  /** Display size from the page; null = use the natural size of the image. */
  w: number | null;
  h: number | null;
  /** Original resolution. */
  src: string;
  mime: string | null;
  /** Web-optimized version, if different (used when the original cannot be read). */
  fallbackSrc: string | null;
  fallbackMime: string | null;
}

export interface ConvertedPage {
  title: string;
  texts: PageText[];
  images: PageImage[];
  attachments: number;
  videos: number;
  /** Ink that Microsoft Graph leaves out (older handwriting, see INK_NOT_SUPPORTED). */
  missingInk: number;
}

/** Graph puts this comment where it leaves out ink, e.g. handwriting from older OneNote versions. */
const INK_NOT_SUPPORTED = /<!--\s*InkNode is not supported\s*-->/g;

/** Measures the rendered height of normalized outline content at the given content width. */
export type MeasureFn = (el: HTMLElement, width: number | null) => number;

/** Padding + border of .text-container: the text inside starts this far from the element position. */
const PAD_X = 7;
const PAD_Y = 4;
/** Where OneNote puts content that is not positioned. */
const FLOW_LEFT = 48;
const FLOW_TOP = 120;

const CHECKBOX_TAGS = new Set([
  'to-do',
  'to-do-priority-1',
  'to-do-priority-2',
  'discuss-with-person-a',
  'discuss-with-person-b',
  'discuss-with-manager',
  'send-in-email',
  'schedule-meeting',
  'call-back',
  'client-request',
]);

const TAG_MAP: Record<string, string> = {
  important: 'important',
  question: 'question',
  'remember-for-later': 'remember',
  definition: 'definition',
  idea: 'idea',
  critical: 'critical',
};

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#FFFFFF',
  red: '#FF0000',
  green: '#008000',
  lime: '#00FF00',
  blue: '#0000FF',
  yellow: '#FFFF00',
  cyan: '#00FFFF',
  aqua: '#00FFFF',
  magenta: '#FF00FF',
  fuchsia: '#FF00FF',
  gray: '#808080',
  grey: '#808080',
  silver: '#C0C0C0',
  maroon: '#800000',
  olive: '#808000',
  navy: '#000080',
  purple: '#800080',
  teal: '#008080',
  orange: '#FFA500',
};

let schema: Schema | null = null;
function editorSchema(): Schema {
  schema ??= getSchema(editorExtensions());
  return schema;
}

// ---------------------------------------------------------------- styles

function readStyle(el: Element): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return out;
}

function writeStyle(el: Element, style: Map<string, string>) {
  const s = [...style].map(([k, v]) => `${k}:${v}`).join(';');
  if (s) el.setAttribute('style', s);
  else el.removeAttribute('style');
}

function px(v: string | undefined | null): number | null {
  if (!v) return null;
  const m = /^(-?[\d.]+)\s*(px|pt)?$/i.exec(v.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2]?.toLowerCase() === 'pt' ? (n * 4) / 3 : n;
}

export function cssColor(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return '#' + m[1].toUpperCase();
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m) return ('#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase();
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) return '#' + [m[1], m[2], m[3]].map((c) => Math.min(255, +c).toString(16).padStart(2, '0')).join('').toUpperCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  return /^[a-z]+$/.test(s) ? s : null;
}

function fontFamily(v: string | undefined): string | null {
  if (!v) return null;
  const name = v.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  if (!name || name.toLowerCase() === 'calibri') return null;
  const known = FONTS.find((f) => f.label.toLowerCase() === name.toLowerCase());
  if (known) return fontStack(known.label);
  const generic = /courier|mono|consolas|lucida console/i.test(name) ? 'monospace' : /times|georgia|cambria|garamond|book antiqua|palatino|(?<!sans )serif/i.test(name) ? 'serif' : 'sans-serif';
  return `"${name.replace(/"/g, '')}", ${generic}`;
}

function fontSize(v: string | undefined): string | null {
  const p = px(v);
  if (p === null || p <= 0) return null;
  const pt = Math.round(((p * 3) / 4) * 2) / 2;
  return pt === 11 ? null : `${pt}pt`;
}

interface TextStyle {
  family?: string;
  size?: string;
  color?: string;
  bg?: string;
}

const STYLE_KEYS: Array<[keyof TextStyle, string]> = [
  ['family', 'font-family'],
  ['size', 'font-size'],
  ['color', 'color'],
  ['bg', 'background-color'],
];

/** Removes font/colour properties from an element and returns them. */
function takeTextStyle(el: Element): TextStyle {
  const style = readStyle(el);
  const out: TextStyle = {};
  for (const [key, prop] of STYLE_KEYS) {
    const v = style.get(prop);
    if (v !== undefined) {
      out[key] = v;
      style.delete(prop);
    }
  }
  // background shorthand on spans
  const bg = style.get('background');
  if (bg !== undefined && el.localName === 'span') {
    out.bg = bg;
    style.delete('background');
  }
  writeStyle(el, style);
  return out;
}

/**
 * OneNote puts font, size and colour on paragraphs, list items and spans. TipTap only keeps them on
 * spans (textStyle), so every text run gets a span with the effective values; highlights become <mark>.
 * Values equal to the defaults (Calibri 11 pt, black, white background) are dropped, so imported
 * text follows NextNote's default font and dark mode.
 */
function pushDownTextStyles(root: Element, base: TextStyle) {
  const doc = root.ownerDocument;
  const walk = (node: Element, inh: TextStyle) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        if (!child.textContent?.trim()) continue;
        const parts: string[] = [];
        const family = fontFamily(inh.family);
        const size = fontSize(inh.size);
        const color = cssColor(inh.color);
        if (family) parts.push(`font-family:${family}`);
        if (size) parts.push(`font-size:${size}`);
        if (color && color !== '#000000' && color !== 'windowtext' && color !== 'auto') parts.push(`color:${color}`);
        const bg = cssColor(inh.bg);
        const highlight = bg && bg !== '#FFFFFF' && bg !== 'transparent' && bg !== 'none' && bg !== 'auto' && bg !== 'window';
        if (!parts.length && !highlight) continue;
        let wrapped: Node = child.cloneNode();
        if (parts.length) {
          const span = doc.createElement('span');
          span.setAttribute('style', parts.join(';'));
          span.appendChild(wrapped);
          wrapped = span;
        }
        if (highlight) {
          const mark = doc.createElement('mark');
          mark.setAttribute('data-color', bg);
          mark.appendChild(wrapped);
          wrapped = mark;
        }
        child.replaceWith(wrapped);
      } else if (child.nodeType === 1) {
        const el = child as Element;
        const tag = el.localName;
        const own = takeTextStyle(el);
        const next: TextStyle = { ...inh };
        if (/^h[1-6]$/.test(tag)) {
          // heading styles come from NextNote's own heading formats
          delete own.size;
          delete own.color;
          delete own.family;
        }
        if (tag === 'table' || tag === 'tr' || tag === 'td' || tag === 'th') {
          // cell shading is not a text highlight
          delete own.bg;
          delete next.bg;
        }
        for (const [key] of STYLE_KEYS) if (own[key] !== undefined) next[key] = own[key];
        walk(el, next);
      }
    }
  };
  walk(root, base);
}

// ---------------------------------------------------------------- note tags

interface TagInfo {
  todo: boolean;
  checked: boolean;
  tag: string | null;
}

function parseTags(value: string | null): TagInfo {
  const info: TagInfo = { todo: false, checked: false, tag: null };
  for (const raw of (value ?? '').split(',')) {
    const [name, status] = raw.trim().toLowerCase().split(':');
    if (!name) continue;
    if (CHECKBOX_TAGS.has(name) || status === 'completed') {
      info.todo = true;
      if (status === 'completed') info.checked = true;
    } else if (TAG_MAP[name] && !info.tag) {
      info.tag = TAG_MAP[name];
    }
  }
  return info;
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li']);

function convertTags(root: Element) {
  const doc = root.ownerDocument;
  // tags on spans belong to the enclosing paragraph / list item
  for (const span of Array.from(root.querySelectorAll('[data-tag]'))) {
    if (BLOCK_TAGS.has(span.localName)) continue;
    const block = span.parentElement?.closest('p, h1, h2, h3, h4, h5, h6, li');
    if (block && root.contains(block) && !block.hasAttribute('data-tag')) block.setAttribute('data-tag', span.getAttribute('data-tag') ?? '');
    span.removeAttribute('data-tag');
  }

  // list items
  for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
    const items = Array.from(list.children).filter((c) => c.localName === 'li');
    const infos = items.map((li) => parseTags(li.getAttribute('data-tag')));
    const allTodo = items.length > 0 && infos.every((i) => i.todo);
    if (allTodo) {
      const tl = doc.createElement('ul');
      tl.setAttribute('data-type', 'taskList');
      items.forEach((li, i) => tl.appendChild(taskItem(doc, li, infos[i])));
      list.replaceWith(tl);
      continue;
    }
    items.forEach((li, i) => {
      li.removeAttribute('data-tag');
      const info = infos[i];
      if (info.todo) li.insertBefore(doc.createTextNode(info.checked ? '☑ ' : '☐ '), li.firstChild);
      if (info.tag) {
        const p = firstParagraph(doc, li);
        p.setAttribute('data-tag', info.tag);
      }
    });
  }

  // paragraphs and headings; consecutive to-dos form one task list
  let currentList: Element | null = null;
  for (const el of Array.from(root.querySelectorAll('p[data-tag], h1[data-tag], h2[data-tag], h3[data-tag], h4[data-tag], h5[data-tag], h6[data-tag]'))) {
    const info = parseTags(el.getAttribute('data-tag'));
    el.removeAttribute('data-tag');
    if (!info.todo) {
      if (info.tag) el.setAttribute('data-tag', info.tag);
      continue;
    }
    const item = taskItem(doc, el, info);
    if (currentList && currentList.nextElementSibling === el) {
      currentList.appendChild(item);
      el.remove();
    } else {
      currentList = doc.createElement('ul');
      currentList.setAttribute('data-type', 'taskList');
      currentList.appendChild(item);
      el.replaceWith(currentList);
    }
  }
  // anything else (images, tables …) carries no tag for TipTap
  for (const el of Array.from(root.querySelectorAll('[data-tag]'))) {
    if (el.localName !== 'p' && !/^h[1-6]$/.test(el.localName)) el.removeAttribute('data-tag');
  }
}

/** The first paragraph of a list item, wrapping its leading inline content if needed. */
function firstParagraph(doc: Document, li: Element): Element {
  const first = li.firstElementChild;
  if (first?.localName === 'p' && li.firstChild === first) return first;
  const p = doc.createElement('p');
  while (li.firstChild && !(li.firstChild.nodeType === 1 && /^(p|ul|ol|table|h[1-6])$/.test((li.firstChild as Element).localName))) {
    p.appendChild(li.firstChild);
  }
  li.insertBefore(p, li.firstChild);
  return p;
}

function taskItem(doc: Document, src: Element, info: TagInfo): Element {
  const li = doc.createElement('li');
  li.setAttribute('data-type', 'taskItem');
  li.setAttribute('data-checked', info.checked ? 'true' : 'false');
  if (src.localName === 'li') {
    while (src.firstChild) li.appendChild(src.firstChild);
    const p = firstParagraph(doc, li);
    p.removeAttribute('data-tag');
    if (info.tag) p.setAttribute('data-tag', info.tag);
  } else {
    const p = doc.createElement('p');
    if (src.getAttribute('style')) p.setAttribute('style', src.getAttribute('style')!);
    while (src.firstChild) p.appendChild(src.firstChild);
    if (info.tag) p.setAttribute('data-tag', info.tag);
    if (/^h[1-6]$/.test(src.localName)) {
      const strong = doc.createElement('strong');
      while (p.firstChild) strong.appendChild(p.firstChild);
      p.appendChild(strong);
    }
    li.appendChild(p);
  }
  return li;
}

// ---------------------------------------------------------------- outline content

function rename(el: Element, tag: string): Element {
  const out = el.ownerDocument.createElement(tag);
  for (const a of Array.from(el.attributes)) out.setAttribute(a.name, a.value);
  while (el.firstChild) out.appendChild(el.firstChild);
  el.replaceWith(out);
  return out;
}

function normalize(root: Element, base: TextStyle) {
  const doc = root.ownerDocument;
  // Graph returns runs of <br /> where OneNote shows a single empty line (measured on real pages)
  for (const br of Array.from(root.querySelectorAll('br'))) {
    const parent = br.parentElement;
    if (parent !== root && parent?.localName !== 'ul' && parent?.localName !== 'ol') continue;
    let prev = br.previousSibling;
    while (prev?.nodeType === 3 && !prev.textContent?.trim()) prev = prev.previousSibling;
    if (prev?.nodeType === 1 && (prev as Element).localName === 'br') br.remove();
  }
  // a <br> between paragraphs is an empty line in OneNote
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 1 && (child as Element).localName === 'br') child.replaceWith(doc.createElement('p'));
  }
  // an empty line in a list (a <br> between the items) belongs to the item above it and has no bullet
  for (const br of Array.from(root.querySelectorAll('ul > br, ol > br'))) {
    const prev = br.previousElementSibling;
    if (prev?.localName === 'li') {
      firstParagraph(doc, prev);
      prev.appendChild(doc.createElement('p'));
    } else {
      br.parentElement!.before(doc.createElement('p'));
    }
    br.remove();
  }
  for (const el of Array.from(root.querySelectorAll('[id], [data-id], [lang]'))) {
    el.removeAttribute('id');
    el.removeAttribute('data-id');
    el.removeAttribute('lang');
  }
  convertTags(root);
  for (const h of Array.from(root.querySelectorAll('h4'))) rename(h, 'h3');
  for (const h of Array.from(root.querySelectorAll('h5, h6'))) {
    const p = rename(h, 'p');
    const strong = doc.createElement('strong');
    while (p.firstChild) strong.appendChild(p.firstChild);
    p.appendChild(strong);
  }
  // "Pasted from <link>" citations: small and grey like in OneNote
  for (const cite of Array.from(root.querySelectorAll('cite'))) {
    const span = rename(cite, 'span');
    const style = readStyle(span);
    if (!style.has('color')) style.set('color', '#595959');
    if (!style.has('font-size')) style.set('font-size', '9pt');
    writeStyle(span, style);
  }
  pushDownTextStyles(root, base);
}

function placeholder(doc: Document, el: Element): Element {
  const p = doc.createElement('p');
  if (el.localName === 'iframe') {
    const url = el.getAttribute('data-original-src') || el.getAttribute('src') || '';
    p.appendChild(doc.createTextNode('🎬 Video: '));
    if (/^https?:\/\//i.test(url)) {
      const a = doc.createElement('a');
      a.setAttribute('href', url);
      a.textContent = url;
      p.appendChild(a);
    } else {
      p.appendChild(doc.createTextNode(url || 'eingebettetes Video'));
    }
  } else {
    const em = doc.createElement('em');
    em.textContent = `📎 Anhang „${el.getAttribute('data-attachment') || 'Datei'}“ wurde nicht übernommen`;
    p.appendChild(em);
  }
  return p;
}

/** Drops textStyle marks without any value (left over from spans that only carried bold etc.). */
function dropEmptyTextStyles(node: JSONContent): JSONContent {
  if (node.marks) {
    for (const m of node.marks) {
      if (m.type !== 'textStyle' || !m.attrs) continue;
      for (const [k, v] of Object.entries(m.attrs)) if (v === '' || v === undefined) m.attrs[k] = null;
    }
    const marks = node.marks.filter((m) => m.type !== 'textStyle' || Object.values(m.attrs ?? {}).some((v) => v !== null));
    if (marks.length) node.marks = marks;
    else delete node.marks;
  }
  node.content?.forEach(dropEmptyTextStyles);
  return node;
}

const isEmptyParagraph = (node: JSONContent) => node.type === 'paragraph' && !node.content?.some((c) => c.type !== 'hardBreak');

/**
 * Drops empty lines at the end of the text, also those of the last list item. They only make the
 * container reach into what follows on the page; the layout keeps their height.
 */
function dropTrailingEmptyLines(node: JSONContent): JSONContent {
  const content = node.content;
  if (!content) return node;
  while (content.length > 1 && isEmptyParagraph(content[content.length - 1])) content.pop();
  const last = content[content.length - 1];
  if (/^(bulletList|orderedList|taskList|listItem|taskItem)$/.test(last?.type ?? '')) dropTrailingEmptyLines(last);
  return node;
}

/** Rough height estimate (when no DOM measurement is available, e.g. in tests). */
export function estimateHeight(root: Element, width: number | null): number {
  const w = Math.max(80, width ?? 600);
  const blockHeight = (el: Element, avail: number): number => {
    const tag = el.localName;
    let pt = tag === 'h1' ? 16 : tag === 'h2' ? 14 : tag === 'h3' ? 12 : 11;
    for (const s of Array.from(el.querySelectorAll('[style*="font-size"]'))) {
      const p = px(readStyle(s).get('font-size'));
      if (p) pt = Math.max(pt, (p * 3) / 4);
    }
    const fontPx = (pt * 4) / 3;
    const perLine = Math.max(8, avail / (fontPx * 0.5));
    const lines = Math.max(1, Math.ceil((el.textContent ?? '').length / perLine));
    return lines * fontPx * 1.227 + (/^h[1-3]$/.test(tag) ? 4 : 0);
  };
  let h = 0;
  const visit = (el: Element, avail: number) => {
    for (const child of Array.from(el.children)) {
      const tag = child.localName;
      if (tag === 'table') {
        for (const tr of Array.from(child.querySelectorAll('tr'))) {
          const cells = Array.from(tr.children);
          const cw = avail / Math.max(1, cells.length);
          h += Math.max(20, ...cells.map((c) => blockHeight(c, cw - 12) + 6));
        }
      } else if (tag === 'ul' || tag === 'ol') {
        visit(child, avail - 36);
      } else if (tag === 'li' && child.querySelector('p, ul, ol')) {
        visit(child, avail);
      } else {
        h += blockHeight(child, avail);
      }
    }
  };
  visit(root, w);
  return Math.round(h);
}

function absolutePosition(el: Element): { left: number; top: number; width: number | null } | null {
  const style = readStyle(el);
  if ((style.get('position') ?? '').toLowerCase() !== 'absolute') return null;
  return { left: px(style.get('left')) ?? 0, top: px(style.get('top')) ?? 0, width: px(style.get('width')) };
}

function imageOf(img: Element, x: number, y: number): PageImage | null {
  const fullres = img.getAttribute('data-fullres-src');
  const web = img.getAttribute('src');
  const src = fullres || web;
  if (!src) return null;
  const style = readStyle(img);
  const w = parseFloat(img.getAttribute('width') ?? '') || px(style.get('width'));
  const h = parseFloat(img.getAttribute('height') ?? '') || px(style.get('height'));
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: w ? Math.round(w) : null,
    h: h ? Math.round(h) : null,
    src,
    mime: fullres ? img.getAttribute('data-fullres-src-type') : img.getAttribute('data-src-type'),
    fallbackSrc: fullres && web && web !== fullres ? web : null,
    fallbackMime: img.getAttribute('data-src-type'),
  };
}

export function convertPageHtml(html: string, opts: { measure?: MeasureFn } = {}): ConvertedPage {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const result: ConvertedPage = {
    title: doc.querySelector('title')?.textContent?.trim() ?? '',
    texts: [],
    images: [],
    attachments: 0,
    videos: 0,
    missingInk: html.match(INK_NOT_SUPPORTED)?.length ?? 0,
  };
  const body = doc.body;
  if (!body) return result;
  const bodyStyle = readStyle(body);
  const base: TextStyle = { family: bodyStyle.get('font-family'), size: bodyStyle.get('font-size') };
  const parser = PMDOMParser.fromSchema(editorSchema());

  const addText = (nodes: Node[], x: number, y: number, width: number | null): number => {
    const box = doc.createElement('div');
    for (const n of nodes) box.appendChild(n);
    normalize(box, base);
    const measured = opts.measure?.(box, width) ?? 0;
    const height = measured > 0 ? measured : estimateHeight(box, width);
    const json = dropTrailingEmptyLines(dropEmptyTextStyles(parser.parse(box).toJSON() as JSONContent));
    if (!isDocEmpty(json)) {
      result.texts.push({ x: Math.round(x - PAD_X), y: Math.round(y - PAD_Y), w: width ? Math.round(width + 2 * PAD_X) : null, doc: json });
    }
    return height;
  };

  const addImage = (img: Element, x: number, y: number): number => {
    const image = imageOf(img, x, y);
    if (!image) return 0;
    result.images.push(image);
    return image.h ?? 0;
  };

  /** One OneNote outline: text chunks with images cut out in between. Returns the bottom edge. */
  const outline = (div: Element, x: number, y: number, width: number | null): number => {
    const items: Node[] = [];
    const flatten = (el: Element) => {
      for (const c of Array.from(el.childNodes)) {
        if (c.nodeType === 1 && (c as Element).localName === 'div') flatten(c as Element);
        else if (c.nodeType === 1 || (c.nodeType === 3 && c.textContent?.trim())) items.push(c);
      }
    };
    flatten(div);
    let chunk: Node[] = [];
    let cur = y;
    const flush = () => {
      if (chunk.length) cur += addText(chunk, x, cur, width);
      chunk = [];
    };
    for (const node of items) {
      if (node.nodeType === 1) {
        const el = node as Element;
        const tag = el.localName;
        if (tag === 'img') {
          flush();
          cur += addImage(el, x, cur);
          continue;
        }
        if (tag === 'object' || tag === 'iframe') {
          if (tag === 'object') result.attachments++;
          else result.videos++;
          chunk.push(placeholder(doc, el));
          continue;
        }
        for (const o of Array.from(el.querySelectorAll('object, iframe'))) {
          if (o.localName === 'object') result.attachments++;
          else result.videos++;
          o.replaceWith(...Array.from(placeholder(doc, o).childNodes));
        }
        const imgs = Array.from(el.querySelectorAll('img'));
        if (imgs.length) {
          for (const img of imgs) img.remove();
          if (el.textContent?.trim()) chunk.push(el);
          flush();
          for (const img of imgs) cur += addImage(img, x, cur);
          continue;
        }
      }
      chunk.push(node);
    }
    flush();
    return cur;
  };

  let flowNodes: Node[] = [];
  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType !== 1) {
      if (child.nodeType === 3 && child.textContent?.trim()) flowNodes.push(child);
      continue;
    }
    const el = child as Element;
    const pos = absolutePosition(el);
    const tag = el.localName;
    if (!pos && tag !== 'div') {
      flowNodes.push(el);
      continue;
    }
    if (tag === 'div') {
      outline(el, pos?.left ?? FLOW_LEFT, pos?.top ?? FLOW_TOP, pos?.width ?? null);
    } else if (tag === 'img') {
      addImage(el, pos!.left, pos!.top);
    } else if (tag === 'object' || tag === 'iframe') {
      if (tag === 'object') result.attachments++;
      else result.videos++;
      addText([placeholder(doc, el)], pos!.left, pos!.top, pos!.width);
    } else {
      flowNodes.push(el);
    }
  }
  if (flowNodes.length) {
    const div = doc.createElement('div');
    for (const n of flowNodes) div.appendChild(n);
    flowNodes = [];
    const bottom = Math.max(FLOW_TOP, ...result.texts.map((t) => t.y + 40), ...result.images.map((i) => i.y + (i.h ?? 0) + 16));
    outline(div, FLOW_LEFT, result.texts.length || result.images.length ? bottom : FLOW_TOP, null);
  }
  return result;
}
