import type { PageElement, PdfPageBox } from '../model/types';
import { translateElement } from '../ink/geometry';

/**
 * In NextNote a PDF is one long page: its pages are stacked from top to bottom with a margin
 * around and between them. Elements use the coordinates of this stack; in the PDF file each
 * element belongs to the page it starts on and is stored relative to that page.
 */
export const PDF_MARGIN = 24;
/** CSS pixels per PDF point. */
export const PX_PER_PT = 96 / 72;

export interface PageSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfLayout {
  slots: PageSlot[];
  width: number;
  height: number;
}

export function pdfLayout(pages: PdfPageBox[]): PdfLayout {
  const maxW = Math.max(0, ...pages.map((p) => p.w));
  const slots: PageSlot[] = [];
  let y = PDF_MARGIN;
  for (const p of pages) {
    slots.push({ x: Math.round(PDF_MARGIN + (maxW - p.w) / 2), y, w: p.w, h: p.h });
    y = Math.round(y + p.h + PDF_MARGIN);
  }
  return { slots, width: Math.round(maxW + 2 * PDF_MARGIN), height: y };
}

/** Index of the page that the vertical position y belongs to (the margin is split between neighbours). */
export function pageIndexAt(slots: PageSlot[], y: number): number {
  for (let i = 0; i < slots.length; i++) {
    if (y < slots[i].y + slots[i].h + PDF_MARGIN / 2) return i;
  }
  return slots.length - 1;
}

/** The point an element is anchored at: where a stroke starts, the top left corner of boxes. */
function anchor(el: PageElement): { x: number; y: number } {
  if (el.type === 'ink') return { x: el.pts[0] ?? 0, y: el.pts[1] ?? 0 };
  return { x: el.x, y: el.y };
}

export function elementPage(el: PageElement, slots: PageSlot[]): number {
  return pageIndexAt(slots, anchor(el).y);
}

export function toPageLocal<T extends PageElement>(el: T, slot: PageSlot): T {
  return translateElement(el, -slot.x, -slot.y);
}

export function fromPageLocal<T extends PageElement>(el: T, slot: PageSlot): T {
  return translateElement(el, slot.x, slot.y);
}

/** Moves elements from one layout to another (e.g. after the PDF got pages of a different size). */
export function relayout(elements: PageElement[], from: PdfPageBox[], to: PdfPageBox[]): PageElement[] {
  const a = pdfLayout(from).slots;
  const b = pdfLayout(to).slots;
  if (!a.length || !b.length) return elements;
  return elements.map((el) => {
    const i = Math.min(elementPage(el, a), b.length - 1);
    return fromPageLocal(toPageLocal(el, a[i]), b[i]);
  });
}

export function sameLayout(a: PdfPageBox[] | null, b: PdfPageBox[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p.w - b[i].w) < 0.5 && Math.abs(p.h - b[i].h) < 0.5);
}

/** Affine matrix [a b c d e f]: X = a·u + c·v + e, Y = b·u + d·v + f. */
export type Matrix = [number, number, number, number, number, number];

/**
 * Maps page-local CSS pixels (origin top left, y down, as displayed) to PDF user space
 * (origin bottom left, y up) for a page with the given visible box and /Rotate value.
 */
export function displayToUser(box: { x0: number; y0: number; x1: number; y1: number }, rotate: number): Matrix {
  const s = 1 / PX_PER_PT;
  const { x0, y0, x1, y1 } = box;
  switch (((rotate % 360) + 360) % 360) {
    case 90:
      return [0, s, s, 0, x0, y0];
    case 180:
      return [-s, 0, 0, s, x1, y0];
    case 270:
      return [0, -s, -s, 0, x1, y1];
    default:
      return [s, 0, 0, -s, x0, y1];
  }
}

export function applyMatrix(m: Matrix, u: number, v: number): [number, number] {
  return [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
}

export function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
