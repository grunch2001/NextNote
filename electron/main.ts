import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, screen, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { authorizeViaLoopback } from './oauth';

const DEV_URL = process.env.NEXTNOTE_DEV_URL;
const DIST = path.join(__dirname, '..', 'dist');
const CSP =
  "default-src 'self' app:; img-src 'self' app: data: blob:; style-src 'self' app: 'unsafe-inline'; script-src 'self' app:; worker-src 'self' app: blob:; font-src 'self' app: data:; connect-src 'self' app: blob: data:; object-src 'none'; base-uri 'none'";

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

// Trust certificates from the Windows certificate store as well (e.g. company or self-hosted CAs).
try {
  const t = tls as unknown as { getCACertificates?(kind: string): string[]; setDefaultCACertificates?(certs: string[]): void };
  if (t.getCACertificates && t.setDefaultCACertificates) {
    t.setDefaultCACertificates([...new Set([...t.getCACertificates('bundled'), ...t.getCACertificates('system')])]);
  }
} catch {
  // keep the bundled CA list
}

if (!app.requestSingleInstanceLock()) {
  // another instance is running: it gets focused via 'second-instance'
  app.exit(0);
}

let win: BrowserWindow | null = null;

// ------------------------------------------------------------------ window state

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const statePath = () => path.join(app.getPath('userData'), 'window-state.json');

function loadState(): WindowState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as WindowState;
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x !== undefined && s.y !== undefined && s.x < b.x + b.width - 100 && s.x + s.width > b.x + 100 && s.y >= b.y - 20 && s.y < b.y + b.height - 100;
    });
    if (!visible) return { width: s.width, height: s.height, maximized: s.maximized };
    return s;
  } catch {
    return { width: 1360, height: 860, maximized: false };
  }
}

function saveState(w: BrowserWindow) {
  try {
    const b = w.getNormalBounds();
    fs.writeFileSync(statePath(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: w.isMaximized() }));
  } catch {
    // ignore
  }
}

// ------------------------------------------------------------------ secure storage (Windows DPAPI via safeStorage)

const securePath = () => path.join(app.getPath('userData'), 'secure.json');

function readSecure(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(securePath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

ipcMain.handle('secureGet', (_e, key: string) => {
  const v = readSecure()[key];
  if (!v) return null;
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('raw:')) return v.slice(4);
  } catch {
    return null;
  }
  return null;
});

ipcMain.handle('secureSet', (_e, key: string, value: string | null) => {
  const all = readSecure();
  if (value === null) delete all[key];
  else if (safeStorage.isEncryptionAvailable()) all[key] = 'enc:' + safeStorage.encryptString(value).toString('base64');
  else all[key] = 'raw:' + value;
  fs.writeFileSync(securePath(), JSON.stringify(all), { mode: 0o600 });
});

// ------------------------------------------------------------------ HTTP for WebDAV (no CORS, all methods)

interface HttpReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  timeoutMs?: number;
}

ipcMain.handle('http', async (_e, req: HttpReq) => {
  if (!/^https?:\/\//i.test(req.url)) return { ok: false, error: 'Ungültige Adresse' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 60000);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body && req.body.byteLength ? Buffer.from(req.body) : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = new Uint8Array(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { ok: true, status: res.status, headers, body };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const detail = err.name === 'AbortError' ? 'Zeitüberschreitung' : (err.cause?.code ?? err.cause?.message ?? err.message);
    return { ok: false, error: `Netzwerkfehler: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle('clipboardRead', async () => {
  let text = '';
  let image: Uint8Array | null = null;
  try {
    for (const item of await clipboard.read()) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType && !image) image = new Uint8Array(await ((await item.getType(imageType)) as Blob).arrayBuffer());
      if (item.types.includes('text/plain') && !text) text = await ((await item.getType('text/plain')) as Blob).text();
    }
  } catch {
    text = await clipboard.readText().catch(() => '');
  }
  return { text, image };
});

ipcMain.handle('clipboardWriteText', async (_e, text: string) => {
  await clipboard.writeText(text);
});

ipcMain.handle('openExternal', async (_e, url: string) => {
  if (/^(https?|mailto):/i.test(url)) await shell.openExternal(url);
});

// ------------------------------------------------------------------ OAuth sign-in in the system browser (e.g. Microsoft for the OneNote import)

let cancelOAuth: (() => void) | null = null;

ipcMain.handle('oauthAuthorize', async (_e, authorizeUrl: string) => {
  cancelOAuth?.();
  const flow = authorizeViaLoopback(authorizeUrl, {
    open: (url) => shell.openExternal(url),
    onRedirect: () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    },
  });
  cancelOAuth = flow.cancel;
  try {
    return await flow.result;
  } finally {
    if (cancelOAuth === flow.cancel) cancelOAuth = null;
  }
});

ipcMain.handle('oauthCancel', () => {
  cancelOAuth?.();
});

// ------------------------------------------------------------------ window

function contextMenu(w: BrowserWindow) {
  w.webContents.on('context-menu', (_e, params) => {
    const items: MenuItemConstructorOptions[] = [];
    for (const s of params.dictionarySuggestions.slice(0, 6)) {
      items.push({ label: s, click: () => w.webContents.replaceMisspelling(s) });
    }
    if (params.misspelledWord) {
      if (!params.dictionarySuggestions.length) items.push({ label: 'Keine Vorschläge', enabled: false });
      items.push({ label: 'Zum Wörterbuch hinzufügen', click: () => w.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push(
        { label: 'Ausschneiden', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Kopieren', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Einfügen', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'Alles auswählen', role: 'selectAll' },
      );
    } else if (params.selectionText) {
      items.push({ label: 'Kopieren', role: 'copy' });
    }
    if (params.linkURL && /^https?:/i.test(params.linkURL)) {
      items.push({ type: 'separator' }, { label: 'Link öffnen', click: () => void shell.openExternal(params.linkURL) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: w });
  });
}

function createWindow() {
  const state = loadState();
  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 720,
    minHeight: 480,
    title: 'NextNote',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b1f' : '#f3f2f1',
    icon: path.join(__dirname, '..', 'build-resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  const w = win;
  if (state.maximized) w.maximize();
  w.once('ready-to-show', () => w.show());
  w.on('close', () => saveState(w));
  w.on('focus', () => w.webContents.send('focus'));
  w.on('closed', () => (win = null));

  w.webContents.session.setSpellCheckerLanguages(['de-DE', 'en-US']);
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !(DEV_URL && url.startsWith(DEV_URL))) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      w.setFullScreen(!w.isFullScreen());
      e.preventDefault();
    } else if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      w.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  contextMenu(w);
  void w.loadURL(DEV_URL ?? 'app://nextnote/index.html');
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    if (/\.m?js$/.test(file)) {
      const headers = new Headers(res.headers);
      headers.set('Content-Type', 'text/javascript; charset=utf-8');
      return new Response(res.body, { status: res.status, headers });
    }
    if (!file.endsWith('.html')) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(res.body, { status: res.status, headers });
  });
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
