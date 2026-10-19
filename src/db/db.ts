import Dexie, { type Table } from 'dexie';
import type { AssetRecord, DeletionRecord, Notebook, PageBody, PageMeta, Section } from '../model/types';

export interface KV {
  k: string;
  v: unknown;
}

export class NextNoteDB extends Dexie {
  notebooks!: Table<Notebook, string>;
  sections!: Table<Section, string>;
  pages!: Table<PageMeta, string>;
  bodies!: Table<PageBody, string>;
  assets!: Table<AssetRecord, string>;
  deletions!: Table<DeletionRecord, string>;
  kv!: Table<KV, string>;

  constructor(name = 'nextnote') {
    super(name);
    this.version(1).stores({
      notebooks: 'id',
      sections: 'id, notebookId',
      pages: 'id, notebookId, sectionId',
      bodies: 'id',
      assets: 'id, notebookId, [notebookId+uploaded]',
      deletions: 'key, notebookId',
      kv: 'k',
    });
  }

  async getKV<T>(k: string): Promise<T | undefined> {
    const row = await this.kv.get(k);
    return row?.v as T | undefined;
  }

  async setKV(k: string, v: unknown): Promise<void> {
    if (v === undefined || v === null) await this.kv.delete(k);
    else await this.kv.put({ k, v });
  }
}

export const db = new NextNoteDB();
