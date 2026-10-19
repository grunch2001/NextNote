import { describe, expect, it } from 'vitest';
import { resetSyncState } from '../src/sync/engine';
import type { TextElement } from '../src/model/types';
import { docToText } from '../src/model/text';
import { now } from '../src/model/util';
import { createDevice, createServer, inkEl, textEl, withElements } from './helpers';

async function pageTexts(dev: ReturnType<typeof createDevice>, pageId: string) {
  const p = await dev.repo.getPage(pageId);
  return Object.values(p!.body.elements)
    .filter((e): e is TextElement => e.type === 'text')
    .map((e) => docToText(e.doc))
    .sort();
}

describe('sync engine', () => {
  it('uploads a new notebook and downloads it on a second device', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    const b = createDevice(server, 'b');
    const { notebook, page } = await a.repo.createNotebook('Uni Notizen');
    await a.repo.updatePage(page.id, { title: 'Mathe' });
    await a.repo.savePageBody(page.id, { id: page.id, elements: withElements(textEl('Hallo Welt'), inkEl()), tombstones: {} });
    const r1 = await a.sync();
    expect(r1.errors).toEqual([]);
    const files = server.listFiles();
    expect(files).toContain('NextNote/Uni Notizen/notebook.json');
    expect(files.filter((f) => f.startsWith('NextNote/Uni Notizen/pages/'))).toHaveLength(1);
    expect(files.filter((f) => f.startsWith('NextNote/Uni Notizen/sections/'))).toHaveLength(1);

    const r2 = await b.sync();
    expect(r2.errors).toEqual([]);
    const nbs = await b.repo.listNotebooks();
    expect(nbs.map((n) => n.name)).toEqual(['Uni Notizen']);
    expect(nbs[0].id).toBe(notebook.id);
    const sections = await b.repo.listSections(notebook.id);
    const pages = await b.repo.listPages(sections[0].id);
    expect(pages[0].title).toBe('Mathe');
    expect(await pageTexts(b, page.id)).toEqual(['Hallo Welt']);
    expect(pages[0].searchText).toContain('hallo welt');
  });

  it('does nothing but one PROPFIND when nothing changed', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    await a.repo.createNotebook('Privat');
    await a.sync();
    await a.sync(); // first follow-up may re-list folders touched by the upload
    server.requestLog = [];
    await a.sync();
    expect(server.requestLog.map((r) => r.method)).toEqual(['PROPFIND']);
  });

  it('merges concurrent edits on different elements of the same page', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    const b = createDevice(server, 'b');
    const { page } = await a.repo.createNotebook('NB');
    const t1 = textEl('von A');
    await a.repo.savePageBody(page.id, { id: page.id, elements: withElements(t1), tombstones: {} });
    await a.sync();
    await b.sync();

    // offline edits on both devices
    const pa = (await a.repo.getPage(page.id))!;
    await a.repo.savePageBody(page.id, { ...pa.body, elements: { ...pa.body.elements, ...withElements(textEl('zweiter Text A')) } });
    await a.repo.updatePage(page.id, { title: 'Titel von A' });
    const pb = (await b.repo.getPage(page.id))!;
    const stroke = inkEl();
    await b.repo.savePageBody(page.id, { ...pb.body, elements: { ...pb.body.elements, [stroke.id]: stroke } });

    await a.sync();
    const rb = await b.sync();
    expect(rb.errors).toEqual([]);
    await a.sync();

    for (const dev of [a, b]) {
      const p = (await dev.repo.getPage(page.id))!;
      expect(p.meta.title).toBe('Titel von A');
      expect(Object.keys(p.body.elements)).toContain(stroke.id);
      expect(await pageTexts(dev, page.id)).toEqual(['von A', 'zweiter Text A']);
      expect(p.meta.rev).toBe(p.meta.syncedRev);
    }
  });

  it('keeps both versions when the same text box was edited on two devices', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    const b = createDevice(server, 'b');
    const { page } = await a.repo.createNotebook('NB');
    const t1 = textEl('Original');
    await a.repo.savePageBody(page.id, { id: page.id, elements: withElements(t1), tombstones: {} });
    await a.sync();
    await b.sync();

    const ea = { ...t1, updatedAt: now(), doc: textEl('Version A').doc };
    await a.repo.savePageBody(page.id, { id: page.id, elements: withElements(ea), tombstones: {} });
    const eb = { ...t1, updatedAt: now(), doc: textEl('Version B').doc };
    await b.repo.savePageBody(page.id, { id: page.id, elements: withElements(eb), tombstones: {} });

    await a.sync();
    const rb = await b.sync();
    expect(rb.conflicts).toBe(1);
    await a.sync();
    expect(await pageTexts(a, page.id)).toEqual(['Version A', 'Version B']);
    expect(await pageTexts(b, page.id)).toEqual(['Version A', 'Version B']);
  });

  it('propagates element deletion, page purge and notebook rename', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    const b = createDevice(server, 'b');
    const { notebook, section, page } = await a.repo.createNotebook('Alt');
    const t1 = textEl('löschen');
    await a.repo.savePageBody(page.id, { id: page.id, elements: withElements(t1), tombstones: {} });
    const second = await a.repo.createPage(section.id, { title: 'Zweite' });
    await a.sync();
    await b.sync();
    expect((await b.repo.listPages(section.id)).length).toBe(2);

    // A deletes the text box, purges the second page and renames the notebook
    await a.repo.savePageBody(page.id, { id: page.id, elements: {}, tombstones: { [t1.id]: now() } });
    await a.repo.trashPage(second.id);
    await a.repo.purgePage(second.id);
    await a.repo.updateNotebook(notebook.id, { name: 'Neu' });
    await a.sync();
    expect(server.listFiles().some((f) => f.startsWith('NextNote/Neu/'))).toBe(true);
    expect(server.listFiles().some((f) => f.startsWith('NextNote/Alt/'))).toBe(false);

    await b.sync();
    expect(await pageTexts(b, page.id)).toEqual([]);
    expect((await b.repo.listPages(section.id)).map((p) => p.id)).toEqual([page.id]);
    const nbs = await b.repo.listNotebooks();
    expect(nbs).toHaveLength(1);
    expect(nbs[0].name).toBe('Neu');
    expect(nbs[0].folder).toBe('Neu');
  });

  it('deletes a notebook on all devices', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    const b = createDevice(server, 'b');
    const { notebook } = await a.repo.createNotebook('Weg damit');
    await a.repo.createNotebook('Bleibt');
    await a.sync();
    await b.sync();
    expect(await b.repo.listNotebooks()).toHaveLength(2);
    await a.repo.deleteNotebook(notebook.id);
    await a.sync();
    expect(server.listFiles().some((f) => f.includes('Weg damit'))).toBe(false);
    await b.sync();
    expect((await b.repo.listNotebooks()).map((n) => n.name)).toEqual(['Bleibt']);
  });

  it('syncs images as separate files', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    const b = createDevice(server, 'b');
    const { notebook, page } = await a.repo.createNotebook('Bilder');
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const assetId = await a.repo.addAsset(notebook.id, bytes.buffer, 'image/png');
    const t = now();
    await a.repo.savePageBody(page.id, {
      id: page.id,
      elements: { img: { id: 'img', type: 'image', x: 10, y: 10, w: 100, h: 80, asset: assetId, mime: 'image/png', z: t, updatedAt: t } },
      tombstones: {},
    });
    await a.sync();
    expect(server.listFiles()).toContain(`NextNote/Bilder/assets/${assetId}.png`);
    await b.sync();
    const asset = await b.repo.getAsset(assetId);
    expect(asset).toBeDefined();
    expect(new Uint8Array(asset!.data)).toEqual(bytes);
    expect(asset!.mime).toBe('image/png');
  });

  it('moves sections between notebooks', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    const b = createDevice(server, 'b');
    const one = await a.repo.createNotebook('Eins');
    const two = await a.repo.createNotebook('Zwei');
    await a.repo.updatePage(one.page.id, { title: 'Wandert mit' });
    await a.sync();
    await b.sync();
    await a.repo.moveSectionToNotebook(one.section.id, two.notebook.id);
    await a.sync();
    expect(server.listFiles().filter((f) => f.startsWith('NextNote/Eins/pages/'))).toHaveLength(0);
    expect(server.listFiles().filter((f) => f.startsWith('NextNote/Zwei/pages/'))).toHaveLength(2);
    await b.sync();
    const moved = await b.db.pages.get(one.page.id);
    expect(moved?.notebookId).toBe(two.notebook.id);
    expect(moved?.title).toBe('Wandert mit');
    expect(await b.repo.listSections(one.notebook.id)).toHaveLength(0);
    expect(await b.repo.listSections(two.notebook.id)).toHaveLength(2);
  });

  it('reconnecting after a reset does not duplicate data', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    const { page } = await a.repo.createNotebook('Einmalig');
    await a.repo.savePageBody(page.id, { id: page.id, elements: withElements(textEl('x')), tombstones: {} });
    await a.sync();
    const before = server.listFiles();
    await resetSyncState(a.db);
    const r = await a.sync();
    expect(r.errors).toEqual([]);
    expect(server.listFiles()).toEqual(before);
    expect(await a.repo.listNotebooks()).toHaveLength(1);
    const p = await a.db.pages.get(page.id);
    expect(p!.rev).toBe(p!.syncedRev);
  });

  it('a remote rename of a notebook folder is picked up without duplicates', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    await a.repo.createNotebook('Ordner');
    await a.sync();
    // the user renames the folder in the Nextcloud web interface
    await server.handle({
      method: 'MOVE',
      url: 'https://cloud.test/remote.php/dav/files/alice/NextNote/Ordner',
      headers: { Authorization: 'Basic ' + btoa('alice:pw'), Destination: 'https://cloud.test/remote.php/dav/files/alice/NextNote/Umbenannt' },
    });
    const r = await a.sync();
    expect(r.errors).toEqual([]);
    const nbs = await a.repo.listNotebooks();
    expect(nbs).toHaveLength(1);
    expect(nbs[0].folder).toBe('Umbenannt');
  });
});

describe('local saves during sync', () => {
  it('saving an older editor state does not drop elements that arrived via sync', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    const b = createDevice(server, 'b');
    const { page } = await a.repo.createNotebook('NB');
    await a.sync();
    await b.sync();
    // the editor on A holds this state in memory
    const editorState = (await a.repo.getPage(page.id))!.body;
    const mine = textEl('lokal getippt');
    // meanwhile B adds a stroke and A's sync downloads it
    const stroke = inkEl();
    await b.repo.savePageBody(page.id, { id: page.id, elements: withElements(stroke), tombstones: {} });
    await b.sync();
    await a.sync();
    // now A's editor saves its (older) state plus the new text box
    await a.repo.savePageBody(page.id, { ...editorState, elements: { ...editorState.elements, [mine.id]: mine } });
    const ids = Object.keys((await a.repo.getPage(page.id))!.body.elements);
    expect(ids).toContain(stroke.id);
    expect(ids).toContain(mine.id);
    await a.sync();
    await b.sync();
    expect(Object.keys((await b.repo.getPage(page.id))!.body.elements).sort()).toEqual([stroke.id, mine.id].sort());
  });

  it('deleting an element still wins over the stored copy', async () => {
    const server = createServer();
    const a = createDevice(server, 'a');
    const { page } = await a.repo.createNotebook('NB');
    const t1 = textEl('weg');
    await a.repo.savePageBody(page.id, { id: page.id, elements: withElements(t1), tombstones: {} });
    await a.repo.savePageBody(page.id, { id: page.id, elements: {}, tombstones: { [t1.id]: now() } });
    expect(Object.keys((await a.repo.getPage(page.id))!.body.elements)).toEqual([]);
  });
});
