import { NextNoteDB } from '../src/db/db';
import { Repo } from '../src/db/repo';
import type { PageElement, TextElement, InkElement } from '../src/model/types';
import { newId, now } from '../src/model/util';
import { SyncEngine } from '../src/sync/engine';
import { basicAuth, davBaseUrl } from '../src/sync/nextcloud';
import { WebDavClient } from '../src/sync/webdav';
import { MockNextcloud } from '../tools/mockNextcloud';

export const BASE = 'https://cloud.test';

export function createServer() {
  return new MockNextcloud({ baseUrl: BASE, users: { alice: { password: 'pw', displayName: 'Alice' } } });
}

export function createDevice(server: MockNextcloud, name = 'dev') {
  const db = new NextNoteDB(`${name}-${newId(8)}`);
  const repo = new Repo(db);
  const client = new WebDavClient((r) => server.handle(r), davBaseUrl({ server: BASE, userId: 'alice' }), basicAuth('alice', 'pw'));
  const engine = new SyncEngine(db, client, 'NextNote');
  return { db, repo, engine, sync: () => engine.sync() };
}

export function textEl(text: string, x = 40, y = 120): TextElement {
  const t = now();
  return {
    id: newId(),
    type: 'text',
    x,
    y,
    w: null,
    z: t,
    updatedAt: t,
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  };
}

export function inkEl(): InkElement {
  const t = now();
  return { id: newId(), type: 'ink', tool: 'pen', color: '#000', size: 2, pts: [0, 0, 0.5, 10, 10, 0.5], z: t, updatedAt: t };
}

export function withElements(...els: PageElement[]) {
  return Object.fromEntries(els.map((e) => [e.id, e]));
}
