/** The parts of the Microsoft Graph OneNote API that the import needs. */
import { NetworkError, type HttpFn, type HttpResponse } from '../../platform/types';
import { decodeUtf8 } from '../../model/util';
import type { TokenSource } from './auth';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphNotebook {
  id: string;
  displayName: string;
  lastModifiedDateTime?: string;
}

export interface GraphSection {
  id: string;
  displayName: string;
  createdDateTime?: string;
  /** Names of the section groups the section is in. */
  groups: string[];
}

export interface GraphPage {
  id: string;
  title?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  /** Only with pagelevel=true. */
  level?: number;
  order?: number;
}

export interface PageContent {
  html: string;
  inkml: string[];
}

export class GraphError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

function errorMessage(res: HttpResponse): string {
  let detail = '';
  try {
    const json = JSON.parse(decodeUtf8(res.body)) as { error?: { message?: string; code?: string } };
    detail = json.error?.message ?? json.error?.code ?? '';
  } catch {
    // not JSON
  }
  if (res.status === 403) return `Kein Zugriff (HTTP 403)${detail ? `: ${detail}` : ''}`;
  if (res.status === 404) return `Nicht gefunden (HTTP 404)${detail ? `: ${detail}` : ''}`;
  return `Microsoft Graph: HTTP ${res.status}${detail ? ` – ${detail}` : ''}`;
}

/** Splits a multipart body into its parts (all parts of a OneNote page are text). */
export function parseMultipart(contentType: string, body: Uint8Array): Array<{ headers: Record<string, string>; text: string }> {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const text = decodeUtf8(body);
  if (!m) return [{ headers: {}, text }];
  const boundary = '--' + (m[1] ?? m[2]);
  const out: Array<{ headers: Record<string, string>; text: string }> = [];
  for (const seg of text.split(boundary).slice(1)) {
    if (seg.startsWith('--')) break;
    const s = seg.replace(/^[ \t]*\r?\n/, '');
    let head = '';
    let content = s;
    if (/^\r?\n/.test(s)) {
      content = s.replace(/^\r?\n/, '');
    } else {
      const sep = /\r?\n\r?\n/.exec(s);
      if (sep) {
        head = s.slice(0, sep.index);
        content = s.slice(sep.index + sep[0].length);
      }
    }
    const headers: Record<string, string> = {};
    for (const line of head.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    out.push({ headers, text: content.replace(/\r?\n$/, '') });
  }
  return out;
}

const isInkML = (text: string) => text.includes('http://www.w3.org/2003/InkML');

function pageContentOf(res: HttpResponse): PageContent {
  const ct = res.headers['content-type'] ?? '';
  if (!/^multipart\//i.test(ct)) return { html: decodeUtf8(res.body), inkml: [] };
  const parts = parseMultipart(ct, res.body);
  const inkml = parts.filter((p) => isInkML(p.text) && !/html/i.test(p.headers['content-type'] ?? '')).map((p) => p.text);
  const html = parts.find((p) => /html/i.test(p.headers['content-type'] ?? '')) ?? parts.find((p) => !isInkML(p.text) && /<body[\s>]/i.test(p.text));
  return { html: html?.text ?? '', inkml };
}

export class GraphClient {
  constructor(
    private http: HttpFn,
    private auth: TokenSource,
    private base = GRAPH_BASE,
    private wait: (ms: number) => Promise<void> = sleep,
  ) {}

  /** Only URLs of this origin get the access token. */
  isGraphUrl(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.base).origin;
    } catch {
      return false;
    }
  }

  async get(pathOrUrl: string, accept: string | null = 'application/json'): Promise<HttpResponse> {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : this.base + pathOrUrl;
    if (!this.isGraphUrl(url)) throw new GraphError(0, `Adresse außerhalb von Microsoft Graph: ${url}`);
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.auth.token()}` };
      if (accept) headers.Accept = accept;
      let res: HttpResponse;
      try {
        res = await this.http({ method: 'GET', url, headers, timeoutMs: 120000 });
      } catch (e) {
        if (e instanceof NetworkError && attempt < 4) {
          attempt++;
          await this.wait(2000 * attempt);
          continue;
        }
        throw e;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.auth.refresh();
        continue;
      }
      if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && attempt < 8) {
        attempt++;
        const retryAfter = parseFloat(res.headers['retry-after'] ?? '');
        await this.wait(Math.min(120_000, retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** Math.min(attempt, 5)));
        continue;
      }
      if (res.status >= 400) throw new GraphError(res.status, errorMessage(res));
      return res;
    }
  }

  async json<T>(pathOrUrl: string): Promise<T> {
    return JSON.parse(decodeUtf8((await this.get(pathOrUrl)).body)) as T;
  }

  /** All entries of a collection, following @odata.nextLink. */
  async list<T>(pathOrUrl: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = pathOrUrl;
    while (next) {
      const page: { value?: T[]; '@odata.nextLink'?: string } = await this.json(next);
      out.push(...(page.value ?? []));
      next = page['@odata.nextLink'];
    }
    return out;
  }

  notebooks(): Promise<GraphNotebook[]> {
    return this.list<GraphNotebook>('/me/onenote/notebooks?$select=id,displayName,lastModifiedDateTime&$orderby=displayName');
  }

  /**
   * Sections of a notebook including those in (nested) section groups. The API does not expose the
   * tab order, so sections are sorted by creation time (new tabs usually go to the end).
   */
  async sections(notebookId: string): Promise<GraphSection[]> {
    type Item = { id: string; displayName: string; createdDateTime?: string };
    const byCreated = (a: Item, b: Item) => (a.createdDateTime ?? '').localeCompare(b.createdDateTime ?? '');
    const out: GraphSection[] = [];
    const visit = async (kind: 'notebooks' | 'sectionGroups', id: string, groups: string[]) => {
      const sections = await this.list<Item>(`/me/onenote/${kind}/${enc(id)}/sections?$select=id,displayName,createdDateTime`);
      for (const s of sections.sort(byCreated)) out.push({ id: s.id, displayName: s.displayName, createdDateTime: s.createdDateTime, groups });
      const sub = await this.list<Item>(`/me/onenote/${kind}/${enc(id)}/sectionGroups?$select=id,displayName,createdDateTime`);
      for (const g of sub.sort(byCreated)) await visit('sectionGroups', g.id, [...groups, g.displayName]);
    };
    await visit('notebooks', notebookId, []);
    return out;
  }

  /** Pages of a section in their order there, with level (sub pages). */
  async pages(sectionId: string): Promise<GraphPage[]> {
    const pages = await this.list<GraphPage>(`/me/onenote/sections/${enc(sectionId)}/pages?pagelevel=true&$top=100`);
    if (pages.every((p) => typeof p.order === 'number')) return pages.sort((a, b) => (a.order as number) - (b.order as number));
    return pages.sort((a, b) => (a.createdDateTime ?? '').localeCompare(b.createdDateTime ?? ''));
  }

  /**
   * Page HTML plus its ink as InkML. Ink that Graph cannot hand out (older handwriting) is missing
   * here, in v1.0 and beta alike; the HTML marks it with "InkNode is not supported" comments.
   */
  async pageContent(pageId: string): Promise<PageContent> {
    return pageContentOf(await this.get(`/me/onenote/pages/${enc(pageId)}/content?includeInkML=true`, null));
  }

  async resource(url: string): Promise<{ data: Uint8Array; mime: string | null }> {
    const res = await this.get(url, null);
    return { data: res.body, mime: res.headers['content-type']?.split(';')[0].trim() || null };
  }
}
