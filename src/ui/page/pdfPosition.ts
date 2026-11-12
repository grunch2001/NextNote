import type { ID } from '../../model/types';

/**
 * Where a PDF was last viewed on this device: the page at the top of the visible area and
 * how far down that page the view was (0..1). Stored relative to the page instead of in
 * pixels so that it still fits after the zoom changed.
 */
export interface PdfPosition {
  page: number;
  off: number;
}

const KEY = 'nextnote.pdfPositions';
/** Only the most recently viewed PDFs are remembered. */
const MAX_ENTRIES = 300;

function readAll(): Record<ID, PdfPosition> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Record<ID, PdfPosition>) : {};
  } catch {
    return {};
  }
}

export function loadPdfPosition(docId: ID): PdfPosition | null {
  const p = readAll()[docId];
  return p && Number.isFinite(p.page) && Number.isFinite(p.off) ? p : null;
}

export function savePdfPosition(docId: ID, pos: PdfPosition): void {
  const all = readAll();
  delete all[docId];
  all[docId] = pos; // insertion order = recency
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES))) delete all[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage full or unavailable: the position is a convenience only
  }
}
