import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { CancelledError, signInMicrosoft } from '../src/import/onenote/auth';
import { GraphClient, parseMultipart } from '../src/import/onenote/graph';
import { convertPageHtml } from '../src/import/onenote/html';
import { importFromOneNote } from '../src/import/onenote/importer';
import { decodeTrace, parseInkML } from '../src/import/onenote/inkml';
import type { ImageElement, InkElement, TextElement } from '../src/model/types';
import { docToText } from '../src/model/text';
import { MockOneNote } from '../tools/mockOneNote';
import { createDevice, createServer } from './helpers';

const INKML = `<?xml version="1.0" encoding="UTF-8"?>
<inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML" xmlns:msink="http://schemas.microsoft.com/ink/2010/main">
  <inkml:definitions>
    <inkml:context xml:id="ctxCoordinatesWithPressure">
      <inkml:inkSource xml:id="inkSrcCoordinatesWithPressure">
        <inkml:traceFormat>
          <inkml:channel name="X" type="integer" max="32767" units="himetric"/>
          <inkml:channel name="Y" type="integer" max="32767" units="himetric"/>
          <inkml:channel name="F" type="integer" max="32767" units="dev"/>
        </inkml:traceFormat>
        <inkml:channelProperties>
          <inkml:channelProperty channel="X" name="resolution" value="1" units="1/himetric"/>
          <inkml:channelProperty channel="Y" name="resolution" value="1" units="1/himetric"/>
          <inkml:channelProperty channel="F" name="resolution" value="1" units="1/dev"/>
        </inkml:channelProperties>
      </inkml:inkSource>
    </inkml:context>
    <inkml:brush xml:id="br0">
      <inkml:brushProperty name="width" value="100" units="himetric"/>
      <inkml:brushProperty name="height" value="100" units="himetric"/>
      <inkml:brushProperty name="color" value="#0000FF"/>
      <inkml:brushProperty name="transparency" value="0"/>
      <inkml:brushProperty name="tip" value="ellipse"/>
      <inkml:brushProperty name="rasterOp" value="copyPen"/>
    </inkml:brush>
    <inkml:brush xml:id="br1">
      <inkml:brushProperty name="width" value="0.2" units="cm"/>
      <inkml:brushProperty name="height" value="0.6" units="cm"/>
      <inkml:brushProperty name="color" value="#FFFF00"/>
      <inkml:brushProperty name="transparency" value="128"/>
      <inkml:brushProperty name="tip" value="rectangle"/>
    </inkml:brush>
  </inkml:definitions>
  <inkml:traceGroup>
    <msink:context type="writingRegion"/>
    <inkml:trace xml:id="st0" contextRef="#ctxCoordinatesWithPressure" brushRef="#br0">2540 5080 16383, 5080 5080 32767</inkml:trace>
    <inkml:trace xml:id="st1" contextRef="#ctxCoordinatesWithPressure" brushRef="#br1">2540 2540 8000,'2540'0'0</inkml:trace>
  </inkml:traceGroup>
</inkml:ink>`;

/** Output HTML example from the Microsoft Graph documentation. */
const SAMPLE_PAGE = `<html lang="en-US"><head><title>Sample Study Notes</title></head>
<body data-absolute-enabled="true" style="font-family:Calibri;font-size:11pt">
  <div data-id="_default" style="position:absolute;left:48px;top:120px;width:624px">
    <h1 style="font-size:16pt;color:#1e4e79;margin-top:11pt;margin-bottom:11pt">American History 101: Moon Landing</h1>
    <p>First moon landing - July 20, 1969 with Apollo 11 (Eagle)</p>
    <br />
    <p><span style="font-weight:bold">Apollo 11 Astronauts</span></p>
    <table style="border:0px">
      <tr><td style="border:0px">Neil Armstrong</td><td style="border:0px">Commander</td></tr>
      <tr><td style="border:0px">Buzz Aldrin</td><td style="border:0px">LM Pilot</td></tr>
    </table>
    <br />
    <img alt="Apollo 11 commemorative stamp." width="400" height="248" src="https://graph.microsoft.com/v1.0/me/onenote/resources/web1/$value"
      data-src-type="image/jpeg" data-fullres-src="https://graph.microsoft.com/v1.0/me/onenote/resources/img1/$value" data-fullres-src-type="image/jpeg" />
    <p>References:</p>
    <p><a href="https://en.wikipedia.org/wiki/Apollo_11">https://en.wikipedia.org/wiki/Apollo_11</a></p>
  </div>
</body></html>`;

function findAll(node: JSONContent, pred: (n: JSONContent) => boolean, out: JSONContent[] = []): JSONContent[] {
  if (pred(node)) out.push(node);
  for (const c of node.content ?? []) findAll(c, pred, out);
  return out;
}

const marksOf = (doc: JSONContent, text: string) => findAll(doc, (n) => n.type === 'text' && n.text === text)[0]?.marks ?? [];

describe('InkML', () => {
  it('decodes explicit, first and second differences in compact notation', () => {
    const rows = decodeTrace(`32 635 2757,'34'0'1090,"0"0"2950,-2 0-1347`, 3);
    expect(rows).toEqual([
      [32, 635, 2757],
      [66, 635, 3847],
      [100, 635, 7887],
      [132, 635, 10580],
    ]);
  });

  it('converts traces to page pixels with pressure and recognises highlighters', () => {
    const [pen, marker] = parseInkML(INKML);
    // 2540 himetric = 1 inch = 96 px
    expect(pen.pts).toEqual([96, 192, 0.5, 192, 192, 1]);
    expect(pen.color).toBe('#0000FF');
    expect(pen.width).toBeCloseTo(3.78, 2);
    expect(pen.highlighter).toBe(false);
    expect(pen.pressure).toBe(true);
    expect(marker.highlighter).toBe(true);
    expect(marker.width).toBeCloseTo(22.68, 1); // 0.6 cm
    expect(marker.pts.slice(3, 5)).toEqual([192, 96]);
  });

  it('honours units and resolution of the trace format', () => {
    const xml = `<inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML"><inkml:definitions>
      <inkml:context xml:id="ctx0"><inkml:inkSource xml:id="s"><inkml:traceFormat>
        <inkml:channel name="X" type="integer" max="32767" units="in"/><inkml:channel name="Y" type="integer" max="32767" units="in"/>
      </inkml:traceFormat><inkml:channelProperties>
        <inkml:channelProperty channel="X" name="resolution" value="1000" units="1/in"/>
        <inkml:channelProperty channel="Y" name="resolution" value="2000" units="1/in"/>
      </inkml:channelProperties></inkml:inkSource></inkml:context>
      <inkml:brush xml:id="br0"><inkml:brushProperty name="width" value="0.05" units="cm"/></inkml:brush>
    </inkml:definitions><inkml:trace contextRef="#ctx0" brushRef="#br0">1000 2000, 2000 4000</inkml:trace></inkml:ink>`;
    const [s] = parseInkML(xml);
    expect(s.pts).toEqual([96, 96, 0.5, 192, 192, 0.5]);
    expect(s.pressure).toBe(false);
    expect(s.width).toBeCloseTo(1.89, 2);
  });
});

describe('OneNote page HTML', () => {
  it('turns the outline into text containers and cuts out the image', () => {
    const page = convertPageHtml(SAMPLE_PAGE);
    expect(page.title).toBe('Sample Study Notes');
    expect(page.images).toHaveLength(1);
    const img = page.images[0];
    expect(img).toMatchObject({ x: 48, w: 400, h: 248, src: 'https://graph.microsoft.com/v1.0/me/onenote/resources/img1/$value', mime: 'image/jpeg' });
    expect(img.fallbackSrc).toContain('web1');
    expect(page.texts).toHaveLength(2);
    const [before, after] = page.texts;
    // the container is positioned so that its text starts where OneNote's did
    expect(before).toMatchObject({ x: 41, y: 116, w: 638 });
    expect(img.y).toBeGreaterThan(160);
    expect(after.y).toBeGreaterThanOrEqual(img.y + 248 - 4);
    expect(findAll(before.doc, (n) => n.type === 'heading')).toHaveLength(1);
    expect(findAll(before.doc, (n) => n.type === 'table')).toHaveLength(1);
    expect(marksOf(before.doc, 'Apollo 11 Astronauts').map((m) => m.type)).toEqual(['bold']);
    // default font (Calibri 11 pt) is not stored, so the text follows NextNote's default font
    expect(marksOf(before.doc, 'First moon landing - July 20, 1969 with Apollo 11 (Eagle)')).toEqual([]);
    expect(docToText(after.doc)).toContain('References:');
    expect(findAll(after.doc, (n) => n.type === 'text' && !!n.marks?.some((m) => m.type === 'link'))).toHaveLength(1);
  });

  it('maps note tags, to-dos, fonts, colours and highlights', () => {
    const html = `<html><head><title>Tags</title></head><body style="font-family:Calibri;font-size:11pt">
      <div style="position:absolute;left:300px;top:200px;width:400px">
        <p data-tag="to-do">Milch kaufen</p>
        <p data-tag="to-do:completed">Brot kaufen</p>
        <p data-tag="important">Wichtig!</p>
        <p data-tag="remember-for-later, question">Merken</p>
        <p data-tag="contact">Kontakt</p>
        <p style="color:#000000"><span style="font-family:Arial;font-size:14pt;color:#FF0000">Rot</span> und <span style="background-color:yellow">gelb</span></p>
        <ul><li><span data-tag="to-do">Eins</span></li><li><span data-tag="to-do:completed">Zwei</span></li></ul>
        <h5>Klein</h5>
        <object data-attachment="Skript.pdf" type="application/pdf" data="https://graph.microsoft.com/v1.0/me/onenote/resources/f1/$value"></object>
      </div></body></html>`;
    const page = convertPageHtml(html);
    expect(page.texts).toHaveLength(1);
    const doc = page.texts[0].doc;
    const lists = findAll(doc, (n) => n.type === 'taskList');
    expect(lists).toHaveLength(2);
    const items = findAll(lists[0], (n) => n.type === 'taskItem');
    expect(items.map((i) => [docToText(i), i.attrs?.checked])).toEqual([
      ['Milch kaufen', false],
      ['Brot kaufen', true],
    ]);
    expect(findAll(lists[1], (n) => n.type === 'taskItem').map((i) => i.attrs?.checked)).toEqual([false, true]);
    const tagged = findAll(doc, (n) => n.type === 'paragraph' && !!n.attrs?.tag);
    expect(tagged.map((p) => [docToText(p), p.attrs?.tag])).toEqual([
      ['Wichtig!', 'important'],
      ['Merken', 'remember'],
    ]);
    const red = marksOf(doc, 'Rot');
    expect(red).toEqual([{ type: 'textStyle', attrs: expect.objectContaining({ color: '#FF0000', fontSize: '14pt', fontFamily: expect.stringContaining('Arial') }) }]);
    expect(marksOf(doc, 'gelb')).toEqual([{ type: 'highlight', attrs: { color: '#FFFF00' } }]);
    expect(marksOf(doc, ' und ')).toEqual([]);
    expect(marksOf(doc, 'Klein').map((m) => m.type)).toEqual(['bold']);
    expect(page.attachments).toBe(1);
    expect(docToText(doc)).toContain('Anhang „Skript.pdf“ wurde nicht übernommen');
  });

  it('places absolutely positioned images directly', () => {
    const html = `<html><body><img style="position:absolute;left:500px;top:300px" width="200" height="100"
      src="https://graph.microsoft.com/v1.0/me/onenote/resources/a/$value" data-src-type="image/png" /></body></html>`;
    const page = convertPageHtml(html);
    expect(page.texts).toEqual([]);
    expect(page.images).toEqual([expect.objectContaining({ x: 500, y: 300, w: 200, h: 100, fallbackSrc: null })]);
  });
});

describe('Graph client', () => {
  it('splits multipart page content', () => {
    const body = new TextEncoder().encode('--b1\r\nContent-Type: text/html\r\n\r\n<html><body>x</body></html>\r\n--b1\r\nContent-Type: application/inkml+xml\r\n\r\n<ink/>\r\n--b1--\r\n');
    expect(parseMultipart('multipart/related; boundary="b1"', body)).toEqual([
      { headers: { 'content-type': 'text/html' }, text: '<html><body>x</body></html>' },
      { headers: { 'content-type': 'application/inkml+xml' }, text: '<ink/>' },
    ]);
  });

  it('never sends the access token to other hosts', async () => {
    const mock = new MockOneNote();
    const graph = new GraphClient((r) => mock.handle(r), { token: async () => 'x', refresh: async () => {} });
    await expect(graph.resource('https://evil.example/steal')).rejects.toThrow(/außerhalb/);
    expect(mock.requestLog).toEqual([]);
  });
});

function demoNotebook(mock: MockOneNote) {
  const img = mock.addResource('img1', new Uint8Array([137, 80, 78, 71]), 'image/png');
  const page = (id: string, title: string, extra: Partial<import('../tools/mockOneNote').MockPage> = {}) => ({
    id,
    title,
    createdDateTime: '2023-03-01T10:00:00Z',
    lastModifiedDateTime: '2023-03-0' + (id.length % 9) + 'T10:00:00Z',
    html: `<html><head><title>${title}</title></head><body><div style="position:absolute;left:48px;top:120px;width:500px"><p>Text von ${title}</p></div></body></html>`,
    ...extra,
  });
  mock.notebooks = [
    {
      id: 'nb1',
      displayName: 'Uni',
      sections: [
        {
          id: 's1',
          displayName: 'Mathe',
          createdDateTime: '2023-01-01T00:00:00Z',
          pages: [
            page('p1', 'Analysis', { order: 0, level: 0 }),
            page('p2', 'Grenzwerte', {
              order: 1,
              level: 1,
              createdDateTime: '2021-05-04T08:30:00Z',
              inkml: INKML,
              html: `<html><head><title>Grenzwerte</title></head><body><img style="position:absolute;left:100px;top:300px" width="320" height="200" src="${img}" data-src-type="image/png" /><img style="position:absolute;left:100px;top:600px" width="10" height="10" src="https://graph.microsoft.com/v1.0/me/onenote/resources/missing/$value" /></body></html>`,
            }),
            page('p3', 'Integrale', { order: 2, level: 0 }),
          ],
        },
      ],
      groups: [
        {
          id: 'g1',
          displayName: 'Semester 2',
          sections: [{ id: 's2', displayName: 'Physik', pages: [page('p4', 'Mechanik', { order: 0 })] }],
        },
      ],
    },
  ];
}

async function session(mock: MockOneNote) {
  return signInMicrosoft({
    http: (r) => mock.handle(r),
    clientId: 'client-123',
    authorize: async (url) => {
      const u = new URL(url);
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      expect(u.searchParams.get('scope')).toContain('Notes.Read');
      return { redirectUri: 'http://localhost:51234', code: 'mock-code', state: u.searchParams.get('state') ?? '' };
    },
  });
}

describe('OneNote import', () => {
  it('signs in and imports structure, text, images and ink, then syncs to Nextcloud', async () => {
    const mock = new MockOneNote();
    demoNotebook(mock);
    mock.pageSize = 2; // exercise @odata.nextLink
    mock.inkOnlyInBeta = true;
    mock.throttle = 1;
    const auth = await session(mock);
    expect(auth.account).toBe('Erika Mustermann');
    const graph = new GraphClient((r) => mock.handle(r), auth, undefined, async () => {});
    const server = createServer();
    const dev = createDevice(server, 'import');
    const notebooks = await graph.notebooks();
    const progress: number[] = [];
    const summary = await importFromOneNote({ graph, repo: dev.repo, notebooks, onProgress: (p) => progress.push(p.done) });
    expect(summary).toMatchObject({ sections: 2, pages: 4, images: 1, failedImages: 1, strokes: 2, cancelled: false, error: null, failedPages: [] });

    const [nb] = await dev.repo.listNotebooks();
    expect(nb.name).toBe('Uni');
    const sections = await dev.repo.listSections(nb.id);
    expect(sections.map((s) => s.name)).toEqual(['Mathe', 'Semester 2 › Physik']);
    const pages = await dev.repo.listPages(sections[0].id);
    expect(pages.map((p) => [p.title, p.level])).toEqual([
      ['Analysis', 0],
      ['Grenzwerte', 1],
      ['Integrale', 0],
    ]);
    expect(pages[1].createdAt).toBe(Date.parse('2021-05-04T08:30:00Z'));
    expect(pages[0].searchText).toContain('text von analysis');

    const { body } = (await dev.repo.getPage(pages[1].id))!;
    const els = Object.values(body.elements);
    const images = els.filter((e): e is ImageElement => e.type === 'image');
    const ink = els.filter((e): e is InkElement => e.type === 'ink');
    expect(images).toEqual([expect.objectContaining({ x: 100, y: 300, w: 320, h: 200, mime: 'image/png' })]);
    expect(ink.map((s) => s.tool)).toEqual(['pen', 'highlighter']);
    expect(ink[0]).toMatchObject({ color: '#0000FF', pts: [96, 192, 0.5, 192, 192, 1] });
    expect(ink[0].sim).toBeUndefined();
    expect(Math.min(...ink.map((s) => s.z))).toBeGreaterThan(images[0].z);
    expect(mock.requestLog.some((r) => r.url.includes('/beta/me/onenote/pages/p2/content'))).toBe(true);
    const asset = await dev.repo.getAsset(images[0].asset);
    expect(new Uint8Array(asset!.data)).toEqual(new Uint8Array([137, 80, 78, 71]));

    const texts = Object.values((await dev.repo.getPage(pages[0].id))!.body.elements).filter((e): e is TextElement => e.type === 'text');
    expect(texts.map((t) => docToText(t.doc))).toEqual(['Text von Analysis']);

    const r = await dev.sync();
    expect(r.errors).toEqual([]);
    const files = server.listFiles();
    expect(files.filter((f) => f.startsWith('NextNote/Uni/pages/'))).toHaveLength(4);
    expect(files.filter((f) => f.startsWith('NextNote/Uni/sections/'))).toHaveLength(2);
    expect(files.filter((f) => f.startsWith('NextNote/Uni/assets/'))).toHaveLength(1);
    expect(progress.at(-1)).toBe(4);
  });

  it('refreshes an expired token and keeps going', async () => {
    const mock = new MockOneNote();
    demoNotebook(mock);
    const auth = await session(mock);
    const graph = new GraphClient((r) => mock.handle(r), auth, undefined, async () => {});
    const notebooks = await graph.notebooks();
    mock.expireTokens();
    const dev = createDevice(createServer(), 'refresh');
    const summary = await importFromOneNote({ graph, repo: dev.repo, notebooks });
    expect(summary.pages).toBe(4);
    expect(mock.requestLog.filter((r) => r.status === 401)).toHaveLength(1);
  });

  it('stops when cancelled and keeps what was imported', async () => {
    const mock = new MockOneNote();
    demoNotebook(mock);
    const auth = await session(mock);
    const graph = new GraphClient((r) => mock.handle(r), auth, undefined, async () => {});
    const dev = createDevice(createServer(), 'cancel');
    let pagesSeen = 0;
    const summary = await importFromOneNote({
      graph,
      repo: dev.repo,
      notebooks: await graph.notebooks(),
      onProgress: (p) => {
        if (p.page) pagesSeen++;
      },
      isCancelled: () => pagesSeen >= 2,
    });
    expect(summary.cancelled).toBe(true);
    expect(summary.pages).toBe(1);
    expect(await dev.db.pages.count()).toBe(1);
  });

  it('gives a second import of the same notebook its own name', async () => {
    const mock = new MockOneNote();
    demoNotebook(mock);
    const auth = await session(mock);
    const graph = new GraphClient((r) => mock.handle(r), auth, undefined, async () => {});
    const dev = createDevice(createServer(), 'twice');
    const notebooks = await graph.notebooks();
    await importFromOneNote({ graph, repo: dev.repo, notebooks });
    await importFromOneNote({ graph, repo: dev.repo, notebooks });
    expect((await dev.repo.listNotebooks()).map((n) => n.name)).toEqual(['Uni', 'Uni (OneNote)']);
  });

  it('reports a cancelled sign-in', async () => {
    const mock = new MockOneNote();
    await expect(
      signInMicrosoft({ http: (r) => mock.handle(r), clientId: 'c', authorize: async () => ({ redirectUri: '', error: 'cancelled' }) }),
    ).rejects.toBeInstanceOf(CancelledError);
    await expect(
      signInMicrosoft({
        http: (r) => mock.handle(r),
        clientId: 'c',
        authorize: async () => ({ redirectUri: '', error: 'invalid_request', errorDescription: 'AADSTS50011: The redirect URI does not match' }),
      }),
    ).rejects.toThrow(/http:\/\/localhost/);
  });
});
