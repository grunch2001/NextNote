import { create } from 'zustand';
import { db } from '../db/db';
import { pdfRepo, repo } from '../state/repo';
import { useSettings } from '../state/settings';
import { measured } from '../state/page';
import { fontStack } from '../editor/extensions';
import { PdfSync } from '../pdf/sync';
import { isPdfDirty } from '../pdf/repo';
import { platform } from '../platform';
import { NetworkError } from '../platform/types';
import { resetSyncState, SyncEngine, type SyncReport } from './engine';
import { basicAuth, davBaseUrl, revokeAppPassword, type NextcloudAccount } from './nextcloud';
import { DavError, joinPath, WebDavClient } from './webdav';

export interface AccountInfo {
  server: string;
  loginName: string;
  userId: string;
  displayName: string;
  rootFolder: string;
}

export type SyncStatus = 'disabled' | 'idle' | 'syncing' | 'error' | 'offline' | 'auth';

interface SyncState {
  account: AccountInfo | null;
  status: SyncStatus;
  progress: string;
  lastSync: number | null;
  lastError: string | null;
  lastSummary: string | null;
}

export const useSync = create<SyncState>(() => ({
  account: null,
  status: 'disabled',
  progress: '',
  lastSync: null,
  lastError: null,
  lastSummary: null,
}));

const ACCOUNT_KEY = 'nextnote.account';
const PASSWORD_KEY = 'nextnote.appPassword';
export const DEFAULT_ROOT = 'NextNote';

type AfterSync = (report: SyncReport) => void;
type BeforeSync = () => Promise<void> | void;

class SyncManager {
  private password: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private afterSync = new Set<AfterSync>();
  private beforeSync = new Set<BeforeSync>();
  private failures = 0;
  private pdfTimer: ReturnType<typeof setTimeout> | null = null;
  private force = false;

  async init() {
    try {
      const raw = localStorage.getItem(ACCOUNT_KEY);
      if (raw) {
        const account = JSON.parse(raw) as AccountInfo;
        this.password = await platform.secureGet(PASSWORD_KEY);
        if (account && this.password) useSync.setState({ account, status: 'idle', lastSync: Number(localStorage.getItem('nextnote.lastSync')) || null });
      }
    } catch {
      // ignore broken state
    }
    repo.onChange = () => this.requestSync(4000);
    // a PDF is uploaded as a whole: only once the pen rested for a while (or the PDF was closed)
    pdfRepo.onChange = (id) => this.schedulePdfUpload(pdfRepo.uploadDelay(id) + 1500);
    pdfRepo.onWanted = () => void this.syncNow();
    platform.onResume(() => this.requestSync(300));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.uploadPdfsNow();
    });
    window.addEventListener('online', () => this.requestSync(500));
    this.applyInterval();
    useSettings.subscribe((s, prev) => {
      if (s.syncInterval !== prev.syncInterval) this.applyInterval();
    });
    if (useSync.getState().account) this.requestSync(800);
  }

  private applyInterval() {
    if (this.interval) clearInterval(this.interval);
    const secs = useSettings.getState().syncInterval;
    if (secs > 0) this.interval = setInterval(() => this.requestSync(0), secs * 1000);
  }

  onAfterSync(cb: AfterSync) {
    this.afterSync.add(cb);
    return () => this.afterSync.delete(cb);
  }

  onBeforeSync(cb: BeforeSync) {
    this.beforeSync.add(cb);
    return () => this.beforeSync.delete(cb);
  }

  /** A WebDAV client for the account's files, null when not connected. */
  client(): WebDavClient | null {
    const account = useSync.getState().account;
    if (!account || !this.password) return null;
    return new WebDavClient(platform.http, davBaseUrl(account), basicAuth(account.loginName, this.password), platform.deviceName);
  }

  /** Uploads annotated PDFs right away, also the one being edited (the app goes to the background). */
  async uploadPdfsNow() {
    // the last stroke may still wait for being saved locally
    for (const cb of this.beforeSync) await cb();
    const dirty = await db.pdfDocs.filter((d) => d.deletedAt !== null || (isPdfDirty(d) && !d.readOnly)).count();
    if (dirty) await this.syncNow({ force: true });
  }

  private schedulePdfUpload(delayMs: number) {
    if (!this.configured) return;
    if (this.pdfTimer) clearTimeout(this.pdfTimer);
    this.pdfTimer = setTimeout(() => {
      this.pdfTimer = null;
      void this.syncNow();
    }, delayMs);
  }

  get configured() {
    return !!useSync.getState().account && !!this.password;
  }

  async connect(account: NextcloudAccount, rootFolder: string) {
    const prev = useSync.getState().account;
    const info: AccountInfo = {
      server: account.server,
      loginName: account.loginName,
      userId: account.userId,
      displayName: account.displayName,
      rootFolder: joinPath(rootFolder) || DEFAULT_ROOT,
    };
    if (!prev || prev.server !== info.server || prev.userId !== info.userId || prev.rootFolder !== info.rootFolder) {
      await resetSyncState(db);
    }
    this.password = account.appPassword;
    await platform.secureSet(PASSWORD_KEY, account.appPassword);
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(info));
    useSync.setState({ account: info, status: 'idle', lastError: null });
    this.failures = 0;
    await this.syncNow();
  }

  async changeRootFolder(rootFolder: string) {
    const account = useSync.getState().account;
    if (!account) return;
    const next = { ...account, rootFolder: joinPath(rootFolder) || DEFAULT_ROOT };
    if (next.rootFolder === account.rootFolder) return;
    await this.waitIdle();
    await resetSyncState(db);
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(next));
    useSync.setState({ account: next });
    await this.syncNow();
  }

  async logout() {
    const account = useSync.getState().account;
    await this.waitIdle();
    if (account && this.password) {
      await revokeAppPassword(platform.http, { ...account, appPassword: this.password }, platform.deviceName);
    }
    this.password = null;
    await platform.secureSet(PASSWORD_KEY, null);
    localStorage.removeItem(ACCOUNT_KEY);
    await resetSyncState(db);
    useSync.setState({ account: null, status: 'disabled', lastError: null, lastSync: null, progress: '' });
  }

  private async waitIdle() {
    while (this.running) await this.running;
  }

  /** Waits for a sync that is already running, then syncs once more (everything up to now is included). */
  async syncFresh(opts: { force?: boolean } = {}) {
    await this.waitIdle();
    await this.syncNow(opts);
  }

  /** Schedule a sync. Repeated calls within the delay are coalesced. */
  requestSync(delayMs = 0) {
    // after a 401 only an explicit sync or a new login retries (avoids hammering the server / brute force protection)
    if (!this.configured || useSync.getState().status === 'auth') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, delayMs);
  }

  /** `force`: also upload PDFs that are being edited right now. */
  syncNow(opts: { force?: boolean } = {}): Promise<void> {
    if (!this.configured) return Promise.resolve();
    if (opts.force) this.force = true;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.requestSync(1000);
      }
    });
    return this.running;
  }

  private async run() {
    const account = useSync.getState().account;
    const password = this.password;
    if (!account || !password) return;
    useSync.setState({ status: 'syncing', progress: 'Synchronisiere …' });
    for (const cb of this.beforeSync) await cb();
    const client = new WebDavClient(platform.http, davBaseUrl(account), basicAuth(account.loginName, password), platform.deviceName);
    const onProgress = (msg: string) => useSync.setState({ progress: msg });
    const engine = new SyncEngine(db, client, account.rootFolder, { onProgress });
    const force = this.force;
    this.force = false;
    try {
      const report = await engine.sync();
      const settings = useSettings.getState();
      const pdf = await new PdfSync(pdfRepo, client, {
        writeOptions: () => ({ fontSize: settings.defaultFontSize, fontFamily: fontStack(settings.defaultFont), measured }),
        force,
        onProgress,
      }).sync();
      report.uploaded += pdf.uploaded;
      report.downloaded += pdf.downloaded;
      report.deleted += pdf.deleted;
      report.conflicts += pdf.conflicts;
      report.errors.push(...pdf.errors);
      for (const id of pdf.changedDocs) report.changedPages.add(id);
      report.structureChanged ||= pdf.structureChanged;
      if (pdf.retryInMs !== null) this.schedulePdfUpload(pdf.retryInMs);
      this.failures = 0;
      const ts = Date.now();
      localStorage.setItem('nextnote.lastSync', String(ts));
      const parts = [];
      if (report.uploaded) parts.push(`${report.uploaded} hochgeladen`);
      if (report.downloaded) parts.push(`${report.downloaded} heruntergeladen`);
      if (report.deleted) parts.push(`${report.deleted} gelöscht`);
      if (report.conflicts) parts.push(`${report.conflicts} Konflikt(e) – beide Versionen behalten`);
      useSync.setState({
        status: report.errors.length ? 'error' : 'idle',
        lastSync: ts,
        lastError: report.errors.length ? report.errors.join('\n') : null,
        lastSummary: parts.length ? parts.join(', ') : 'Alles aktuell',
        progress: '',
      });
      for (const cb of this.afterSync) cb(report);
      void repo.purgeExpiredTrash();
    } catch (e) {
      this.failures++;
      const message = e instanceof Error ? e.message : String(e);
      let status: SyncStatus = 'error';
      if (e instanceof NetworkError) status = 'offline';
      else if (e instanceof DavError && e.status === 401) status = 'auth';
      useSync.setState({ status, lastError: message, progress: '' });
      if (status !== 'auth') {
        // retry with backoff: 15s, 30s, 60s … max 5min
        this.requestSync(Math.min(300000, 15000 * 2 ** (this.failures - 1)));
      }
    }
  }
}

export const syncManager = new SyncManager();
