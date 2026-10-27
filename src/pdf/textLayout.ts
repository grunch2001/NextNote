import type { JSONContent } from '@tiptap/core';
import { TAGS } from '../editor/tags';

/**
 * A simplified layout of a text container for its appearance in the PDF file, so that other
 * PDF viewers show the text. NextNote itself keeps the full document (stored next to it) and
 * renders it with the editor. Fonts are the PDF standard fonts, so the result is close to,
 * but not exactly like, the original.
 */

export type FontFace = 'sans' | 'serif' | 'mono' | 'symbol' | 'dingbats';

export interface FontRef {
  face: FontFace;
  bold: boolean;
  italic: boolean;
}

export interface Measurer {
  width(text: string, font: FontRef, sizePx: number): number;
  /** Replaces characters the font cannot show. */
  clean(text: string, font: FontRef): string;
}

export type RGB = [number, number, number];

/** Something to draw, in CSS pixels relative to the top left of the text container. */
export type TextOp =
  | { kind: 'text'; x: number; y: number; text: string; font: FontRef; size: number; color: RGB }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: RGB; stroke?: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; color: RGB }
  | { kind: 'circle'; cx: number; cy: number; r: number; color: RGB };

export interface TextLayout {
  ops: TextOp[];
  width: number;
  height: number;
}

interface Style {
  font: FontRef;
  size: number;
  color: RGB;
  underline: boolean;
  strike: boolean;
  highlight: RGB | null;
  shift: number;
}

interface Run {
  text: string;
  style: Style;
}

const PAGE_TEXT: RGB = [0x1f / 255, 0x1f / 255, 0x1f / 255];
const LINK: RGB = [0x05 / 255, 0x63 / 255, 0xc1 / 255];
const GREY: RGB = [0.62, 0.62, 0.62];
const PT = 4 / 3;
/** Border + padding of a text container. */
const PAD_X = 7;
const PAD_Y = 4;
const MAX_AUTO_WIDTH = 680;

export function parseColor(input: unknown, fallback: RGB | null = null): RGB | null {
  if (typeof input !== 'string') return fallback;
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16) / 255) as RGB;
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16) / 255) as RGB;
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return [m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)) / 255) as RGB;
  if (s === 'black') return [0, 0, 0];
  if (s === 'white') return [1, 1, 1];
  return fallback;
}

export function fontFace(family: unknown): FontFace {
  const f = String(family ?? '').toLowerCase();
  if (/courier|consolas|mono/.test(f)) return 'mono';
  if (/times|georgia|tinos|cambria|(^|[^-])serif/.test(f.replace('sans-serif', ''))) return 'serif';
  return 'sans';
}

function parseSize(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v * PT;
  if (typeof v !== 'string') return fallback;
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (v.endsWith('px')) return n;
  if (v.endsWith('em')) return n * fallback;
  return n * PT;
}

function mix(c: RGB, alpha: number): RGB {
  return c.map((v) => 1 - (1 - v) * alpha) as RGB;
}

type Block =
  | { kind: 'para'; runs: Run[]; indent: number; align: string; lineFactor: number; marginY: number; marker: Marker | null; bg: RGB | null; minSize: number }
  | { kind: 'rule'; indent: number }
  | { kind: 'table'; indent: number; rows: Block[][][]; header: boolean[][] }
  | { kind: 'bar'; indent: number; blocks: Block[] };

type Marker = { kind: 'text'; text: string; style: Style } | { kind: 'box'; checked: boolean; color: RGB } | { kind: 'dot'; color: RGB };

export interface TextDefaults {
  /** Default size in pt. */
  fontSize: number;
  /** Default font (label or CSS font stack). */
  fontFamily: string;
}

export function layoutText(doc: JSONContent, box: { w: number | null; measuredW?: number }, defaults: TextDefaults, m: Measurer): TextLayout {
  const base: Style = {
    font: { face: fontFace(defaults.fontFamily), bold: false, italic: false },
    size: defaults.fontSize * PT,
    color: PAGE_TEXT,
    underline: false,
    strike: false,
    highlight: null,
    shift: 0,
  };
  const blocks = toBlocks(doc.content ?? [], base, 0);
  const auto = box.w === null;
  const innerW = Math.max(20, (auto ? MAX_AUTO_WIDTH : (box.w as number)) - 2 * PAD_X);
  const ops: TextOp[] = [];
  const { height, width } = layoutBlocks(blocks, innerW, PAD_X, PAD_Y, ops, m);
  const outerW = auto ? Math.max(box.measuredW ?? 0, Math.min(MAX_AUTO_WIDTH, width + 2 * PAD_X)) : (box.w as number);
  return { ops, width: Math.max(48, outerW), height: Math.max(base.size * 1.35, height - PAD_Y) + 2 * PAD_Y };
}

function inlineRuns(nodes: JSONContent[], style: Style): Run[] {
  const runs: Run[] = [];
  for (const n of nodes) {
    if (n.type === 'hardBreak') runs.push({ text: '\n', style });
    else if (n.type === 'text' && n.text) runs.push({ text: n.text, style: applyMarks(style, n.marks ?? []) });
    else if (n.content) runs.push(...inlineRuns(n.content, style));
  }
  return runs;
}

function applyMarks(style: Style, marks: NonNullable<JSONContent['marks']>): Style {
  const s: Style = { ...style, font: { ...style.font } };
  for (const mk of marks) {
    const a = (mk.attrs ?? {}) as Record<string, unknown>;
    switch (mk.type) {
      case 'bold':
        s.font.bold = true;
        break;
      case 'italic':
        s.font.italic = true;
        break;
      case 'underline':
        s.underline = true;
        break;
      case 'strike':
        s.strike = true;
        break;
      case 'code':
        s.font.face = 'mono';
        s.size *= 0.92;
        break;
      case 'link':
        s.color = LINK;
        s.underline = true;
        break;
      case 'highlight':
        s.highlight = parseColor(a.color, [1, 1, 0]);
        break;
      case 'subscript':
        s.size *= 0.75;
        s.shift = style.size * 0.2;
        break;
      case 'superscript':
        s.size *= 0.75;
        s.shift = -style.size * 0.35;
        break;
      case 'textStyle':
        if (a.color) s.color = parseColor(a.color, s.color) as RGB;
        if (a.fontSize) s.size = parseSize(a.fontSize, s.size);
        if (a.fontFamily) s.font.face = fontFace(a.fontFamily);
        break;
    }
  }
  return s;
}

function tagMarker(tag: unknown): { marker: Marker | null; bg: RGB | null } {
  const def = TAGS.find((t) => t.id === tag);
  if (!def) return { marker: null, bg: null };
  const color = parseColor(def.color, PAGE_TEXT) as RGB;
  if (def.id === 'todo') return { marker: { kind: 'box', checked: false, color }, bg: null };
  const bg = def.id === 'remember' ? mix([1, 0.8, 0], 0.28) : def.id === 'definition' ? mix([0.23, 0.75, 0.29], 0.18) : null;
  return { marker: { kind: 'dot', color }, bg };
}

function toBlocks(nodes: JSONContent[], style: Style, indent: number): Block[] {
  const out: Block[] = [];
  for (const n of nodes) {
    const a = (n.attrs ?? {}) as Record<string, unknown>;
    switch (n.type) {
      case 'paragraph':
      case 'heading': {
        let s = style;
        let lineFactor = 1.35;
        let marginY = 0;
        if (n.type === 'heading') {
          const level = Number(a.level) || 1;
          const sizes = [16, 14, 12];
          const colors: RGB[] = [
            [0x1e / 255, 0x4e / 255, 0x79 / 255],
            [0x2e / 255, 0x75 / 255, 0xb5 / 255],
            [0x1f / 255, 0x37 / 255, 0x63 / 255],
          ];
          s = { ...style, size: sizes[level - 1] * PT, color: colors[level - 1], font: { ...style.font, bold: level === 3 } };
          lineFactor = 1.25;
          marginY = 2;
        }
        const tag = tagMarker(a.tag);
        const tagIndent = tag.marker ? s.size * 1.45 : 0;
        out.push({
          kind: 'para',
          runs: inlineRuns(n.content ?? [], s),
          indent: indent + tagIndent,
          align: typeof a.textAlign === 'string' ? a.textAlign : 'left',
          lineFactor,
          marginY,
          marker: tag.marker,
          bg: tag.bg,
          minSize: s.size,
        });
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        let num = Number(a.start) || 1;
        const listIndent = style.size * 1.7;
        for (const item of n.content ?? []) {
          const inner = toBlocks(item.content ?? [], style, indent + listIndent);
          const first = inner[0];
          if (first?.kind === 'para' && !first.marker) {
            const nested = indent > 0 && n.type === 'bulletList';
            first.marker = { kind: 'text', text: n.type === 'orderedList' ? `${num}.` : nested ? '–' : '•', style };
          }
          num++;
          out.push(...inner);
        }
        break;
      }
      case 'taskList': {
        const listIndent = style.size * 1.45;
        for (const item of n.content ?? []) {
          const inner = toBlocks(item.content ?? [], style, indent + listIndent);
          const first = inner[0];
          if (first?.kind === 'para') first.marker = { kind: 'box', checked: !!(item.attrs as Record<string, unknown> | undefined)?.checked, color: [0x19 / 255, 0x76 / 255, 0xd2 / 255] };
          out.push(...inner);
        }
        break;
      }
      case 'blockquote':
        out.push({
          kind: 'bar',
          indent,
          blocks: toBlocks(n.content ?? [], { ...style, color: [0x5d / 255, 0x59 / 255, 0x64 / 255], font: { ...style.font, italic: true } }, indent + 13),
        });
        break;
      case 'codeBlock': {
        const s: Style = { ...style, size: 10 * PT, font: { face: 'mono', bold: false, italic: false } };
        const text = (n.content ?? []).map((c) => c.text ?? '').join('');
        for (const line of text.split('\n')) {
          out.push({ kind: 'para', runs: [{ text: line, style: s }], indent: indent + 9, align: 'left', lineFactor: 1.35, marginY: 0, marker: null, bg: null, minSize: s.size });
        }
        break;
      }
      case 'horizontalRule':
        out.push({ kind: 'rule', indent });
        break;
      case 'table': {
        const rows: Block[][][] = [];
        const header: boolean[][] = [];
        for (const row of n.content ?? []) {
          const cells: Block[][] = [];
          const hdr: boolean[] = [];
          for (const cell of row.content ?? []) {
            const isHeader = cell.type === 'tableHeader';
            const s = isHeader ? { ...style, font: { ...style.font, bold: true } } : style;
            cells.push(toBlocks(cell.content ?? [], s, 0));
            hdr.push(isHeader);
          }
          rows.push(cells);
          header.push(hdr);
        }
        out.push({ kind: 'table', indent, rows, header });
        break;
      }
      default:
        if (n.content) out.push(...toBlocks(n.content, style, indent));
    }
  }
  return out;
}

interface Piece {
  text: string;
  style: Style;
  w: number;
}

/** Splits runs into words and spaces and fills lines greedily. */
function breakLines(runs: Run[], maxW: number, m: Measurer): Piece[][] {
  const lines: Piece[][] = [[]];
  let lineW = 0;
  const push = (p: Piece) => {
    lines[lines.length - 1].push(p);
    lineW += p.w;
  };
  for (const run of runs) {
    const text = m.clean(run.text.replace(/\t/g, '    '), run.style.font);
    for (const token of text.split(/(\n| +)/)) {
      if (!token) continue;
      if (token === '\n') {
        lines.push([]);
        lineW = 0;
        continue;
      }
      const w = m.width(token, run.style.font, run.style.size);
      const isSpace = token.trim() === '';
      if (lineW + w <= maxW || isSpace || lineW === 0) {
        if (!isSpace && w > maxW && lineW === 0) {
          // a word longer than the line: break it anywhere
          let rest = token;
          while (rest) {
            let n = rest.length;
            while (n > 1 && m.width(rest.slice(0, n), run.style.font, run.style.size) > maxW) n--;
            push({ text: rest.slice(0, n), style: run.style, w: m.width(rest.slice(0, n), run.style.font, run.style.size) });
            rest = rest.slice(n);
            if (rest) {
              lines.push([]);
              lineW = 0;
            }
          }
          continue;
        }
        push({ text: token, style: run.style, w });
      } else {
        lines.push([]);
        lineW = 0;
        push({ text: token, style: run.style, w });
      }
    }
  }
  // spaces at the end of a line take no room
  for (const line of lines) while (line.length && line[line.length - 1].text.trim() === '') line.pop();
  return lines;
}

function layoutBlocks(blocks: Block[], innerW: number, x0: number, y0: number, ops: TextOp[], m: Measurer): { height: number; width: number } {
  let y = y0;
  let maxRight = 0;
  for (const b of blocks) {
    if (b.kind === 'rule') {
      y += 8;
      ops.push({ kind: 'line', x1: x0 + b.indent, y1: y, x2: x0 + innerW, y2: y, width: 1, color: GREY });
      y += 9;
      maxRight = Math.max(maxRight, innerW);
      continue;
    }
    if (b.kind === 'bar') {
      const start = ops.length;
      const r = layoutBlocks(b.blocks, innerW, x0, y + 2, ops, m);
      ops.splice(start, 0, { kind: 'rect', x: x0 + b.indent, y: y + 2, w: 3, h: r.height - y - 2, color: [0.75, 0.75, 0.75] });
      y = r.height + 2;
      maxRight = Math.max(maxRight, r.width);
      continue;
    }
    if (b.kind === 'table') {
      const cols = Math.max(1, ...b.rows.map((r) => r.length));
      const tableW = innerW - b.indent;
      const colW = Math.max(48, tableW / cols);
      for (let ri = 0; ri < b.rows.length; ri++) {
        const cellOps: TextOp[][] = [];
        let rowH = 0;
        b.rows[ri].forEach((cell) => {
          const o: TextOp[] = [];
          const r = layoutBlocks(cell, colW - 12, 0, 0, o, m);
          cellOps.push(o);
          rowH = Math.max(rowH, r.height + 6);
        });
        for (let ci = 0; ci < cols; ci++) {
          const cx = x0 + b.indent + ci * colW;
          if (b.header[ri]?.[ci]) ops.push({ kind: 'rect', x: cx, y, w: colW, h: rowH, color: [0.94, 0.94, 0.94] });
          for (const op of cellOps[ci] ?? []) ops.push(shiftOp(op, cx + 6, y + 3));
          ops.push({ kind: 'rect', x: cx, y, w: colW, h: rowH, color: GREY, stroke: 1 });
        }
        y += rowH;
      }
      maxRight = Math.max(maxRight, b.indent + cols * colW);
      continue;
    }
    // paragraph
    y += b.marginY;
    const maxW = innerW - b.indent;
    const lines = b.runs.length ? breakLines(b.runs, maxW, m) : [[]];
    const top = y;
    const firstOp = ops.length;
    let first = true;
    for (const line of lines) {
      const size = Math.max(b.minSize, ...line.map((p) => p.style.size));
      const lineH = size * b.lineFactor;
      const baseline = y + (lineH - size) / 2 + size * 0.8;
      const lineW = line.reduce((s, p) => s + p.w, 0);
      let x = x0 + b.indent;
      if (b.align === 'center') x += Math.max(0, (maxW - lineW) / 2);
      else if (b.align === 'right') x += Math.max(0, maxW - lineW);
      if (first && b.marker) drawMarker(b.marker, x0 + b.indent, y, size, lineH, baseline, ops, m);
      first = false;
      for (const p of line) {
        const s = p.style;
        if (s.highlight) ops.push({ kind: 'rect', x, y: y + (lineH - s.size * 1.2) / 2, w: p.w, h: s.size * 1.2, color: s.highlight });
        if (p.text.trim()) ops.push({ kind: 'text', x, y: baseline + s.shift, text: p.text, font: s.font, size: s.size, color: s.color });
        const lw = Math.max(0.6, s.size * 0.06);
        if (s.underline) ops.push({ kind: 'line', x1: x, y1: baseline + s.shift + s.size * 0.12, x2: x + p.w, y2: baseline + s.shift + s.size * 0.12, width: lw, color: s.color });
        if (s.strike) ops.push({ kind: 'line', x1: x, y1: baseline + s.shift - s.size * 0.28, x2: x + p.w, y2: baseline + s.shift - s.size * 0.28, width: lw, color: s.color });
        x += p.w;
      }
      maxRight = Math.max(maxRight, x - x0);
      y += lineH;
    }
    if (b.bg) ops.splice(firstOp, 0, { kind: 'rect', x: x0 + b.indent - b.minSize * 1.45, y: top, w: innerW - b.indent + b.minSize * 1.45, h: y - top, color: b.bg });
    y += b.marginY;
  }
  return { height: y, width: maxRight };
}

function drawMarker(mk: Marker, left: number, y: number, size: number, lineH: number, baseline: number, ops: TextOp[], m: Measurer) {
  if (mk.kind === 'text') {
    const w = m.width(mk.text, mk.style.font, mk.style.size);
    ops.push({ kind: 'text', x: left - w - size * 0.35, y: baseline, text: mk.text, font: mk.style.font, size: mk.style.size, color: mk.style.color });
  } else if (mk.kind === 'box') {
    const s = size * 1.05;
    const bx = left - size * 1.35;
    const by = y + (lineH - s) / 2;
    if (mk.checked) {
      ops.push({ kind: 'rect', x: bx, y: by, w: s, h: s, color: mk.color });
      ops.push({ kind: 'line', x1: bx + s * 0.22, y1: by + s * 0.52, x2: bx + s * 0.42, y2: by + s * 0.74, width: s * 0.14, color: [1, 1, 1] });
      ops.push({ kind: 'line', x1: bx + s * 0.42, y1: by + s * 0.74, x2: bx + s * 0.8, y2: by + s * 0.28, width: s * 0.14, color: [1, 1, 1] });
    } else {
      ops.push({ kind: 'rect', x: bx, y: by, w: s, h: s, color: mk.color, stroke: Math.max(1, s * 0.1) });
    }
  } else {
    ops.push({ kind: 'circle', cx: left - size * 0.85, cy: y + lineH / 2, r: size * 0.42, color: mk.color });
  }
}

function shiftOp(op: TextOp, dx: number, dy: number): TextOp {
  switch (op.kind) {
    case 'text':
    case 'rect':
      return { ...op, x: op.x + dx, y: op.y + dy };
    case 'line':
      return { ...op, x1: op.x1 + dx, y1: op.y1 + dy, x2: op.x2 + dx, y2: op.y2 + dy };
    case 'circle':
      return { ...op, cx: op.cx + dx, cy: op.cy + dy };
  }
}
