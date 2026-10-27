/**
 * In-memory emulation of the parts of Nextcloud that NextNote uses:
 * status.php, Login Flow v2, OCS user info and WebDAV (PROPFIND/GET/PUT/DELETE/MKCOL/MOVE)
 * including ETag propagation to parent folders and If-Match / If-None-Match handling.
 * Used by the automated tests and by tools/mock-nextcloud-server.ts for manual testing.
 */
import type { HttpRequest, HttpResponse } from '../src/platform/types';

interface FileNode {
  data: Uint8Array;
  etag: string;
  mtime: number;
  mime: string;
  /** Nextcloud file id: kept when the file is overwritten or moved. */
  id?: number;
}

interface DirNode {
  etag: string;
  mtime: number;
  id?: number;
}

interface Flow {
  token: string;
  loginToken: string;
  granted: boolean;
  userAgent: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface MockOptions {
  baseUrl: string;
  users?: Record<string, { password: string; displayName?: string }>;
}

export class MockNextcloud {
  baseUrl: string;
  users: Record<string, { password: string; displayName?: string }>;
  files = new Map<string, Map<string, FileNode>>();
  dirs = new Map<string, Map<string, DirNode>>();
  flows = new Map<string, Flow>();
  appPasswords = new Map<string, { user: string; name: string }>();
  requestLog: Array<{ method: string; path: string; status: number }> = [];
  private counter = 0;

  constructor(opts: MockOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.users = opts.users ?? { alice: { password: 'secret', displayName: 'Alice' } };
    for (const u of Object.keys(this.users)) {
      this.files.set(u, new Map());
      this.dirs.set(u, new Map([['', { etag: this.newEtag(), mtime: Date.now() }]]));
    }
  }

  private nextFileId = 100;

  private newEtag(): string {
    this.counter++;
    return `${Date.now().toString(16)}${this.counter.toString(16).padStart(6, '0')}`;
  }

  private touch(user: string, path: string) {
    const dirs = this.dirs.get(user)!;
    const segs = path.split('/').filter(Boolean);
    for (let i = segs.length - 1; i >= 0; i--) {
      const p = segs.slice(0, i).join('/');
      const d = dirs.get(p);
      if (d) {
        d.etag = this.newEtag();
        d.mtime = Date.now();
      }
    }
  }

  private res(status: number, body: string | Uint8Array = '', headers: Record<string, string> = {}): HttpResponse {
    return { status, headers, body: typeof body === 'string' ? enc.encode(body) : body };
  }

  private json(status: number, value: unknown) {
    return this.res(status, JSON.stringify(value), { 'content-type': 'application/json' });
  }

  private authUser(req: HttpRequest): string | null {
    const h = Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    if (!h || !h.startsWith('Basic ')) return null;
    const [user, ...rest] = atob(h.slice(6)).split(':');
    const pw = rest.join(':');
    if (this.users[user]?.password === pw) return user;
    const app = this.appPasswords.get(pw);
    if (app && app.user === user) return user;
    return null;
  }

  private header(req: HttpRequest, name: string): string | undefined {
    return Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  }

  /** Grants a pending login flow, as if the user clicked "Zugriff gewähren". */
  grant(loginToken: string, user = Object.keys(this.users)[0]): boolean {
    for (const f of this.flows.values()) {
      if (f.loginToken === loginToken) {
        f.granted = true;
        (f as Flow & { user?: string }).user = user;
        return true;
      }
    }
    return false;
  }

  async handle(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const res = await this.route(req, url);
    this.requestLog.push({ method: req.method, path: decodeURIComponent(url.pathname), status: res.status });
    return res;
  }

  private bodyText(req: HttpRequest): string {
    if (req.body === undefined) return '';
    return typeof req.body === 'string' ? req.body : dec.decode(req.body);
  }

  private async route(req: HttpRequest, url: URL): Promise<HttpResponse> {
    const p = url.pathname;
    // like Nextcloud, generate links for the host the client used
    const base = url.origin;
    if (p === '/status.php') {
      return this.json(200, { installed: true, maintenance: false, needsDbUpgrade: false, version: '31.0.0.0', versionstring: '31.0.0', edition: '', productname: 'Nextcloud' });
    }
    if (p === '/index.php/login/v2' && req.method === 'POST') {
      const token = this.newEtag() + 'poll';
      const loginToken = this.newEtag() + 'login';
      this.flows.set(token, { token, loginToken, granted: false, userAgent: this.header(req, 'user-agent') ?? '' });
      return this.json(200, {
        poll: { token, endpoint: `${base}/index.php/login/v2/poll` },
        login: `${base}/index.php/login/v2/flow/${loginToken}`,
      });
    }
    if (p.startsWith('/index.php/login/v2/flow/')) {
      const loginToken = p.split('/').at(-1)!;
      const flow = [...this.flows.values()].find((f) => f.loginToken === loginToken);
      if (!flow) return this.res(404, 'Unbekannter Anmeldelink');
      const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Mock-Nextcloud Anmeldung</title>
<meta name="viewport" content="width=device-width"><style>body{font-family:sans-serif;background:#0082c9;color:#fff;display:grid;place-items:center;min-height:90vh}
form{background:#fff;color:#222;padding:24px;border-radius:12px;max-width:360px}button{background:#0082c9;color:#fff;border:0;padding:10px 18px;border-radius:20px;font-size:16px}</style></head>
<body><form method="post" action="/index.php/login/v2/grant"><h2>Mit deinem Konto verbinden</h2><p><b>${flow.userAgent || 'Ein Gerät'}</b> möchte auf dein Konto zugreifen.</p>
<input type="hidden" name="token" value="${loginToken}"><p>Benutzer: <select name="user">${Object.keys(this.users).map((u) => `<option>${u}</option>`).join('')}</select></p>
<button type="submit" id="grant">Zugriff gewähren</button></form></body></html>`;
      return this.res(200, html, { 'content-type': 'text/html; charset=utf-8' });
    }
    if (p === '/index.php/login/v2/grant' && req.method === 'POST') {
      const params = new URLSearchParams(this.bodyText(req));
      const ok = this.grant(params.get('token') ?? '', params.get('user') ?? undefined);
      return this.res(ok ? 200 : 404, `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif"><h2>${ok ? 'Konto verbunden. Du kannst dieses Fenster schließen.' : 'Ungültiger Link'}</h2></body>`, {
        'content-type': 'text/html; charset=utf-8',
      });
    }
    if (p === '/index.php/login/v2/poll' && req.method === 'POST') {
      const token = new URLSearchParams(this.bodyText(req)).get('token') ?? '';
      const flow = this.flows.get(token);
      if (!flow || !flow.granted) return this.res(404, '[]');
      this.flows.delete(token);
      const user = (flow as Flow & { user?: string }).user ?? Object.keys(this.users)[0];
      const appPassword = 'app-' + this.newEtag() + this.newEtag();
      this.appPasswords.set(appPassword, { user, name: flow.userAgent });
      return this.json(200, { server: base, loginName: user, appPassword });
    }
    if (p === '/ocs/v2.php/cloud/user' || p === '/ocs/v1.php/cloud/user') {
      const user = this.authUser(req);
      if (!user) return this.json(401, { ocs: { meta: { status: 'failure', statuscode: 997, message: 'Current user is not logged in' }, data: [] } });
      return this.json(200, { ocs: { meta: { status: 'ok', statuscode: 200, message: 'OK' }, data: { id: user, 'display-name': this.users[user].displayName ?? user } } });
    }
    if (p === '/ocs/v2.php/core/apppassword' && req.method === 'DELETE') {
      const h = this.header(req, 'authorization');
      if (h?.startsWith('Basic ')) this.appPasswords.delete(atob(h.slice(6)).split(':').slice(1).join(':'));
      return this.json(200, { ocs: { meta: { status: 'ok', statuscode: 200 }, data: [] } });
    }
    const m = /^\/remote\.php\/dav\/files\/([^/]+)(\/.*)?$/.exec(p);
    if (m) {
      const user = this.authUser(req);
      if (!user) return this.res(401, '<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:message>No public access</s:message></d:error>', { 'www-authenticate': 'Basic realm="Nextcloud"' });
      const owner = decodeURIComponent(m[1]);
      if (owner !== user) return this.res(403, 'forbidden');
      const path = (m[2] ?? '/')
        .split('/')
        .filter(Boolean)
        .map((s) => decodeURIComponent(s))
        .join('/');
      return this.dav(req, user, path);
    }
    return this.res(404, 'not found');
  }

  private parentExists(user: string, path: string): boolean {
    const parent = path.split('/').slice(0, -1).join('/');
    return this.dirs.get(user)!.has(parent);
  }

  private hrefFor(user: string, path: string, isDir: boolean): string {
    const segs = path.split('/').filter(Boolean).map(encodeURIComponent);
    return `/remote.php/dav/files/${encodeURIComponent(user)}/${segs.join('/')}${isDir && segs.length ? '/' : ''}`;
  }

  private propXml(user: string, path: string, node: FileNode | DirNode, isDir: boolean): string {
    const lm = new Date(node.mtime).toUTCString();
    node.id ??= this.nextFileId++;
    const props = isDir
      ? `<d:getetag>&quot;${node.etag}&quot;</d:getetag><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>${lm}</d:getlastmodified><oc:fileid>${node.id}</oc:fileid>`
      : `<d:getetag>&quot;${node.etag}&quot;</d:getetag><d:resourcetype/><d:getlastmodified>${lm}</d:getlastmodified><d:getcontentlength>${(node as FileNode).data.byteLength}</d:getcontentlength><oc:fileid>${node.id}</oc:fileid>`;
    const missing = isDir ? '<d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>' : '';
    return `<d:response><d:href>${this.hrefFor(user, path, isDir)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${missing}</d:response>`;
  }

  private dav(req: HttpRequest, user: string, path: string): HttpResponse {
    const files = this.files.get(user)!;
    const dirs = this.dirs.get(user)!;
    const method = req.method.toUpperCase();
    const file = files.get(path);
    const dir = dirs.get(path);
    switch (method) {
      case 'PROPFIND': {
        if (!file && !dir) return this.res(404, '<?xml version="1.0"?><d:error xmlns:d="DAV:"/>');
        const depth = this.header(req, 'depth') ?? '1';
        let xml = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">';
        if (file) xml += this.propXml(user, path, file, false);
        else if (dir) {
          xml += this.propXml(user, path, dir, true);
          if (depth !== '0') {
            const prefix = path ? path + '/' : '';
            for (const [dp, d] of dirs) {
              if (dp !== path && dp.startsWith(prefix) && !dp.slice(prefix.length).includes('/')) xml += this.propXml(user, dp, d, true);
            }
            for (const [fp, f] of files) {
              if (fp.startsWith(prefix) && !fp.slice(prefix.length).includes('/')) xml += this.propXml(user, fp, f, false);
            }
          }
        }
        xml += '</d:multistatus>';
        return this.res(207, xml, { 'content-type': 'application/xml; charset=utf-8' });
      }
      case 'GET': {
        if (!file) return this.res(404, 'not found');
        return this.res(200, file.data, { etag: `"${file.etag}"`, 'content-type': file.mime });
      }
      case 'PUT': {
        if (dir) return this.res(409, 'is a directory');
        if (!this.parentExists(user, path)) return this.res(409, 'parent missing');
        const ifMatch = this.header(req, 'if-match');
        const ifNoneMatch = this.header(req, 'if-none-match');
        if (ifMatch) {
          const want = ifMatch.replace(/"/g, '');
          if (!file || (want !== '*' && want !== file.etag)) return this.res(412, 'precondition failed');
        }
        if (ifNoneMatch === '*' && file) return this.res(412, 'precondition failed');
        const data = req.body === undefined ? new Uint8Array() : typeof req.body === 'string' ? enc.encode(req.body) : new Uint8Array(req.body);
        const node: FileNode = {
          data,
          etag: this.newEtag(),
          mtime: Date.now(),
          mime: this.header(req, 'content-type') ?? 'application/octet-stream',
          id: file?.id ?? this.nextFileId++,
        };
        files.set(path, node);
        this.touch(user, path);
        return this.res(file ? 204 : 201, '', { etag: `"${node.etag}"`, 'oc-etag': `"${node.etag}"` });
      }
      case 'DELETE': {
        if (file) {
          files.delete(path);
          this.touch(user, path);
          return this.res(204);
        }
        if (dir && path) {
          const prefix = path + '/';
          for (const k of [...files.keys()]) if (k.startsWith(prefix)) files.delete(k);
          for (const k of [...dirs.keys()]) if (k === path || k.startsWith(prefix)) dirs.delete(k);
          this.touch(user, path);
          return this.res(204);
        }
        return this.res(404, 'not found');
      }
      case 'MKCOL': {
        if (file || dir) return this.res(405, 'exists');
        if (!this.parentExists(user, path)) return this.res(409, 'parent missing');
        dirs.set(path, { etag: this.newEtag(), mtime: Date.now() });
        this.touch(user, path);
        return this.res(201);
      }
      case 'MOVE': {
        const destHeader = this.header(req, 'destination');
        if (!destHeader) return this.res(400, 'no destination');
        const dm = /\/remote\.php\/dav\/files\/[^/]+(\/.*)?$/.exec(new URL(destHeader).pathname);
        const dest = (dm?.[1] ?? '/').split('/').filter(Boolean).map((s) => decodeURIComponent(s)).join('/');
        if (!file && !dir) return this.res(404, 'not found');
        const exists = files.has(dest) || dirs.has(dest);
        if (exists && (this.header(req, 'overwrite') ?? 'T') === 'F') return this.res(412, 'exists');
        if (!this.parentExists(user, dest)) return this.res(409, 'parent missing');
        if (file) {
          files.delete(path);
          files.set(dest, { ...file, etag: this.newEtag() });
        } else {
          const prefix = path + '/';
          for (const [k, v] of [...files]) if (k.startsWith(prefix)) {
            files.delete(k);
            files.set(dest + '/' + k.slice(prefix.length), v);
          }
          for (const [k, v] of [...dirs]) if (k === path || k.startsWith(prefix)) {
            dirs.delete(k);
            dirs.set(k === path ? dest : dest + '/' + k.slice(prefix.length), { ...v, etag: this.newEtag() });
          }
        }
        this.touch(user, path);
        this.touch(user, dest);
        return this.res(exists ? 204 : 201);
      }
      default:
        return this.res(405, 'method not allowed');
    }
  }

  /** Test helper: list all file paths of a user. */
  listFiles(user = Object.keys(this.users)[0]): string[] {
    return [...this.files.get(user)!.keys()].sort();
  }

  readFile(path: string, user = Object.keys(this.users)[0]): string | null {
    const f = this.files.get(user)!.get(path);
    return f ? dec.decode(f.data) : null;
  }

  readBytes(path: string, user = Object.keys(this.users)[0]): Uint8Array | null {
    return this.files.get(user)!.get(path)?.data ?? null;
  }

  /** Test helper: creates or replaces a file (and missing parent folders) as if uploaded through the web interface. */
  writeFile(path: string, data: Uint8Array | string, user = Object.keys(this.users)[0]) {
    const dirs = this.dirs.get(user)!;
    const segs = path.split('/').filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const p = segs.slice(0, i).join('/');
      if (!dirs.has(p)) dirs.set(p, { etag: this.newEtag(), mtime: Date.now() });
    }
    const files = this.files.get(user)!;
    const prev = files.get(path);
    files.set(path, {
      data: typeof data === 'string' ? enc.encode(data) : data,
      etag: this.newEtag(),
      mtime: Date.now(),
      mime: 'application/octet-stream',
      id: prev?.id ?? this.nextFileId++,
    });
    this.touch(user, path);
  }

  /** Test helper: renames or moves a file, keeping its file id. */
  moveFile(from: string, to: string, user = Object.keys(this.users)[0]) {
    const files = this.files.get(user)!;
    const f = files.get(from);
    if (!f) throw new Error(`no such file: ${from}`);
    files.delete(from);
    files.set(to, { ...f, etag: this.newEtag() });
    this.touch(user, from);
    this.touch(user, to);
  }
}
