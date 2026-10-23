/**
 * Microsoft sign-in for the OneNote import: OAuth 2.0 authorization code flow with PKCE for a public
 * client (no secret). The browser part runs via platform.oauthAuthorize (loopback redirect),
 * the token requests go through the platform HTTP function (no CORS / Origin header).
 */
import type { HttpFn, OAuthResult } from '../../platform/types';
import { base64ToBytes, bytesToBase64, decodeUtf8, encodeUtf8 } from '../../model/util';

export const MS_LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPES = 'openid profile offline_access Notes.Read';

export class MsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MsAuthError';
  }
}

/** The user cancelled (sign-in or import). */
export class CancelledError extends Error {
  constructor() {
    super('Abgebrochen');
    this.name = 'CancelledError';
  }
}

export interface TokenSource {
  token(): Promise<string>;
  refresh(): Promise<void>;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  idToken?: string;
}

const base64Url = (bytes: Uint8Array) => bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomString(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return base64Url(b);
}

/** Readable German message for the error codes a misconfigured app registration produces. */
export function explainAuthError(code?: string, description?: string): string {
  const d = description ?? '';
  const all = `${code ?? ''} ${d}`;
  if (code === 'timeout') return 'Die Anmeldung wurde nicht rechtzeitig abgeschlossen.';
  if (code === 'access_denied' || /AADSTS65004/.test(d)) return 'Der Zugriff wurde im Browser nicht erlaubt.';
  if (/AADSTS700016/.test(d)) return 'Microsoft kennt diese Anwendungs-ID (Client-ID) nicht. Bitte prüfe die ID aus der App-Registrierung.';
  if (/AADSTS50011/.test(d))
    return 'Die Umleitungs-URI passt nicht. Trage in der App-Registrierung unter „Authentifizierung“ → „Mobile Anwendungen und Desktopanwendungen“ die URI http://localhost ein.';
  if (/AADSTS7000218|AADSTS700025|client_secret|client_assertion/.test(d))
    return 'Die App-Registrierung ist nicht als öffentlicher Client eingerichtet. Lege die Plattform „Mobile Anwendungen und Desktopanwendungen“ an und schalte „Öffentliche Clientflows zulassen“ ein.';
  if (/AADSTS50020|AADSTS50194|unauthorized_client|not enabled for consumers/.test(all))
    return 'Die App-Registrierung erlaubt diesen Kontotyp nicht. Wähle bei „Unterstützte Kontotypen“ die Option mit „persönlichen Microsoft-Konten“ – oder prüfe die Anwendungs-ID.';
  const first = d.split(/\r?\n/)[0];
  return `Anmeldung bei Microsoft fehlgeschlagen${code ? ` (${code})` : ''}${first ? `: ${first}` : ''}`;
}

async function requestToken(http: HttpFn, loginBase: string, params: Record<string, string>): Promise<TokenSet> {
  const res = await http({
    method: 'POST',
    url: `${loginBase}/token`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    timeoutMs: 30000,
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(decodeUtf8(res.body)) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  if (res.status !== 200 || typeof json.access_token !== 'string') {
    throw new MsAuthError(explainAuthError(String(json.error ?? `HTTP ${res.status}`), typeof json.error_description === 'string' ? json.error_description : undefined));
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    idToken: typeof json.id_token === 'string' ? json.id_token : undefined,
  };
}

/** Display name or e-mail address from the ID token (not verified – only shown to the user). */
function accountName(idToken: string | undefined): string {
  try {
    const payload = idToken?.split('.')[1];
    if (!payload) return '';
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(decodeUtf8(base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))) as Record<string, string>;
    return claims.name || claims.preferred_username || claims.email || '';
  } catch {
    return '';
  }
}

export class MsSession implements TokenSource {
  constructor(
    private http: HttpFn,
    private clientId: string,
    private tokens: TokenSet,
    public account: string,
    private loginBase = MS_LOGIN,
  ) {}

  async token(): Promise<string> {
    if (Date.now() > this.tokens.expiresAt - 120_000) await this.refresh();
    return this.tokens.accessToken;
  }

  async refresh(): Promise<void> {
    if (!this.tokens.refreshToken) throw new MsAuthError('Die Anmeldung bei Microsoft ist abgelaufen. Bitte melde dich erneut an.');
    const next = await requestToken(this.http, this.loginBase, {
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
      scope: SCOPES,
    });
    this.tokens = { ...next, refreshToken: next.refreshToken ?? this.tokens.refreshToken };
  }
}

export async function signInMicrosoft(opts: {
  http: HttpFn;
  authorize: (authorizeUrl: string) => Promise<OAuthResult>;
  clientId: string;
  loginBase?: string;
}): Promise<MsSession> {
  const loginBase = opts.loginBase ?? MS_LOGIN;
  const clientId = opts.clientId.trim();
  const verifier = randomString(48);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encodeUtf8(verifier))));
  const state = randomString(16);
  const url = new URL(`${loginBase}/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  const r = await opts.authorize(url.toString());
  if (r.error === 'cancelled') throw new CancelledError();
  if (r.error || !r.code) throw new MsAuthError(explainAuthError(r.error, r.errorDescription));
  if (r.state !== state) throw new MsAuthError('Ungültige Antwort von Microsoft. Bitte versuche es erneut.');
  const tokens = await requestToken(opts.http, loginBase, {
    client_id: clientId,
    grant_type: 'authorization_code',
    code: r.code,
    redirect_uri: r.redirectUri,
    code_verifier: verifier,
    scope: SCOPES,
  });
  return new MsSession(opts.http, clientId, tokens, accountName(tokens.idToken), loginBase);
}
