import { describe, expect, it } from 'vitest';
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import type { ImageElement, InkElement, PageElement, TextElement } from '../src/model/types';
import { base64ToBytes } from '../src/model/util';
import { readAnnotatedPdf, writeAnnotatedPdf, type WriteOptions } from '../src/pdf/annotate';
import { applyMatrix, displayToUser, invertMatrix, pdfLayout } from '../src/pdf/layout';

const PNG_1PX = base64ToBytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

async function samplePdf(opts: { rotate?: number; encrypt?: 'AES-128' | 'AES-256'; foreignAnnot?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText('Seite 1', { x: 50, y: 790 });
  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText('Seite 2', { x: 50, y: 790 });
  if (opts.rotate) p2.setRotation(degrees(opts.rotate));
  if (opts.foreignAnnot) {
    const annot = doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: PDFString.of('Notiz aus Acrobat') }),
    );
    p1.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
  }
  if (opts.encrypt) doc.encrypt({ userPassword: '', ownerPassword: 'geheim', permissions: { modifying: false }, algorithm: opts.encrypt });
  return doc.save();
}

const opts: WriteOptions = {
  fontSize: 11,
  fontFamily: 'Calibri',
  asset: async (id) => (id === 'pic' ? { data: PNG_1PX, mime: 'image/png' } : null),
};

function elementsOn(pages: { w: number; h: number }[]) {
  const slots = pdfLayout(pages).slots;
  const s1 = slots[0];
  const s2 = slots[1];
  const pen: InkElement = {
    id: 'pen1',
    type: 'ink',
    tool: 'pen',
    color: '#1976D2',
    size: 2.5,
    pts: [s1.x + 100, s1.y + 100, 0.4, s1.x + 140, s1.y + 120, 0.7, s1.x + 180, s1.y + 110, 0.5],
    z: 1,
    updatedAt: 1000,
  };
  const marker: InkElement = { id: 'hl1', type: 'ink', tool: 'highlighter', color: '#FFF200', size: 16, pts: [s2.x + 50, s2.y + 60, 0.5, s2.x + 250, s2.y + 60, 0.5], z: 2, updatedAt: 1001 };
  const ellipse: InkElement = { id: 'sh1', type: 'ink', tool: 'pen', color: '#D32F2F', size: 2, pts: [s2.x + 300, s2.y + 300, 0.5, s2.x + 400, s2.y + 360, 0.5], shape: 'ellipse', sim: true, z: 3, updatedAt: 1002 };
  const text: TextElement = {
    id: 'txt1',
    type: 'text',
    x: s1.x + 60,
    y: s1.y + 200,
    w: null,
    z: 4,
    updatedAt: 1003,
    doc: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Überschrift' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'fett', marks: [{ type: 'bold' }] }, { type: 'text', text: ' und Größe ∫ α' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Punkt' }] }] }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'erledigt' }] }] }] },
      ],
    },
  };
  const image: ImageElement = { id: 'img1', type: 'image', x: s2.x + 40, y: s2.y + 500, w: 120, h: 80, asset: 'pic', mime: 'image/png', z: 5, updatedAt: 1004 };
  return [pen, marker, ellipse, text, image];
}

const byId = (els: PageElement[]) => Object.fromEntries(els.map((e) => [e.id, e]));

async function annotationsOf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const arr = p.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!arr) return [];
    return arr.asArray().map((ref) => {
      const d = doc.context.lookup(ref, PDFDict);
      return String(d.get(PDFName.of('Subtype')));
    });
  });
}

/** Fonts used by the appearance of the first FreeText annotation. */
async function freeTextFonts(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray).asArray().map((r) => doc.context.lookup(r, PDFDict));
  const ft = annots.find((a) => a.get(PDFName.of('Subtype')) === PDFName.of('FreeText'))!;
  const ap = doc.context.lookup(ft.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))) as unknown as { dict: PDFDict };
  const fonts = ap.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
  return fonts
    .values()
    .map((ref) => String(doc.context.lookup(ref, PDFDict).get(PDFName.of('BaseFont'))).slice(1))
    .sort();
}

describe('PDF annotations', () => {
  it('writes NextNote elements as standard annotations and reads them back unchanged', async () => {
    const original = await samplePdf();
    const first = await readAnnotatedPdf(original);
    expect(first.clean).toBeNull();
    expect(first.elements).toEqual([]);
    expect(first.pages).toHaveLength(2);
    expect(first.pages[0].w).toBeCloseTo(793.71, 1);

    const els = elementsOn(first.pages);
    const out = await writeAnnotatedPdf(original, first.pages, { elements: byId(els), tombstones: { gone: 5 }, baseId: 'b1' }, opts);
    expect(await annotationsOf(out)).toEqual([['/FreeText', '/Ink'], ['/Stamp', '/Ink', '/Ink']]);

    const back = await readAnnotatedPdf(out);
    expect(byId(back.elements)).toEqual(byId(els));
    expect(back.tombstones).toEqual({ gone: 5 });
    expect(back.baseId).toBe('b1');
    expect(back.images).toEqual([{ id: 'pic', mime: 'image/png', data: PNG_1PX }]);
    // other viewers get the text, Greek letters and math symbols from the PDF symbol font
    expect(await freeTextFonts(out)).toEqual(['Helvetica', 'Helvetica-Bold', 'Symbol']);
    // the clean copy has none of our annotations left
    expect(back.clean).not.toBeNull();
    expect(await annotationsOf(back.clean!)).toEqual([[], []]);
  });

  it('does not grow when saved again and again', async () => {
    const original = await samplePdf();
    const { pages } = await readAnnotatedPdf(original);
    const body = { elements: byId(elementsOn(pages)), tombstones: {} };
    let bytes = await writeAnnotatedPdf(original, pages, body, opts);
    const size1 = bytes.length;
    for (let i = 0; i < 3; i++) {
      const r = await readAnnotatedPdf(bytes);
      bytes = await writeAnnotatedPdf(r.clean ?? bytes, r.pages, body, opts);
    }
    expect(Math.abs(bytes.length - size1)).toBeLessThan(size1 * 0.05);
    expect(await annotationsOf(bytes)).toEqual([['/FreeText', '/Ink'], ['/Stamp', '/Ink', '/Ink']]);
  });

  it('keeps annotations of other apps', async () => {
    const original = await samplePdf({ foreignAnnot: true });
    const { pages } = await readAnnotatedPdf(original);
    const out = await writeAnnotatedPdf(original, pages, { elements: byId(elementsOn(pages).slice(0, 1)), tombstones: {} }, opts);
    expect(await annotationsOf(out)).toEqual([['/Text', '/Ink'], []]);
    const back = await readAnnotatedPdf(out);
    expect(back.elements.map((e) => e.id)).toEqual(['pen1']);
    expect(await annotationsOf(back.clean!)).toEqual([['/Text'], []]);
  });

  it('handles rotated pages', async () => {
    const original = await samplePdf({ rotate: 90 });
    const { pages } = await readAnnotatedPdf(original);
    expect(pages[1].w).toBeCloseTo(1122.52, 1); // landscape on screen
    const els = elementsOn(pages);
    const out = await writeAnnotatedPdf(original, pages, { elements: byId(els), tombstones: {} }, opts);
    const back = await readAnnotatedPdf(out);
    expect(byId(back.elements)).toEqual(byId(els));
  });

  it.each(['AES-128', 'AES-256'] as const)('opens files that are protected against changes (%s)', async (algorithm) => {
    const original = await samplePdf({ encrypt: algorithm });
    expect(await PDFDocument.load(original).then(() => 'opened', (e) => String(e))).toMatch(/encrypt/i);
    const { pages } = await readAnnotatedPdf(original);
    const els = elementsOn(pages);
    const out = await writeAnnotatedPdf(original, pages, { elements: byId(els), tombstones: {} }, opts);
    // the result is a normal PDF that every app can open
    const plain = await PDFDocument.load(out);
    expect(plain.isEncrypted).toBe(false);
    expect(plain.getPageCount()).toBe(2);
    const back = await readAnnotatedPdf(out);
    expect(byId(back.elements)).toEqual(byId(els));
  });

  it('maps display coordinates to PDF user space for every rotation', () => {
    const box = { x0: 10, y0: 20, x1: 610, y1: 820 };
    for (const rot of [0, 90, 180, 270]) {
      const m = displayToUser(box, rot);
      const swap = rot % 180 !== 0;
      const w = ((swap ? 800 : 600) * 96) / 72;
      const h = ((swap ? 600 : 800) * 96) / 72;
      const corners = [applyMatrix(m, 0, 0), applyMatrix(m, w, 0), applyMatrix(m, 0, h), applyMatrix(m, w, h)].map(([x, y]) => [Math.round(x), Math.round(y)]);
      // the four corners of the visible page end up on the four corners of the box
      expect(corners.map((c) => c.join(',')).sort()).toEqual(['10,20', '10,820', '610,20', '610,820']);
      const back = applyMatrix(invertMatrix(m), ...applyMatrix(m, 123, 456));
      expect(back[0]).toBeCloseTo(123, 6);
      expect(back[1]).toBeCloseTo(456, 6);
    }
    // the top left corner on screen is the top left of an unrotated page
    expect(applyMatrix(displayToUser(box, 0), 0, 0)).toEqual([10, 820]);
  });
});
