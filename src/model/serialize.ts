import type { FieldTimes, ID, Notebook, PageBody, PageElement, PageMeta, RuleStyle, Section } from './types';

/**
 * File formats stored in Nextcloud.
 *
 *   <root>/<Notebook folder>/notebook.json
 *   <root>/<Notebook folder>/sections/<sectionId>.json
 *   <root>/<Notebook folder>/pages/<pageId>.json
 *   <root>/<Notebook folder>/assets/<assetId>.<ext>
 */
export const FORMAT_VERSION = 1;

export interface RemoteNotebook {
  format: 'nextnote-notebook';
  version: number;
  id: ID;
  name: string;
  color: string;
  order: number;
  createdAt: number;
  times: FieldTimes;
}

export interface RemoteSection {
  format: 'nextnote-section';
  version: number;
  id: ID;
  name: string;
  color: string;
  order: number;
  createdAt: number;
  deletedAt: number | null;
  times: FieldTimes;
}

export interface RemotePage {
  format: 'nextnote-page';
  version: number;
  id: ID;
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
  elements: PageElement[];
  tombstones: Record<ID, number>;
}

export function notebookToRemote(nb: Notebook): RemoteNotebook {
  return {
    format: 'nextnote-notebook',
    version: FORMAT_VERSION,
    id: nb.id,
    name: nb.name,
    color: nb.color,
    order: nb.order,
    createdAt: nb.createdAt,
    times: nb.times,
  };
}

export function sectionToRemote(s: Section): RemoteSection {
  return {
    format: 'nextnote-section',
    version: FORMAT_VERSION,
    id: s.id,
    name: s.name,
    color: s.color,
    order: s.order,
    createdAt: s.createdAt,
    deletedAt: s.deletedAt,
    times: s.times,
  };
}

export function sortedElements(elements: Record<ID, PageElement>): PageElement[] {
  return Object.values(elements).sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function pageToRemote(meta: PageMeta, body: PageBody): RemotePage {
  return {
    format: 'nextnote-page',
    version: FORMAT_VERSION,
    id: meta.id,
    sectionId: meta.sectionId,
    title: meta.title,
    order: meta.order,
    level: meta.level,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    deletedAt: meta.deletedAt,
    bgColor: meta.bgColor,
    rule: meta.rule,
    times: meta.times,
    elements: sortedElements(body.elements),
    tombstones: body.tombstones,
  };
}

export function remoteBody(page: RemotePage): PageBody {
  const elements: Record<ID, PageElement> = {};
  for (const el of page.elements) elements[el.id] = el;
  return { id: page.id, elements, tombstones: page.tombstones ?? {} };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const times = (v: unknown): FieldTimes => {
  const out: FieldTimes = {};
  if (isObj(v)) for (const [k, t] of Object.entries(v)) if (typeof t === 'number') out[k] = t;
  return out;
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseNotebook(text: string): RemoteNotebook | null {
  const v = parseJson(text);
  if (!isObj(v) || v.format !== 'nextnote-notebook' || typeof v.id !== 'string') return null;
  return {
    format: 'nextnote-notebook',
    version: num(v.version, 1),
    id: v.id,
    name: str(v.name, 'Notizbuch'),
    color: str(v.color, '#7A3FB8'),
    order: num(v.order),
    createdAt: num(v.createdAt),
    times: times(v.times),
  };
}

export function parseSection(text: string): RemoteSection | null {
  const v = parseJson(text);
  if (!isObj(v) || v.format !== 'nextnote-section' || typeof v.id !== 'string') return null;
  return {
    format: 'nextnote-section',
    version: num(v.version, 1),
    id: v.id,
    name: str(v.name, 'Abschnitt'),
    color: str(v.color, '#8AA8E4'),
    order: num(v.order),
    createdAt: num(v.createdAt),
    deletedAt: typeof v.deletedAt === 'number' ? v.deletedAt : null,
    times: times(v.times),
  };
}

function validElement(e: unknown): e is PageElement {
  if (!isObj(e) || typeof e.id !== 'string' || typeof e.updatedAt !== 'number') return false;
  if (e.type === 'text') return isObj(e.doc) && typeof e.x === 'number' && typeof e.y === 'number';
  if (e.type === 'ink') return Array.isArray(e.pts) && typeof e.color === 'string';
  if (e.type === 'image') return typeof e.asset === 'string' && typeof e.w === 'number';
  return false;
}

const RULES: RuleStyle[] = ['none', 'lines', 'lines-wide', 'grid', 'dots'];

export function parsePage(text: string): RemotePage | null {
  const v = parseJson(text);
  if (!isObj(v) || v.format !== 'nextnote-page' || typeof v.id !== 'string' || typeof v.sectionId !== 'string') return null;
  const elements = Array.isArray(v.elements) ? v.elements.filter(validElement) : [];
  for (const el of elements) if (typeof el.z !== 'number') (el as PageElement).z = el.updatedAt;
  const tomb: Record<ID, number> = {};
  if (isObj(v.tombstones)) for (const [k, t] of Object.entries(v.tombstones)) if (typeof t === 'number') tomb[k] = t;
  return {
    format: 'nextnote-page',
    version: num(v.version, 1),
    id: v.id,
    sectionId: v.sectionId,
    title: str(v.title),
    order: num(v.order),
    level: Math.max(0, Math.min(2, num(v.level))),
    createdAt: num(v.createdAt),
    updatedAt: num(v.updatedAt),
    deletedAt: typeof v.deletedAt === 'number' ? v.deletedAt : null,
    bgColor: typeof v.bgColor === 'string' ? v.bgColor : null,
    rule: RULES.includes(v.rule as RuleStyle) ? (v.rule as RuleStyle) : 'none',
    times: times(v.times),
    elements,
    tombstones: tomb,
  };
}
