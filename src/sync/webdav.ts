import { NetworkError, type HttpFn, type HttpResponse } from '../platform/types';
import { decodeUtf8 } from '../model/util';

export class DavError extends Error {
  constructor(
    public status: number,
    message: string,
    public responseText = '',
  ) {
    super(message);
    this.name = 'DavError';
  }
}

export interface DavEntry {
  /** Path relative to the client's base, without leading or trailing slash. */
  path: string;
  name: string;
  isDir: boolean;
  etag: string | null;
  size: number;
  lastModified: number;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
  '<d:prop><d:getetag/><d:resourcetype/><d:getlastmodified/><d:getcontentlength/><oc:fileid/></d:prop>' +
  '</d:propfind>';

export function normalizeEtag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '').replace(/&quot;/g, '') || null;
}

export function joinPath(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split('/'))
    .filter((p) => p.length > 0)
    .join('/');
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Minimal WebDAV client tailored to Nextcloud. */
export class WebDavClient {
  private basePathSegments: string[];

  constructor(
    private http: HttpFn,
    /** e.g. https://cloud.example.com/remote.php/dav/files/alice */
    public readonly baseUrl: string,
    private authHeader: string,
    private userAgent = 'NextNote',
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.basePathSegments = new URL(this.baseUrl).pathname.split('/').filter(Boolean).map(safeDecode);
  }

  url(path: string): string {
    const enc = encodePath(path);
    return enc ? `${this.baseUrl}/${enc}` : `${this.baseUrl}/`;
  }

  private async request(
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: Uint8Array | string; dirSlash?: boolean; timeoutMs?: number } = {},
  ): Promise<HttpResponse> {
    let url = this.url(path);
    if (opts.dirSlash && !url.endsWith('/')) url += '/';
    let res: HttpResponse;
    try {
      res = await this.http({
        method,
        url,
        headers: {
          Authorization: this.authHeader,
          'User-Agent': this.userAgent,
          'OCS-APIRequest': 'true',
          ...opts.headers,
        },
        body: opts.body,
        timeoutMs: opts.timeoutMs ?? 60000,
      });
    } catch (e) {
      if (e instanceof NetworkError) throw e;
      throw new NetworkError(e instanceof Error ? e.message : String(e));
    }
    return res;
  }

  private fail(res: HttpResponse, what: string): never {
    const text = decodeUtf8(res.body).slice(0, 500);
    let message = `${what}: HTTP ${res.status}`;
    if (res.status === 401) message = 'Anmeldung fehlgeschlagen (401). Bitte erneut mit Nextcloud verbinden.';
    else if (res.status === 403) message = `${what}: Zugriff verweigert (403)`;
    else if (res.status === 507) message = 'Nextcloud-Speicherplatz ist voll (507).';
    else if (res.status === 423) message = `${what}: Datei ist gesperrt (423), später erneut versuchen.`;
    else {
      const m = /<s:message>([^<]*)<\/s:message>/.exec(text);
      if (m) message += ` – ${m[1]}`;
    }
    throw new DavError(res.status, message, text);
  }

  /** PROPFIND. Returns null if the resource does not exist. The first entry is the resource itself. */
  async propfind(path: string, depth: 0 | 1 = 1): Promise<DavEntry[] | null> {
    const res = await this.request('PROPFIND', path, {
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      dirSlash: false,
    });
    if (res.status === 404) return null;
    if (res.status !== 207) this.fail(res, `Ordner lesen (${path || '/'})`);
    return this.parseMultistatus(decodeUtf8(res.body));
  }

  parseMultistatus(xml: string): DavEntry[] {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const responses = Array.from(doc.getElementsByTagNameNS('DAV:', 'response'));
    const out: DavEntry[] = [];
    for (const r of responses) {
      const hrefEl = r.getElementsByTagNameNS('DAV:', 'href')[0];
      if (!hrefEl?.textContent) continue;
      let href = hrefEl.textContent.trim();
      if (/^https?:\/\//i.test(href)) href = new URL(href).pathname;
      const segs = href.split('/').filter(Boolean).map(safeDecode);
      let rel: string[];
      if (this.basePathSegments.every((s, i) => segs[i] === s)) rel = segs.slice(this.basePathSegments.length);
      else continue;
      // only consider propstat blocks with status 200
      let etag: string | null = null;
      let isDir = false;
      let size = 0;
      let lastModified = 0;
      for (const ps of Array.from(r.getElementsByTagNameNS('DAV:', 'propstat'))) {
        const status = ps.getElementsByTagNameNS('DAV:', 'status')[0]?.textContent ?? '';
        if (!/\b200\b/.test(status)) continue;
        const e = ps.getElementsByTagNameNS('DAV:', 'getetag')[0];
        if (e?.textContent) etag = normalizeEtag(e.textContent);
        const rt = ps.getElementsByTagNameNS('DAV:', 'resourcetype')[0];
        if (rt && rt.getElementsByTagNameNS('DAV:', 'collection').length > 0) isDir = true;
        const len = ps.getElementsByTagNameNS('DAV:', 'getcontentlength')[0];
        if (len?.textContent) size = Number(len.textContent) || 0;
        const lm = ps.getElementsByTagNameNS('DAV:', 'getlastmodified')[0];
        if (lm?.textContent) lastModified = Date.parse(lm.textContent) || 0;
      }
      const path = rel.join('/');
      out.push({ path, name: rel.at(-1) ?? '', isDir, etag, size, lastModified });
    }
    return out;
  }

  /** Lists the direct children of a folder. Returns null if the folder does not exist. */
  async list(path: string): Promise<{ self: DavEntry; children: DavEntry[] } | null> {
    const entries = await this.propfind(path, 1);
    if (!entries) return null;
    const norm = joinPath(path);
    const self = entries.find((e) => e.path === norm) ?? { path: norm, name: norm.split('/').at(-1) ?? '', isDir: true, etag: null, size: 0, lastModified: 0 };
    const children = entries.filter((e) => e.path !== norm);
    return { self, children };
  }

  async get(path: string): Promise<{ data: Uint8Array; etag: string | null } | null> {
    const res = await this.request('GET', path, { timeoutMs: 120000 });
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail(res, `Datei laden (${path})`);
    return { data: res.body, etag: normalizeEtag(res.headers['oc-etag'] ?? res.headers['etag']) };
  }

  /**
   * Upload a file. ifMatch: only overwrite if the remote ETag matches.
   * ifNoneMatch: only create, never overwrite. Returns the new ETag, or 'precondition' if the condition failed.
   */
  async put(
    path: string,
    data: Uint8Array | string,
    opts: { contentType?: string; ifMatch?: string | null; ifNoneMatch?: boolean } = {},
  ): Promise<{ etag: string | null } | 'precondition'> {
    const headers: Record<string, string> = { 'Content-Type': opts.contentType ?? 'application/octet-stream' };
    if (opts.ifMatch) headers['If-Match'] = `"${opts.ifMatch}"`;
    if (opts.ifNoneMatch) headers['If-None-Match'] = '*';
    const res = await this.request('PUT', path, { headers, body: data, timeoutMs: 180000 });
    if (res.status === 412) return 'precondition';
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) this.fail(res, `Datei speichern (${path})`);
    let etag = normalizeEtag(res.headers['oc-etag'] ?? res.headers['etag']);
    if (!etag) {
      const info = await this.propfind(path, 0);
      etag = info?.[0]?.etag ?? null;
    }
    return { etag };
  }

  async delete(path: string): Promise<void> {
    const res = await this.request('DELETE', path);
    if (res.status === 404 || res.status === 204 || res.status === 200) return;
    this.fail(res, `Löschen (${path})`);
  }

  /** Creates a folder. Returns false if it already existed. */
  async mkcol(path: string): Promise<boolean> {
    const res = await this.request('MKCOL', path, { dirSlash: false });
    if (res.status === 201) return true;
    if (res.status === 405) return false; // already exists
    this.fail(res, `Ordner erstellen (${path})`);
  }

  /** Creates every missing folder along the path. */
  async ensureDir(path: string): Promise<void> {
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 0) return;
    const existing = await this.propfind(segs.join('/'), 0);
    if (existing) return;
    let cur = '';
    for (const s of segs) {
      cur = cur ? `${cur}/${s}` : s;
      const e = await this.propfind(cur, 0);
      if (!e) await this.mkcol(cur);
    }
  }

  /** Returns false if the destination already exists. */
  async move(from: string, to: string): Promise<boolean> {
    const res = await this.request('MOVE', from, { headers: { Destination: this.url(to), Overwrite: 'F' } });
    if (res.status === 201 || res.status === 204) return true;
    if (res.status === 412) return false;
    this.fail(res, `Verschieben (${from} → ${to})`);
  }
}
