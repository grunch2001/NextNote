export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Header names are lower case. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

/** The request never reached the server (offline, DNS, TLS, timeout …). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export type PlatformKind = 'electron' | 'android' | 'web';

export interface Platform {
  kind: PlatformKind;
  /** Human readable name shown in Nextcloud's device list. */
  deviceName: string;
  http: HttpFn;
  openExternal(url: string): Promise<void>;
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string | null): Promise<void>;
  /** Called when the app returns to the foreground. */
  onResume(cb: () => void): void;
  /** Close the in-app browser used for the login flow, if any. */
  closeLoginBrowser?(): Promise<void>;
  /**
   * OAuth 2.0 authorization in the system browser with a loopback redirect (Windows only).
   * `redirect_uri` is added to `authorizeUrl`; the result names the URI that was used.
   */
  oauthAuthorize?(authorizeUrl: string): Promise<OAuthResult>;
  oauthCancel?(): Promise<void>;
  /** Android hardware back button. The handler returns true if it handled the event. */
  onBackButton?(handler: () => boolean): void;
  /** Reads the system clipboard (text and, where supported, an image). */
  readClipboard(): Promise<ClipboardContent>;
  writeClipboardText(text: string): Promise<void>;
  /**
   * Whether something was copied to the system clipboard after `time` (ms since epoch),
   * without reading the content. null = unknown on this platform.
   */
  clipboardChangedSince?(time: number): Promise<boolean | null>;
}

export interface OAuthResult {
  redirectUri: string;
  code?: string;
  state?: string;
  /** OAuth error code, or 'cancelled' / 'timeout'. */
  error?: string;
  errorDescription?: string;
}

export interface ClipboardContent {
  text: string | null;
  image: Blob | null;
}
