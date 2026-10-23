/**
 * In-memory emulation of the Microsoft identity platform token endpoint and the Microsoft Graph
 * OneNote endpoints that the OneNote import uses (notebooks, sections, section groups, pages with
 * pagelevel and paging, page content with InkML as multipart, resources, 401/429 handling).
 * Used by the automated tests and for manual UI tests.
 */
import type { HttpRequest, HttpResponse } from '../src/platform/types';

export interface MockPage {
  id: string;
  title: string;
  level?: number;
  order?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  html: string;
  inkml?: string;
}

export interface MockSection {
  id: string;
  displayName: string;
  createdDateTime?: string;
  pages: MockPage[];
}

export interface MockGroup {
  id: string;
  displayName: string;
  createdDateTime?: string;
  sections: MockSection[];
  groups?: MockGroup[];
}

export interface MockNotebook {
  id: string;
  displayName: string;
  sections: MockSection[];
  groups?: MockGroup[];
}

const enc = new TextEncoder();

const b64url = (s: string) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class MockOneNote {
  graphOrigin = 'https://graph.microsoft.com';
  loginBase = 'https://login.microsoftonline.com/common/oauth2/v2.0';
  notebooks: MockNotebook[] = [];
  resources = new Map<string, { data: Uint8Array; mime: string }>();
  requestLog: Array<{ method: string; url: string; status: number }> = [];
  /** v1.0 answers without ink (like the real service sometimes does); beta delivers it. */
  inkOnlyInBeta = false;
  /** Number of upcoming Graph requests to answer with 429. */
  throttle = 0;
  /** Page size for page listings (to exercise @odata.nextLink). */
  pageSize = 100;
  /** CORS headers for use from a browser (manual UI tests). */
  cors = false;
  validTokens = new Set<string>();
  private counter = 0;

  constructor(notebooks: MockNotebook[] = []) {
    this.notebooks = notebooks;
  }

  addResource(id: string, data: Uint8Array, mime: string): string {
    this.resources.set(id, { data, mime });
    return `${this.graphOrigin}/v1.0/me/onenote/resources/${id}/$value`;
  }

  /** Makes the current access tokens invalid (as if they expired). */
  expireTokens() {
    this.validTokens.clear();
  }

  private res(status: number, body: string | Uint8Array, headers: Record<string, string> = {}): HttpResponse {
    if (this.cors) {
      headers['access-control-allow-origin'] = '*';
      headers['access-control-allow-headers'] = '*';
      headers['access-control-expose-headers'] = '*';
    }
    return { status, headers, body: typeof body === 'string' ? enc.encode(body) : body };
  }

  private json(value: unknown, status = 200): HttpResponse {
    return this.res(status, JSON.stringify(value), { 'content-type': 'application/json' });
  }

  async handle(req: HttpRequest): Promise<HttpResponse> {
    const r = this.route(req);
    this.requestLog.push({ method: req.method, url: req.url, status: r.status });
    return r;
  }

  private route(req: HttpRequest): HttpResponse {
    if (req.method === 'OPTIONS') return this.res(204, '');
    if (req.url === `${this.loginBase}/token` && req.method === 'POST') return this.token(req);
    const url = new URL(req.url);
    if (url.origin !== this.graphOrigin) return this.res(404, 'unknown host');
    const m = /^\/(v1\.0|beta)(\/.*)$/.exec(decodeURIComponent(url.pathname));
    if (!m) return this.res(404, '');
    const auth = (req.headers?.Authorization ?? req.headers?.authorization ?? '').replace(/^Bearer /, '');
    if (!this.validTokens.has(auth)) return this.json({ error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } }, 401);
    if (this.throttle > 0) {
      this.throttle--;
      return this.res(429, '', { 'retry-after': '1' });
    }
    return this.graph(m[1], m[2], url);
  }

  private token(req: HttpRequest): HttpResponse {
    const body = typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body);
    const p = new URLSearchParams(body);
    const grant = p.get('grant_type');
    if (grant === 'authorization_code' && (p.get('code') !== 'mock-code' || !p.get('code_verifier') || !p.get('redirect_uri'))) {
      return this.json({ error: 'invalid_grant', error_description: 'AADSTS70008: bad code' }, 400);
    }
    if (grant === 'refresh_token' && p.get('refresh_token') !== 'mock-refresh') return this.json({ error: 'invalid_grant' }, 400);
    const token = `at-${++this.counter}`;
    this.validTokens.add(token);
    const idToken = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ name: 'Erika Mustermann' }))}.`;
    return this.json({ token_type: 'Bearer', access_token: token, refresh_token: 'mock-refresh', expires_in: 3600, id_token: idToken });
  }

  private allSections(): Array<{ s: MockSection; parent: string }> {
    const out: Array<{ s: MockSection; parent: string }> = [];
    const visitGroups = (groups: MockGroup[] = []) => {
      for (const g of groups) {
        for (const s of g.sections) out.push({ s, parent: g.id });
        visitGroups(g.groups);
      }
    };
    for (const nb of this.notebooks) {
      for (const s of nb.sections) out.push({ s, parent: nb.id });
      visitGroups(nb.groups);
    }
    return out;
  }

  private findGroup(id: string): MockGroup | undefined {
    const visit = (groups: MockGroup[] = []): MockGroup | undefined => {
      for (const g of groups) {
        if (g.id === id) return g;
        const sub = visit(g.groups);
        if (sub) return sub;
      }
      return undefined;
    };
    for (const nb of this.notebooks) {
      const g = visit(nb.groups);
      if (g) return g;
    }
    return undefined;
  }

  private graph(version: string, path: string, url: URL): HttpResponse {
    const strip = (items: object[], keys: string[]) =>
      items.map((it) => Object.fromEntries(Object.entries(it).filter(([k]) => keys.includes(k))));
    let m: RegExpExecArray | null;
    if (path === '/me/onenote/notebooks') return this.json({ value: strip(this.notebooks, ['id', 'displayName']) });
    if ((m = /^\/me\/onenote\/(notebooks|sectionGroups)\/([^/]+)\/(sections|sectionGroups)$/.exec(path))) {
      const parent = m[1] === 'notebooks' ? this.notebooks.find((n) => n.id === m![2]) : this.findGroup(m[2]);
      if (!parent) return this.json({ error: { code: '20102', message: 'not found' } }, 404);
      const list = m[3] === 'sections' ? parent.sections : (parent.groups ?? []);
      return this.json({ value: strip(list, ['id', 'displayName', 'createdDateTime']) });
    }
    if ((m = /^\/me\/onenote\/sections\/([^/]+)\/pages$/.exec(path))) {
      const s = this.allSections().find((x) => x.s.id === m![1])?.s;
      if (!s) return this.json({ error: { code: '20102', message: 'not found' } }, 404);
      const level = url.searchParams.get('pagelevel') === 'true';
      const skip = Number(url.searchParams.get('$skip') ?? 0);
      const top = Math.min(this.pageSize, Number(url.searchParams.get('$top') ?? 20));
      // default order of the service: last modified first
      const sorted = [...s.pages].sort((a, b) => (b.lastModifiedDateTime ?? '').localeCompare(a.lastModifiedDateTime ?? ''));
      const value = sorted.slice(skip, skip + top).map((p) => ({
        id: p.id,
        title: p.title,
        createdDateTime: p.createdDateTime,
        lastModifiedDateTime: p.lastModifiedDateTime,
        ...(level ? { level: p.level ?? 0, order: p.order ?? s.pages.indexOf(p) } : {}),
      }));
      const next = new URL(url.toString());
      next.searchParams.set('$skip', String(skip + top));
      return this.json({ value, ...(skip + top < sorted.length ? { '@odata.nextLink': next.toString() } : {}) });
    }
    if ((m = /^\/me\/onenote\/pages\/([^/]+)\/content$/.exec(path))) {
      const page = this.allSections()
        .flatMap((x) => x.s.pages)
        .find((p) => p.id === m![1]);
      if (!page) return this.json({ error: { code: '20102', message: 'not found' } }, 404);
      const wantInk = url.searchParams.get('includeInkML') === 'true';
      const inkAvailable = page.inkml && wantInk && !(this.inkOnlyInBeta && version === 'v1.0');
      if (!inkAvailable) {
        const html = page.inkml ? page.html.replace('</body>', '<!-- InkNode is not supported --></body>') : page.html;
        return this.res(200, html, { 'content-type': 'text/html' });
      }
      const boundary = `onenote-${++this.counter}`;
      const body =
        `--${boundary}\r\nContent-Type: text/html\r\n\r\n${page.html.replace('</body>', '<!-- InkNode is not supported --></body>')}\r\n` +
        `--${boundary}\r\nContent-Type: application/inkml+xml\r\n\r\n${page.inkml}\r\n--${boundary}--\r\n`;
      return this.res(200, body, { 'content-type': `multipart/related; boundary=${boundary}` });
    }
    if ((m = /^\/me\/onenote\/resources\/([^/]+)\/\$value$/.exec(path))) {
      const r = this.resources.get(m[1]);
      if (!r) return this.json({ error: { code: '20102', message: 'not found' } }, 404);
      return this.res(200, r.data, { 'content-type': r.mime });
    }
    return this.json({ error: { code: 'BadRequest', message: `unsupported: ${path}` } }, 400);
  }
}
