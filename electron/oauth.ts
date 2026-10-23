/**
 * OAuth sign-in in the system browser with a loopback redirect (RFC 8252), e.g. Microsoft for the
 * OneNote import: a short-lived server on 127.0.0.1/::1 receives the redirect with the code.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OAuthResult {
  redirectUri: string;
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

const page = (ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>NextNote</title><body style="font-family:'Segoe UI',sans-serif;display:grid;place-items:center;height:90vh;color:#242226">` +
  `<div style="text-align:center"><h2>${ok ? 'Anmeldung abgeschlossen' : 'Anmeldung fehlgeschlagen'}</h2>` +
  `<p>${ok ? 'Du kannst dieses Fenster schließen und zu NextNote zurückkehren.' : 'Bitte schließe dieses Fenster und sieh dir die Meldung in NextNote an.'}</p></div>`;

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

/**
 * Opens `authorizeUrl` plus redirect_uri=http://localhost:<port> via `open` and resolves with the
 * parameters of the redirect. `cancel()` resolves it with error 'cancelled'.
 */
export function authorizeViaLoopback(
  authorizeUrl: string,
  opts: { open(url: string): Promise<void>; onRedirect?(): void; timeoutMs?: number },
): { result: Promise<OAuthResult>; cancel(): void } {
  let cancel = () => {};
  const result = new Promise<OAuthResult>((resolve) => {
    if (!/^https:\/\//i.test(authorizeUrl)) {
      resolve({ redirectUri: '', error: 'invalid_request', errorDescription: 'Ungültige Adresse' });
      return;
    }
    const servers: http.Server[] = [];
    let redirectUri = '';
    let done = false;
    const finish = (r: Omit<OAuthResult, 'redirectUri'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of servers) {
        s.close();
        setTimeout(() => s.closeAllConnections(), 2000).unref();
      }
      resolve({ redirectUri, ...r });
    };
    cancel = () => finish({ error: 'cancelled' });
    const timer = setTimeout(() => finish({ error: 'timeout' }), opts.timeoutMs ?? 15 * 60 * 1000);
    const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (url.pathname !== '/' || (!code && !error) || done) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(!!code));
      opts.onRedirect?.();
      finish({
        code: code ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
        error: error ?? undefined,
        errorDescription: url.searchParams.get('error_description') ?? undefined,
      });
    };
    void (async () => {
      try {
        const v4 = http.createServer(onRequest);
        servers.push(v4);
        const port = await listen(v4, 0, '127.0.0.1');
        // browsers may resolve "localhost" to ::1 first
        const v6 = http.createServer(onRequest);
        await listen(v6, port, '::1').then(
          () => servers.push(v6),
          () => undefined,
        );
        if (done) {
          for (const s of servers) s.close();
          return;
        }
        redirectUri = `http://localhost:${port}`;
        const url = new URL(authorizeUrl);
        url.searchParams.set('redirect_uri', redirectUri);
        await opts.open(url.toString());
      } catch (err) {
        finish({ error: 'server_error', errorDescription: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
  return { result, cancel: () => cancel() };
}
