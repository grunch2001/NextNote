import { describe, expect, it } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { InkElement, PageElement } from '../src/model/types';
import { newId, now } from '../src/model/util';
import { readAnnotatedPdf } from '../src/pdf/annotate';
import { pdfLayout } from '../src/pdf/layout';
import { PdfRepo } from '../src/pdf/repo';
import { PdfSync } from '../src/pdf/sync';
import { createDevice, createServer } from './helpers';

async function makePdf(label: string, pages = 2) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]).drawText(`${label} ${i + 1}`, { x: 50, y: 790 });
  return doc.save();
}

function stroke(pageY: number, x = 100): InkElement {
  const t = now();
  return { id: newId(), type: 'ink', tool: 'pen', color: '#000000', size: 2, pts: [x, pageY + 100, 0.5, x + 50, pageY + 120, 0.5], z: t, updatedAt: t };
}

function pdfDevice(server: ReturnType<typeof createServer>, name: string) {
  const dev = createDevice(server, name);
  const pdfRepo = new PdfRepo(dev.db);
  const client = (dev.engine as unknown as { client: ConstructorParameters<typeof PdfSync>[1] }).client;
  const pdfSync = (force = false) => new PdfSync(pdfRepo, client, { writeOptions: () => ({ fontSize: 11, fontFamily: 'Calibri' }), force }).sync();
  const syncAll = async () => {
    const r = await dev.sync();
    expect(r.errors).toEqual([]);
    const p = await pdfSync();
    expect(p.errors).toEqual([]);
    return p;
  };
  return { ...dev, pdfRepo, pdfSync, syncAll };
}

async function annotate(dev: ReturnType<typeof pdfDevice>, docId: string, ...els: PageElement[]) {
  const body = await dev.pdfRepo.getBody(docId);
  await dev.pdfRepo.saveBody(docId, { ...body, elements: { ...body.elements, ...Object.fromEntries(els.map((e) => [e.id, e])) } });
}

async function serverIds(server: ReturnType<typeof createServer>, path: string) {
  const bytes = server.readBytes(path);
  if (!bytes) return null;
  return (await readAnnotatedPdf(bytes)).elements.map((e) => e.id).sort();
}

async function setup() {
  const server = createServer();
  server.writeFile('Uni/Mathe/Skript.pdf', await makePdf('Skript'));
  server.writeFile('Uni/Mathe/Übungen/Blatt 1.pdf', await makePdf('Blatt', 1));
  server.writeFile('Uni/Mathe/notizen.txt', 'keine PDF');
  const a = pdfDevice(server, 'a');
  const nb = await a.repo.addNotebook('Uni');
  const section = await a.repo.createSection(nb.id, 'Mathe', { pdfFolder: 'Uni/Mathe' });
  return { server, a, nb, section };
}

describe('PDF folders', () => {
  it('keeps all PDFs of the folder and its sub folders on the device', async () => {
    const { a, section } = await setup();
    expect(await a.repo.listPages(section.id)).toEqual([]);
    const r = await a.syncAll();
    expect(r.downloaded).toBe(2);
    const docs = await a.pdfRepo.listDocs(section.id);
    expect(docs.map((d) => d.path)).toEqual(['Skript.pdf', 'Übungen/Blatt 1.pdf']);
    expect(docs[0].pages).toHaveLength(2);
    expect(docs.every((d) => d.etag && d.fileId)).toBe(true);
    expect(await a.db.pdfFiles.count()).toBe(2);
  });

  it('saves annotations into the PDF and brings them to the other device', async () => {
    const { server, a, section } = await setup();
    await a.syncAll();
    const doc = (await a.pdfRepo.listDocs(section.id))[0];
    const slots = pdfLayout(doc.pages!).slots;
    const s1 = stroke(slots[0].y);
    const s2 = stroke(slots[1].y);
    await annotate(a, doc.id, s1, s2);
    const r = await a.syncAll();
    expect(r.uploaded).toBe(1);
    expect(await serverIds(server, 'Uni/Mathe/Skript.pdf')).toEqual([s1.id, s2.id].sort());
    // nothing else ended up in the NextNote folder
    expect(server.listFiles().filter((f) => f.startsWith('NextNote/') && !f.endsWith('.json'))).toEqual([]);

    const b = pdfDevice(server, 'b');
    await b.syncAll();
    const docB = (await b.pdfRepo.listDocs(section.id)).find((d) => d.path === 'Skript.pdf')!;
    expect(Object.keys((await b.pdfRepo.getBody(docB.id)).elements).sort()).toEqual([s1.id, s2.id].sort());
    expect((await b.pdfRepo.getBody(docB.id)).elements[s1.id]).toEqual(s1);
  });

  it('merges annotations made on two devices at the same time', async () => {
    const { server, a, section } = await setup();
    await a.syncAll();
    const b = pdfDevice(server, 'b');
    await b.syncAll();
    const docA = (await a.pdfRepo.listDocs(section.id))[0];
    const docB = (await b.pdfRepo.listDocs(section.id))[0];
    const y = pdfLayout(docA.pages!).slots[0].y;
    const fromA = stroke(y, 100);
    const fromB = stroke(y, 300);
    await annotate(a, docA.id, fromA);
    await annotate(b, docB.id, fromB);
    await a.syncAll();
    await b.syncAll(); // gets 412, merges, uploads
    await a.syncAll();
    const both = [fromA.id, fromB.id].sort();
    expect(await serverIds(server, 'Uni/Mathe/Skript.pdf')).toEqual(both);
    expect(Object.keys((await a.pdfRepo.getBody(docA.id)).elements).sort()).toEqual(both);
    expect(Object.keys((await b.pdfRepo.getBody(docB.id)).elements).sort()).toEqual(both);

    // erasing on one device removes the stroke everywhere
    const body = await b.pdfRepo.getBody(docB.id);
    const { [fromA.id]: _gone, ...rest } = body.elements;
    await b.pdfRepo.saveBody(docB.id, { ...body, elements: rest, tombstones: { ...body.tombstones, [fromA.id]: now() } });
    await b.syncAll();
    await a.syncAll();
    expect(Object.keys((await a.pdfRepo.getBody(docA.id)).elements)).toEqual([fromB.id]);
  });

  it('keeps the annotations when the file is renamed in Nextcloud', async () => {
    const { server, a, section } = await setup();
    await a.syncAll();
    const doc = (await a.pdfRepo.listDocs(section.id))[0];
    const s = stroke(pdfLayout(doc.pages!).slots[0].y);
    await annotate(a, doc.id, s);
    await a.syncAll();
    server.moveFile('Uni/Mathe/Skript.pdf', 'Uni/Mathe/Übungen/Skript WS.pdf');
    await a.syncAll();
    const after = await a.pdfRepo.getDoc(doc.id);
    expect(after?.path).toBe('Übungen/Skript WS.pdf');
    expect(Object.keys((await a.pdfRepo.getBody(doc.id)).elements)).toEqual([s.id]);
  });

  it('uploads PDFs added on the device and deletes PDFs deleted on the device', async () => {
    const { server, a, section } = await setup();
    await a.syncAll();
    const added = await a.pdfRepo.addFile(section.id, 'Skript.pdf', await makePdf('Neu', 1));
    expect(added.path).toBe('Skript (2).pdf');
    await a.syncAll();
    expect(server.listFiles()).toContain('Uni/Mathe/Skript (2).pdf');
    expect((await a.pdfRepo.getDoc(added.id))?.fileId).toBeTruthy();

    const blatt = (await a.pdfRepo.listDocs(section.id)).find((d) => d.path.startsWith('Übungen/'))!;
    await a.pdfRepo.trash(blatt.id);
    expect((await a.pdfRepo.listDocs(section.id)).map((d) => d.path)).not.toContain('Übungen/Blatt 1.pdf');
    await a.syncAll();
    expect(server.listFiles()).not.toContain('Uni/Mathe/Übungen/Blatt 1.pdf');
    expect(await a.pdfRepo.getDoc(blatt.id)).toBeUndefined();
  });

  it('forgets PDFs deleted in Nextcloud, but keeps unsaved annotations by uploading again', async () => {
    const { server, a, section } = await setup();
    await a.syncAll();
    const [skript, blatt] = await a.pdfRepo.listDocs(section.id);
    await annotate(a, blatt.id, stroke(pdfLayout(blatt.pages!).slots[0].y));
    server.files.get('alice')!.delete('Uni/Mathe/Skript.pdf');
    server.files.get('alice')!.delete('Uni/Mathe/Übungen/Blatt 1.pdf');
    server.writeFile('Uni/Mathe/trigger.txt', 'x');
    await a.syncAll();
    expect(await a.pdfRepo.getDoc(skript.id)).toBeUndefined();
    expect(server.listFiles()).toContain('Uni/Mathe/Übungen/Blatt 1.pdf');
  });

  it('waits with the upload while a PDF is being edited', async () => {
    const { server, a, section } = await setup();
    await a.syncAll();
    const doc = (await a.pdfRepo.listDocs(section.id))[0];
    a.pdfRepo.openId = doc.id;
    const s = stroke(pdfLayout(doc.pages!).slots[0].y);
    await annotate(a, doc.id, s);
    const r = await a.pdfSync();
    expect(r.uploaded).toBe(0);
    expect(r.retryInMs).toBeGreaterThan(20_000);
    expect(await serverIds(server, 'Uni/Mathe/Skript.pdf')).toEqual([]);
    const forced = await a.pdfSync(true);
    expect(forced.uploaded).toBe(1);
    expect(await serverIds(server, 'Uni/Mathe/Skript.pdf')).toEqual([s.id]);
  });

  it('removes the local copies when the notebook is deleted, but leaves the PDFs in Nextcloud', async () => {
    const { server, a, nb } = await setup();
    await a.syncAll();
    expect(await a.db.pdfDocs.count()).toBe(2);
    await a.repo.deleteNotebook(nb.id);
    await a.syncAll();
    expect(await a.db.pdfDocs.count()).toBe(0);
    expect(await a.db.pdfFiles.count()).toBe(0);
    expect(server.listFiles().filter((f) => f.endsWith('.pdf'))).toEqual(['Uni/Mathe/Skript.pdf', 'Uni/Mathe/Übungen/Blatt 1.pdf']);
  });

  it('only checks the folder when nothing changed', async () => {
    const { server, a } = await setup();
    await a.syncAll();
    await a.pdfSync();
    server.requestLog = [];
    await a.pdfSync();
    expect(server.requestLog.map((r) => `${r.method} ${r.path}`)).toEqual(['PROPFIND /remote.php/dav/files/alice/Uni/Mathe']);
  });
});
