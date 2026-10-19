import { NetworkError, type HttpFn } from '../platform/types';
import { bytesToBase64, decodeUtf8, encodeUtf8 } from '../model/util';

export interface NextcloudAccount {
  server: string;
  loginName: string;
  appPassword: string;
  userId: string;
  displayName: string;
}

export function basicAuth(user: string, password: string): string {
  return 'Basic ' + bytesToBase64(encodeUtf8(`${user}:${password}`));
}

export function davBaseUrl(account: Pick<NextcloudAccount, 'server' | 'userId'>): string {
  return `${account.server}/remote.php/dav/files/${encodeURIComponent(account.userId)}`;
}

/** Turns user input like "cloud.example.com/" into "https://cloud.example.com". */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error('Bitte die Adresse deiner Nextcloud eingeben.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const url = new URL(s);
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(index\.php)(\/.*)?$/, '').replace(/\/(apps|login|remote\.php|ocs)(\/.*)?$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(body));
  } catch {
    return null;
  }
}

export async function checkServer(http: HttpFn, server: string): Promise<{ version: string; productName: string }> {
  let res;
  try {
    res = await http({ method: 'GET', url: `${server}/status.php`, headers: { Accept: 'application/json' }, timeoutMs: 15000 });
  } catch (e) {
    throw new NetworkError(`Server nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = parseJson(res.body) as { installed?: boolean; version?: string; versionstring?: string; productname?: string } | null;
  if (res.status !== 200 || !json || json.installed === undefined) {
    throw new Error('Unter dieser Adresse wurde keine Nextcloud gefunden.');
  }
  if (!json.installed) throw new Error('Diese Nextcloud ist noch nicht fertig eingerichtet.');
  return { version: json.versionstring ?? json.version ?? '?', productName: json.productname ?? 'Nextcloud' };
}

export interface LoginFlow {
  loginUrl: string;
  token: string;
  endpoint: string;
}

/** Nextcloud Login Flow v2: https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/ */
export async function startLoginFlow(http: HttpFn, server: string, userAgent: string): Promise<LoginFlow> {
  const res = await http({
    method: 'POST',
    url: `${server}/index.php/login/v2`,
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    timeoutMs: 20000,
  });
  const json = parseJson(res.body) as { poll?: { token?: string; endpoint?: string }; login?: string } | null;
  if (res.status !== 200 || !json?.poll?.token || !json.poll.endpoint || !json.login) {
    throw new Error(`Anmeldung konnte nicht gestartet werden (HTTP ${res.status}).`);
  }
  return { loginUrl: json.login, token: json.poll.token, endpoint: json.poll.endpoint };
}

/** Returns credentials once the user granted access in the browser, otherwise null. */
export async function pollLoginFlow(
  http: HttpFn,
  flow: LoginFlow,
  userAgent: string,
): Promise<{ server: string; loginName: string; appPassword: string } | null> {
  const res = await http({
    method: 'POST',
    url: flow.endpoint,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent, Accept: 'application/json' },
    body: `token=${encodeURIComponent(flow.token)}`,
    timeoutMs: 20000,
  });
  if (res.status === 404) return null;
  const json = parseJson(res.body) as { server?: string; loginName?: string; appPassword?: string } | null;
  if (res.status !== 200 || !json?.loginName || !json.appPassword) {
    throw new Error(`Anmeldung fehlgeschlagen (HTTP ${res.status}).`);
  }
  return { server: (json.server ?? '').replace(/\/+$/, ''), loginName: json.loginName, appPassword: json.appPassword };
}

/** Resolves the user id (needed for the WebDAV path) and display name. */
export async function fetchUser(
  http: HttpFn,
  server: string,
  loginName: string,
  password: string,
  userAgent: string,
): Promise<{ userId: string; displayName: string }> {
  const res = await http({
    method: 'GET',
    url: `${server}/ocs/v2.php/cloud/user?format=json`,
    headers: {
      Authorization: basicAuth(loginName, password),
      'OCS-APIRequest': 'true',
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
    timeoutMs: 20000,
  });
  if (res.status === 401) throw new Error('Benutzername oder App-Passwort ist falsch.');
  const json = parseJson(res.body) as { ocs?: { data?: { id?: string; 'display-name'?: string; displayname?: string } } } | null;
  const data = json?.ocs?.data;
  if (res.status !== 200 || !data?.id) throw new Error(`Benutzerinformationen konnten nicht geladen werden (HTTP ${res.status}).`);
  return { userId: data.id, displayName: data['display-name'] ?? data.displayname ?? data.id };
}

/** Revokes the app password on the server (logout). Errors are ignored. */
export async function revokeAppPassword(http: HttpFn, account: NextcloudAccount, userAgent: string): Promise<void> {
  try {
    await http({
      method: 'DELETE',
      url: `${account.server}/ocs/v2.php/core/apppassword`,
      headers: { Authorization: basicAuth(account.loginName, account.appPassword), 'OCS-APIRequest': 'true', 'User-Agent': userAgent },
      timeoutMs: 10000,
    });
  } catch {
    // ignore – logging out locally must always work
  }
}
