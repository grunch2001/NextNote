/**
 * Local Nextcloud emulation for manual testing in the browser:
 *   npm run mock-nextcloud      -> http://127.0.0.1:8090 (user "alice", password "secret")
 */
import { createServer } from 'node:http';
import { MockNextcloud } from './mockNextcloud.ts';

const port = Number(process.env.PORT ?? 8090);
const base = `http://127.0.0.1:${port}`;
const nc = new MockNextcloud({ baseUrl: base, users: { alice: { password: 'secret', displayName: 'Alice Test' } } });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, Depth, Destination, Overwrite, If-Match, If-None-Match, OCS-APIRequest, Accept',
  'access-control-expose-headers': 'ETag, OC-ETag',
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  const out = await nc.handle({ method: req.method ?? 'GET', url: `http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url ?? '/'}`, headers, body: body.length ? new Uint8Array(body) : undefined });
  res.writeHead(out.status, { ...CORS, ...out.headers });
  res.end(Buffer.from(out.body));
  if (process.env.VERBOSE) console.log(req.method, req.url, out.status);
}).listen(port, '127.0.0.1', () => console.log(`Mock-Nextcloud läuft auf ${base} (alice / secret)`));
