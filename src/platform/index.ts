import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { base64ToBytes, bytesToBase64, encodeUtf8 } from '../model/util';
import { NetworkError, type ClipboardContent, type HttpRequest, type HttpResponse, type NativeInkConfig, type NativeStroke, type OAuthResult, type Platform } from './types';

/** API exposed by electron/preload.ts */
export interface ElectronBridge {
  http(req: { method: string; url: string; headers: Record<string, string>; body?: Uint8Array; timeoutMs?: number }): Promise<
    { ok: true; status: number; headers: Record<string, string>; body: Uint8Array } | { ok: false; error: string }
  >;
  openExternal(url: string): Promise<void>;
  oauthAuthorize(authorizeUrl: string): Promise<OAuthResult>;
  oauthCancel(): Promise<void>;
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string | null): Promise<void>;
  onFocus(cb: () => void): void;
  clipboardRead(): Promise<{ text: string; image: Uint8Array | null }>;
  clipboardWriteText(text: string): Promise<void>;
  os: string;
  version: string;
}

declare global {
  interface Window {
    nextnoteNative?: ElectronBridge;
  }
}

interface NativeClipboardPlugin {
  info(): Promise<{ hasClip: boolean; timestamp: number }>;
  read(): Promise<{ text?: string; imageBase64?: string; imageType?: string }>;
  writeText(opts: { text: string }): Promise<void>;
}

interface NativePenPlugin {
  setButtonErases(opts: { enabled: boolean }): Promise<void>;
}

interface NativeInkPlugin {
  info(): Promise<{ available: boolean }>;
  configure(cfg: NativeInkConfig): Promise<void>;
  reject(opts: { x: number; y: number }): Promise<void>;
  shown(opts: { seq: number }): Promise<void>;
  clear(): Promise<void>;
  addListener(event: 'stroke', cb: (stroke: NativeStroke) => void): Promise<PluginListenerHandle>;
}

interface NativeSecureStoragePlugin {
  get(opts: { key: string }): Promise<{ value?: string }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
}

interface NativeHttpPlugin {
  request(opts: {
    method: string;
    url: string;
    headers: Record<string, string>;
    bodyBase64?: string;
    bodyFile?: string;
    timeoutMs?: number;
  }): Promise<{ status: number; headers: Record<string, string>; bodyBase64?: string; bodyFile?: string }>;
  append(opts: { file?: string; bodyBase64: string }): Promise<{ file: string }>;
  release(opts: { file: string }): Promise<void>;
}

/**
 * Larger bodies do not cross the bridge as one base64 string (an 86 MB PDF ran the app out of
 * memory): they go through a file, see NativeHttpPlugin.java (INLINE_MAX there as well).
 */
const INLINE_MAX = 2 * 1024 * 1024;

const toBytes = (body: Uint8Array | string | undefined) => (body === undefined ? undefined : typeof body === 'string' ? encodeUtf8(body) : body);

function lowerHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function electronPlatform(bridge: ElectronBridge): Platform {
  return {
    kind: 'electron',
    deviceName: `NextNote (${bridge.os === 'win32' ? 'Windows' : bridge.os})`,
    async http(req: HttpRequest): Promise<HttpResponse> {
      const res = await bridge.http({ method: req.method, url: req.url, headers: req.headers ?? {}, body: toBytes(req.body), timeoutMs: req.timeoutMs });
      if (!res.ok) throw new NetworkError(res.error);
      return { status: res.status, headers: lowerHeaders(res.headers), body: res.body };
    },
    openExternal: (url) => bridge.openExternal(url),
    oauthAuthorize: (url) => bridge.oauthAuthorize(url),
    oauthCancel: () => bridge.oauthCancel(),
    secureGet: (k) => bridge.secureGet(k),
    secureSet: (k, v) => bridge.secureSet(k, v),
    onResume: (cb) => bridge.onFocus(cb),
    async readClipboard() {
      const c = await bridge.clipboardRead();
      return { text: c.text || null, image: c.image ? new Blob([c.image as BlobPart], { type: 'image/png' }) : null };
    },
    writeClipboardText: (text) => bridge.clipboardWriteText(text),
  };
}

function androidPlatform(): Platform {
  const NativeHttp = registerPlugin<NativeHttpPlugin>('NativeHttp');
  const NativeClipboard = registerPlugin<NativeClipboardPlugin>('NativeClipboard');
  const NativeSecureStorage = registerPlugin<NativeSecureStoragePlugin>('NativeSecureStorage');
  const NativePen = registerPlugin<NativePenPlugin>('NativePen');
  const NativeInk = registerPlugin<NativeInkPlugin>('NativeInk');
  return {
    kind: 'android',
    deviceName: 'NextNote (Android)',
    async http(req: HttpRequest): Promise<HttpResponse> {
      const body = toBytes(req.body);
      let bodyFile: string | undefined;
      try {
        if (body && body.length > INLINE_MAX) {
          for (let i = 0; i < body.length; i += INLINE_MAX) {
            bodyFile = (await NativeHttp.append({ file: bodyFile, bodyBase64: bytesToBase64(body.subarray(i, i + INLINE_MAX)) })).file;
          }
        }
        const res = await NativeHttp.request({
          method: req.method,
          url: req.url,
          headers: req.headers ?? {},
          bodyBase64: body && !bodyFile ? bytesToBase64(body) : undefined,
          bodyFile,
          timeoutMs: req.timeoutMs,
        });
        const data = res.bodyFile ? await readTransferFile(NativeHttp, res.bodyFile) : base64ToBytes(res.bodyBase64 ?? '');
        return { status: res.status, headers: lowerHeaders(res.headers ?? {}), body: data };
      } catch (e) {
        throw new NetworkError(e instanceof Error ? e.message : String(e));
      } finally {
        if (bodyFile) NativeHttp.release({ file: bodyFile }).catch(() => {});
      }
    },
    async openExternal(url) {
      await Browser.open({ url });
    },
    async closeLoginBrowser() {
      try {
        await Browser.close();
      } catch {
        // not open
      }
    },
    async secureGet(k) {
      try {
        const { value } = await NativeSecureStorage.get({ key: k });
        if (value != null) return value;
        // version 1.0.0 kept the value unencrypted in localStorage: move it into the Keystore
        const legacy = localStorage.getItem(`secure.${k}`);
        if (legacy !== null) {
          await NativeSecureStorage.set({ key: k, value: legacy });
          localStorage.removeItem(`secure.${k}`);
        }
        return legacy;
      } catch {
        try {
          return localStorage.getItem(`secure.${k}`);
        } catch {
          return null;
        }
      }
    },
    async secureSet(k, v) {
      try {
        if (v === null) await NativeSecureStorage.remove({ key: k });
        else await NativeSecureStorage.set({ key: k, value: v });
        localStorage.removeItem(`secure.${k}`);
      } catch {
        // Keystore unusable on this device: fall back to the app's private storage
        try {
          if (v === null) localStorage.removeItem(`secure.${k}`);
          else localStorage.setItem(`secure.${k}`, v);
        } catch {
          // storage unavailable
        }
      }
    },
    onResume(cb) {
      void App.addListener('resume', cb);
    },
    onBackButton(handler) {
      void App.addListener('backButton', () => {
        if (!handler()) void App.minimizeApp();
      });
    },
    async readClipboard() {
      const r = await NativeClipboard.read();
      const image = r.imageBase64 ? new Blob([base64ToBytes(r.imageBase64) as BlobPart], { type: r.imageType ?? 'image/png' }) : null;
      return { text: r.text ?? null, image };
    },
    async writeClipboardText(text) {
      await NativeClipboard.writeText({ text });
    },
    async clipboardChangedSince(time) {
      const info = await NativeClipboard.info();
      if (!info.hasClip) return false;
      if (!info.timestamp) return null;
      return info.timestamp > time;
    },
    setPenButtonErases(enabled) {
      NativePen.setButtonErases({ enabled }).catch(() => {});
    },
    nativeInk: {
      available: () => NativeInk.info().then((r) => r.available, () => false),
      configure: (cfg) => void NativeInk.configure(cfg).catch(() => {}),
      reject: (x, y) => void NativeInk.reject({ x, y }).catch(() => {}),
      shown: (seq) => void NativeInk.shown({ seq }).catch(() => {}),
      clear: () => void NativeInk.clear().catch(() => {}),
      onStroke: (cb) => void NativeInk.addListener('stroke', cb),
    },
  };
}

/** A response body the native side wrote to a file, read through Capacitor's local server. */
async function readTransferFile(plugin: NativeHttpPlugin, file: string): Promise<Uint8Array> {
  try {
    const res = await fetch(Capacitor.convertFileSrc(file));
    if (!res.ok) throw new Error(`Antwort konnte nicht gelesen werden (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    plugin.release({ file }).catch(() => {});
  }
}

function webPlatform(): Platform {
  return {
    kind: 'web',
    deviceName: 'NextNote (Browser)',
    async http(req: HttpRequest): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 60000);
      try {
        const headers = { ...(req.headers ?? {}) };
        delete headers['User-Agent'];
        const res = await fetch(req.url, { method: req.method, headers, body: toBytes(req.body) as BodyInit | undefined, signal: controller.signal, credentials: 'omit' });
        const out: Record<string, string> = {};
        res.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
        return { status: res.status, headers: out, body: new Uint8Array(await res.arrayBuffer()) };
      } catch (e) {
        throw new NetworkError(e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(timer);
      }
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener');
    },
    async secureGet(k) {
      try {
        return localStorage.getItem(`secure.${k}`);
      } catch {
        return null;
      }
    },
    async secureSet(k, v) {
      try {
        if (v === null) localStorage.removeItem(`secure.${k}`);
        else localStorage.setItem(`secure.${k}`, v);
      } catch {
        // storage unavailable
      }
    },
    onResume(cb) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') cb();
      });
    },
    readClipboard: readWebClipboard,
    async writeClipboardText(text) {
      await navigator.clipboard.writeText(text);
    },
  };
}

async function readWebClipboard(): Promise<ClipboardContent> {
  const out: ClipboardContent = { text: null, image: null };
  try {
    for (const item of await navigator.clipboard.read()) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType && !out.image) out.image = await item.getType(imageType);
      if (item.types.includes('text/plain') && out.text === null) out.text = await (await item.getType('text/plain')).text();
    }
    return out;
  } catch {
    try {
      out.text = await navigator.clipboard.readText();
    } catch {
      // no permission
    }
    return out;
  }
}

function detect(): Platform {
  if (typeof window !== 'undefined' && window.nextnoteNative) return electronPlatform(window.nextnoteNative);
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') return androidPlatform();
  return webPlatform();
}

export const platform: Platform = detect();

export const isTouchDevice = typeof window !== 'undefined' && (platform.kind === 'android' || window.matchMedia?.('(pointer: coarse)').matches);
