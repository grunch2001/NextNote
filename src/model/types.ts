import type { JSONContent } from '@tiptap/core';

export type ID = string;

/** Per-field modification timestamps, used for last-writer-wins merging. */
export type FieldTimes = Record<string, number>;

/** Bookkeeping that every synced local record carries. */
export interface SyncFields {
  /** Local revision, bumped on every local change. */
  rev: number;
  /** Revision known to be stored on the server. rev > syncedRev means "dirty". */
  syncedRev: number;
  /** Remote ETag of the file at the last successful sync, null if never synced. */
  etag: string | null;
}

export interface Notebook extends SyncFields {
  id: ID;
  name: string;
  color: string;
  order: number;
  createdAt: number;
  times: FieldTimes;
  /** Folder name below the sync root, null until first upload. */
  folder: string | null;
  /** ETag of the notebook folder as seen in the root listing at the last clean sync. */
  folderEtag: string | null;
  /** Closed on this device: hidden and not synced, its PDFs are not kept. Local only, never uploaded. */
  closedAt?: number | null;
}

export interface Section extends SyncFields {
  id: ID;
  notebookId: ID;
  name: string;
  color: string;
  order: number;
  createdAt: number;
  deletedAt: number | null;
  times: FieldTimes;
  /** PDF section: Nextcloud folder (relative to the user's files) whose PDFs it shows. Missing/null: a normal section. */
  pdfFolder?: string | null;
}

/** Size of a PDF page as displayed (rotation applied) in CSS pixels at 100 %. */
export interface PdfPageBox {
  w: number;
  h: number;
}

/** A PDF in the Nextcloud folder of a PDF section. Its annotations are stored in the file itself. */
export interface PdfDoc {
  id: ID;
  sectionId: ID;
  /** Path relative to the section folder, e.g. "Übungen/Blatt 1.pdf". */
  path: string;
  /** Nextcloud file id: follows the file when it is renamed or moved within the folder. */
  fileId: string | null;
  /** ETag of the remote file the local copy corresponds to, null if it was never uploaded. */
  etag: string | null;
  size: number;
  lastModified: number;
  /** Page sizes, null until the file is available locally. */
  pages: PdfPageBox[] | null;
  /** Local revision of the annotations; rev > syncedRev means "not yet saved to Nextcloud". */
  rev: number;
  syncedRev: number;
  /** Element updatedAt values at the last sync, for conflict detection. */
  base: Record<ID, number>;
  /** Deleted locally, the file still has to be deleted in Nextcloud. */
  deletedAt: number | null;
  /** Why annotations cannot be written into this file (e.g. password protected), null if they can. */
  readOnly: string | null;
  /** Bumped whenever the stored PDF file changes, so that it is rendered again. */
  dataVersion: number;
  /** Identifies the stored file without annotations (see ReadResult.baseId). */
  baseId: string | null;
  /** Keep the file on this device (false: only in Nextcloud, loaded when opened). Missing means true. */
  offline?: boolean;
}

export type RuleStyle = 'none' | 'lines' | 'lines-wide' | 'grid' | 'dots';

export interface TagEntry {
  tag: string;
  text: string;
  checked?: boolean;
}

export interface PageMeta extends SyncFields {
  id: ID;
  notebookId: ID;
  sectionId: ID;
  title: string;
  order: number;
  level: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  bgColor: string | null;
  rule: RuleStyle;
  times: FieldTimes;
  /** Derived: lower-cased plain text of the page for search. */
  searchText: string;
  /** Derived: tagged paragraphs for the tag overview. */
  tags: TagEntry[];
  /** Element updatedAt values at the last sync, for conflict detection. */
  base: Record<ID, number>;
}

export interface PageBody {
  id: ID;
  elements: Record<ID, PageElement>;
  tombstones: Record<ID, number>;
}

interface ElementBase {
  id: ID;
  /** Stacking/creation order. */
  z: number;
  updatedAt: number;
}

export interface TextElement extends ElementBase {
  type: 'text';
  x: number;
  y: number;
  /** Fixed width in page pixels, null = automatic width. */
  w: number | null;
  doc: JSONContent;
  /** Set on a copy that was kept because of a sync conflict. */
  conflictOf?: ID;
  /** 'onenote': imported text keeps OneNote's line spacing and list indents, so ink next to it stays on its lines. */
  layout?: 'onenote';
}

/** axes1: first quadrant, axes2: positive x with positive and negative y, axes4: all four quadrants. */
export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse' | 'axes1' | 'axes2' | 'axes4' | 'poly';

export interface InkElement extends ElementBase {
  type: 'ink';
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  /** Flat list of x, y, pressure triples in page coordinates. */
  pts: number[];
  /** Pressure was simulated (mouse/finger): render with uniform width. */
  sim?: boolean;
  /** Geometric shape instead of freehand stroke. */
  shape?: ShapeKind;
}

export interface ImageElement extends ElementBase {
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  asset: ID;
  mime: string;
}

export type PageElement = TextElement | InkElement | ImageElement;

export interface AssetRecord {
  id: ID;
  notebookId: ID;
  mime: string;
  data: ArrayBuffer;
  /** 1 once the file exists on the server. */
  uploaded: 0 | 1;
}

/** A pending permanent deletion of a remote file or folder. */
export interface DeletionRecord {
  key: string;
  notebookId: ID;
  /** Path relative to the notebook folder, or '' for the whole notebook folder. */
  path: string;
  /** Notebook folder name at the time of deletion. */
  folder: string;
}

export type ElementPatch = Partial<Omit<TextElement, 'type' | 'id'>> &
  Partial<Omit<InkElement, 'type' | 'id'>> &
  Partial<Omit<ImageElement, 'type' | 'id'>>;
