import { useEffect, useRef, useState } from 'react';
import { Cloud, ExternalLink, FileInput, LogOut, PenTool, Palette, RefreshCw, Info } from 'lucide-react';
import { platform } from '../platform';
import { useSettings, type ThemeMode } from '../state/settings';
import { useUI } from '../state/ui';
import { DEFAULT_ROOT, syncManager, useSync } from '../sync/manager';
import { checkServer, fetchUser, normalizeServerUrl, pollLoginFlow, startLoginFlow, type LoginFlow } from '../sync/nextcloud';
import { FONTS } from '../editor/extensions';
import { confirmDialog, Modal } from './Dialogs';
import { oneNoteImportAvailable } from './OneNoteImport';
import { toast } from './Toasts';

const APP_VERSION = '1.3.0';

function timeAgo(ts: number | null) {
  if (!ts) return 'noch nie';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  return new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

export function ConnectForm({ onDone }: { onDone?(): void }) {
  const [server, setServer] = useState('');
  const [folder, setFolder] = useState(DEFAULT_ROOT);
  const [mode, setMode] = useState<'browser' | 'manual'>('browser');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<LoginFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => () => void (cancelled.current = true), []);

  const finish = async (srv: string, loginName: string, appPassword: string) => {
    const info = await fetchUser(platform.http, srv, loginName, appPassword, platform.deviceName);
    await syncManager.connect({ server: srv, loginName, appPassword, userId: info.userId, displayName: info.displayName }, folder);
    toast(`Mit Nextcloud verbunden als ${info.displayName}`);
    onDone?.();
  };

  const connectBrowser = async () => {
    setError(null);
    setBusy(true);
    cancelled.current = false;
    try {
      const srv = normalizeServerUrl(server);
      await checkServer(platform.http, srv);
      const flow = await startLoginFlow(platform.http, srv, platform.deviceName);
      setWaiting(flow);
      await platform.openExternal(flow.loginUrl);
      const deadline = Date.now() + 20 * 60 * 1000;
      while (!cancelled.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (cancelled.current) break;
        let creds = null;
        try {
          creds = await pollLoginFlow(platform.http, flow, platform.deviceName);
        } catch (e) {
          if (!(e instanceof Error) || !/HTTP/.test(e.message)) continue; // network hiccup, keep polling
          throw e;
        }
        if (creds) {
          await platform.closeLoginBrowser?.();
          await finish(creds.server || srv, creds.loginName, creds.appPassword);
          return;
        }
      }
      if (!cancelled.current) setError('Die Anmeldung wurde nicht rechtzeitig bestätigt.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setWaiting(null);
    }
  };

  const connectManual = async () => {
    setError(null);
    setBusy(true);
    try {
      const srv = normalizeServerUrl(server);
      await checkServer(platform.http, srv);
      await finish(srv, user.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const insecure = /^http:\/\//i.test(server.trim()) && !/localhost|127\.0\.0\.1/.test(server);

  return (
    <div className="connect-form">
      <label className="field">
        <span>Adresse deiner Nextcloud</span>
        <input
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="https://cloud.example.de"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && mode === 'browser') void connectBrowser();
          }}
        />
      </label>
      {insecure && <p className="warn">Achtung: Ohne https werden Passwort und Notizen unverschlüsselt übertragen.</p>}
      <label className="field">
        <span>Ordner in Nextcloud für deine Notizbücher</span>
        <input value={folder} onChange={(e) => setFolder(e.target.value)} disabled={busy} autoCapitalize="off" />
      </label>
      <div className="segmented" role="tablist">
        <button type="button" className={mode === 'browser' ? 'active' : ''} onClick={() => setMode('browser')} disabled={busy}>
          Im Browser anmelden
        </button>
        <button type="button" className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')} disabled={busy}>
          App-Passwort
        </button>
      </div>
      {mode === 'manual' && (
        <>
          <label className="field">
            <span>Benutzername</span>
            <input value={user} onChange={(e) => setUser(e.target.value)} autoCapitalize="off" autoCorrect="off" disabled={busy} />
          </label>
          <label className="field">
            <span>App-Passwort</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          </label>
          <p className="hint">Ein App-Passwort erstellst du in Nextcloud unter Einstellungen → Sicherheit → „Neues App-Passwort erstellen“.</p>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {waiting ? (
        <div className="waiting">
          <RefreshCw size={16} className="spin" />
          <span>Bitte bestätige den Zugriff im Browserfenster …</span>
          <button type="button" className="btn small" onClick={() => void platform.openExternal(waiting.loginUrl)}>
            <ExternalLink size={14} /> Erneut öffnen
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              cancelled.current = true;
              setWaiting(null);
              setBusy(false);
            }}
          >
            Abbrechen
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn primary wide"
          disabled={busy || !server.trim() || (mode === 'manual' && (!user || !password))}
          onClick={() => void (mode === 'browser' ? connectBrowser() : connectManual())}
        >
          <Cloud size={16} /> {busy ? 'Verbinde …' : 'Mit Nextcloud verbinden'}
        </button>
      )}
    </div>
  );
}

function AccountSection() {
  const sync = useSync();
  const interval = useSettings((s) => s.syncInterval);
  const setSetting = useSettings((s) => s.set);
  const [folder, setFolder] = useState(sync.account?.rootFolder ?? DEFAULT_ROOT);
  useEffect(() => setFolder(sync.account?.rootFolder ?? DEFAULT_ROOT), [sync.account?.rootFolder]);

  if (!sync.account) {
    return (
      <section className="settings-section">
        <h3>
          <Cloud size={17} /> Nextcloud
        </h3>
        <p className="hint">Verbinde NextNote mit deiner Nextcloud, damit deine Notizbücher dort gespeichert und zwischen PC und Tablet synchronisiert werden.</p>
        <ConnectForm />
      </section>
    );
  }
  return (
    <section className="settings-section">
      <h3>
        <Cloud size={17} /> Nextcloud
      </h3>
      <div className="account-card">
        <div>
          <strong>{sync.account.displayName}</strong>
          <div className="muted">{sync.account.server}</div>
        </div>
        <button
          type="button"
          className="btn small"
          onClick={async () => {
            const ok = await confirmDialog({
              title: 'Abmelden',
              message: 'Die Verbindung zu Nextcloud wird getrennt und das App-Passwort widerrufen. Deine Notizen bleiben auf diesem Gerät und in Nextcloud erhalten.',
              ok: 'Abmelden',
            });
            if (ok) await syncManager.logout();
          }}
        >
          <LogOut size={14} /> Abmelden
        </button>
      </div>
      <div className="row">
        <label className="field grow">
          <span>Ordner in Nextcloud</span>
          <input value={folder} onChange={(e) => setFolder(e.target.value)} autoCapitalize="off" />
        </label>
        <button
          type="button"
          className="btn"
          disabled={folder.trim() === sync.account.rootFolder || !folder.trim()}
          onClick={async () => {
            const ok = await confirmDialog({
              title: 'Ordner ändern',
              message: `Deine Notizbücher werden ab jetzt mit „${folder.trim()}“ synchronisiert. Vorhandene Notizbücher dort werden übernommen, deine lokalen hochgeladen.`,
              ok: 'Ordner ändern',
            });
            if (ok) await syncManager.changeRootFolder(folder);
          }}
        >
          Übernehmen
        </button>
      </div>
      <label className="field">
        <span>Automatisch synchronisieren</span>
        <select value={interval} onChange={(e) => setSetting('syncInterval', Number(e.target.value))}>
          <option value={30}>alle 30 Sekunden</option>
          <option value={60}>jede Minute</option>
          <option value={300}>alle 5 Minuten</option>
          <option value={0}>nur bei Änderungen und manuell</option>
        </select>
      </label>
      <div className="sync-status-line">
        <span>
          Letzte Synchronisierung: {timeAgo(sync.lastSync)}
          {sync.lastSummary ? ` – ${sync.lastSummary}` : ''}
        </span>
        <button type="button" className="btn small" onClick={() => void syncManager.syncNow()} disabled={sync.status === 'syncing'}>
          <RefreshCw size={14} className={sync.status === 'syncing' ? 'spin' : ''} /> Jetzt synchronisieren
        </button>
      </div>
      {sync.lastError && <pre className="error-box">{sync.lastError}</pre>}
      {sync.status === 'auth' && <ConnectForm />}
    </section>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange(v: boolean): void }) {
  return (
    <label className="toggle-row">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function SettingsDialog() {
  const open = useUI((s) => s.settingsOpen);
  const s = useSettings();
  if (!open) return null;
  const close = () => useUI.setState({ settingsOpen: false });
  return (
    <Modal title="Einstellungen" onClose={close} wide className="settings">
      <AccountSection />
      <section className="settings-section">
        <h3>
          <FileInput size={17} /> Importieren
        </h3>
        {oneNoteImportAvailable() ? (
          <div className="sync-status-line">
            <span>Notizbücher aus Microsoft OneNote übernehmen – mit Text, Bildern, Tags und Handschrift.</span>
            <button type="button" className="btn small" onClick={() => useUI.setState({ settingsOpen: false, importOpen: true })}>
              Aus OneNote importieren …
            </button>
          </div>
        ) : (
          <p className="hint">Der Import aus OneNote ist in der Windows-App verfügbar. Importierte Notizbücher erscheinen danach über Nextcloud auch hier.</p>
        )}
      </section>
      <section className="settings-section">
        <h3>
          <PenTool size={17} /> Stift &amp; Eingabe
        </h3>
        <Toggle
          label="Stift zeichnet immer"
          hint="Mit dem S Pen schreiben, auch wenn das Textwerkzeug aktiv ist. Kurzes Tippen setzt den Cursor."
          value={s.penAlwaysDraws}
          onChange={(v) => s.set('penAlwaysDraws', v)}
        />
        <Toggle label="Seitentaste des Stifts radiert" hint="Taste gedrückt halten, dann aufsetzen und über Striche fahren." value={s.penButtonErases} onChange={(v) => s.set('penButtonErases', v)} />
        <Toggle label="Druckempfindlichkeit" hint="Neue Striche werden bei festerem Druck breiter. Aus: gleichmäßige Breite." value={s.pressure} onChange={(v) => s.set('pressure', v)} />
        <Toggle
          label="Mit dem Finger zeichnen"
          hint="Aus: Finger scrollen und zoomen, nur der Stift zeichnet (Handballenerkennung)."
          value={s.drawWithFinger}
          onChange={(v) => s.set('drawWithFinger', v)}
        />
      </section>
      <section className="settings-section">
        <h3>
          <Palette size={17} /> Darstellung
        </h3>
        <label className="field">
          <span>Design</span>
          <select value={s.theme} onChange={(e) => s.set('theme', e.target.value as ThemeMode)}>
            <option value="system">Wie System</option>
            <option value="light">Hell</option>
            <option value="dark">Dunkel</option>
          </select>
        </label>
        <Toggle label="Dunkle Tinte im Dunkelmodus hell anzeigen" value={s.invertInkInDark} onChange={(v) => s.set('invertInkInDark', v)} />
        <div className="row">
          <label className="field grow">
            <span>Standardschrift</span>
            <select value={s.defaultFont} onChange={(e) => s.set('defaultFont', e.target.value)}>
              {FONTS.map((f) => (
                <option key={f.label} value={f.label}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Größe</span>
            <select value={s.defaultFontSize} onChange={(e) => s.set('defaultFontSize', Number(e.target.value))}>
              {[9, 10, 11, 12, 14, 16, 18].map((n) => (
                <option key={n} value={n}>
                  {n} pt
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <section className="settings-section">
        <h3>
          <Info size={17} /> Info
        </h3>
        <p className="hint">
          NextNote {APP_VERSION} · {platform.kind === 'electron' ? 'Windows' : platform.kind === 'android' ? 'Android' : 'Browser'}. Notizbücher werden als Ordner mit
          JSON-Dateien und Bildern in deiner Nextcloud gespeichert. Gelöschte Dateien landen im Nextcloud-Papierkorb.
        </p>
      </section>
    </Modal>
  );
}
