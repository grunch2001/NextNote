import { useCallback, useRef, useState } from 'react';
import { BookOpen, CircleCheck, ExternalLink, LogIn, RefreshCw, TriangleAlert } from 'lucide-react';
import { platform } from '../platform';
import { repo } from '../state/repo';
import { useUI } from '../state/ui';
import { syncManager } from '../sync/manager';
import { CancelledError, signInMicrosoft } from '../import/onenote/auth';
import { GraphClient, type GraphNotebook } from '../import/onenote/graph';
import { importFromOneNote, type ImportProgress, type ImportSummary, type PreparedImage } from '../import/onenote/importer';
import { prepareImage } from './assets';
import { confirmDialog, Modal } from './Dialogs';

const CLIENT_ID_KEY = 'nextnote.onenoteClientId';
const AZURE_FREE_URL = 'https://azure.microsoft.com/free';
const REGISTRATIONS_URL = 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade';
const STORED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const oneNoteImportAvailable = () => !!platform.oauthAuthorize;

type Step =
  | { kind: 'setup' }
  | { kind: 'signin' }
  | { kind: 'loading' }
  | { kind: 'select'; notebooks: GraphNotebook[] }
  | { kind: 'importing'; progress: ImportProgress }
  | { kind: 'done'; summary: ImportSummary };

/** Real height of imported outline content, laid out like a text container. */
function measureOutline(el: HTMLElement, width: number | null): number {
  const host = document.createElement('div');
  host.className = 'nn-editor import-measure';
  host.style.width = width ? `${width}px` : 'max-content';
  host.appendChild(el.cloneNode(true));
  document.body.appendChild(host);
  try {
    return Math.ceil(host.getBoundingClientRect().height);
  } finally {
    host.remove();
  }
}

/** Re-encodes formats that not every device can show (BMP, TIFF …) as PNG and shrinks large images. */
async function processImage(data: Uint8Array, mime: string): Promise<PreparedImage> {
  let blob = new Blob([data as BlobPart], { type: mime });
  if (!STORED_MIMES.has(mime)) {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild nicht lesbar'))), 'image/png'));
  }
  return prepareImage(blob);
}

const fmt = (n: number) => n.toLocaleString('de-DE');

function Summary({ summary }: { summary: ImportSummary }) {
  const warnings: string[] = [];
  if (summary.failedImages) warnings.push(`${fmt(summary.failedImages)} Bild(er) konnten nicht geladen werden.`);
  if (summary.attachments) warnings.push(`${fmt(summary.attachments)} Dateianhang/-anhänge wurden nicht übernommen (auf der Seite steht ein Hinweis).`);
  if (summary.videos) warnings.push(`${fmt(summary.videos)} eingebettete(s) Video(s) wurden als Link übernommen.`);
  return (
    <div className="import-summary">
      {summary.error ? (
        <p className="error">
          <TriangleAlert size={15} /> Der Import wurde wegen eines Fehlers beendet: {summary.error}
        </p>
      ) : summary.cancelled ? (
        <p className="warn-line">
          <TriangleAlert size={15} /> Import abgebrochen – die bis dahin importierten Seiten bleiben erhalten.
        </p>
      ) : (
        <p className="ok-line">
          <CircleCheck size={16} /> Import abgeschlossen.
        </p>
      )}
      <ul className="import-counts">
        <li>
          <strong>{fmt(summary.notebooks.length)}</strong> Notizbuch/-bücher: {summary.notebooks.map((n) => n.name).join(', ') || '–'}
        </li>
        <li>
          <strong>{fmt(summary.sections)}</strong> Abschnitte, <strong>{fmt(summary.pages)}</strong> Seiten
        </li>
        <li>
          <strong>{fmt(summary.images)}</strong> Bilder, <strong>{fmt(summary.strokes)}</strong> Striche Handschrift
        </li>
      </ul>
      {warnings.map((w) => (
        <p key={w} className="hint">
          {w}
        </p>
      ))}
      {summary.failedPages.length > 0 && (
        <>
          <p className="hint">Diese Seiten konnten nicht importiert werden:</p>
          <pre className="error-box">
            {summary.failedPages
              .slice(0, 20)
              .map((p) => `${p.title}: ${p.error}`)
              .join('\n')}
            {summary.failedPages.length > 20 ? `\n… und ${summary.failedPages.length - 20} weitere` : ''}
          </pre>
        </>
      )}
      <p className="hint">
        {syncManager.configured
          ? 'Die Notizbücher werden jetzt wie gewohnt mit deiner Nextcloud synchronisiert.'
          : 'Die Notizbücher sind auf diesem Gerät gespeichert. Verbinde in den Einstellungen deine Nextcloud, damit sie dort landen.'}
      </p>
    </div>
  );
}

export function OneNoteImport() {
  const open = useUI((s) => s.importOpen);
  return open ? <ImportDialog /> : null;
}

function ImportDialog() {
  const [clientId, setClientId] = useState(() => {
    try {
      return localStorage.getItem(CLIENT_ID_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [step, setStep] = useState<Step>({ kind: 'setup' });
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const graph = useRef<GraphClient | null>(null);
  const cancelled = useRef(false);
  const [cancelling, setCancelling] = useState(false);

  const close = useCallback(async () => {
    if (step.kind === 'importing') {
      const ok = await confirmDialog({ title: 'Import abbrechen', message: 'Bereits importierte Seiten bleiben erhalten.', ok: 'Import abbrechen', danger: true });
      if (!ok) return;
      cancelled.current = true;
      setCancelling(true);
      return;
    }
    if (step.kind === 'signin') void platform.oauthCancel?.();
    useUI.setState({ importOpen: false });
  }, [step.kind]);

  const signIn = async () => {
    setError(null);
    const id = clientId.trim();
    try {
      localStorage.setItem(CLIENT_ID_KEY, id);
    } catch {
      // storage unavailable
    }
    setStep({ kind: 'signin' });
    try {
      const session = await signInMicrosoft({ http: platform.http, authorize: (url) => platform.oauthAuthorize!(url), clientId: id });
      setAccount(session.account);
      graph.current = new GraphClient(platform.http, session);
      setStep({ kind: 'loading' });
      const notebooks = await graph.current.notebooks();
      setSelected(new Set(notebooks.length === 1 ? [notebooks[0].id] : []));
      setStep({ kind: 'select', notebooks });
    } catch (e) {
      if (!(e instanceof CancelledError)) setError(e instanceof Error ? e.message : String(e));
      setStep({ kind: 'setup' });
    }
  };

  const runImport = async (notebooks: GraphNotebook[]) => {
    if (!graph.current) return;
    cancelled.current = false;
    setCancelling(false);
    setStep({ kind: 'importing', progress: { notebook: '', section: '', page: '', done: 0, total: 0 } });
    const summary = await importFromOneNote({
      graph: graph.current,
      repo,
      notebooks: notebooks.filter((n) => selected.has(n.id)),
      onProgress: (progress) => setStep({ kind: 'importing', progress }),
      isCancelled: () => cancelled.current,
      measure: measureOutline,
      processImage,
    });
    setStep({ kind: 'done', summary });
    if (syncManager.configured) void syncManager.syncNow();
  };

  const openImported = async (summary: ImportSummary) => {
    const first = summary.notebooks[0];
    useUI.setState({ importOpen: false });
    if (!first) return;
    const sections = await repo.listSections(first.id);
    const pages = sections[0] ? await repo.listPages(sections[0].id) : [];
    useUI.getState().openPage(pages[0]?.id ?? null, sections[0]?.id ?? null, first.id);
  };

  const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId.trim());
  let body: React.ReactNode;
  let footer: React.ReactNode = null;

  if (step.kind === 'setup' || step.kind === 'signin') {
    body = (
      <>
        <p className="hint">
          Übernimmt Notizbücher aus OneNote (gespeichert in OneDrive) mit Abschnitten, Unterseiten, Text, Tabellen, Tags, Bildern und Handschrift. Sie werden als
          neue Notizbücher angelegt; dein OneNote bleibt unverändert.
        </p>
        <label className="field">
          <span>Anwendungs-ID (Client-ID) deiner App-Registrierung bei Microsoft</span>
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            spellCheck={false}
            autoCapitalize="off"
            disabled={step.kind === 'signin'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && validId) void signIn();
            }}
          />
        </label>
        {clientId.trim() && !validId && <p className="warn">Die Anwendungs-ID hat die Form 00000000-0000-0000-0000-000000000000.</p>}
        <details className="import-help" open={!clientId.trim()}>
          <summary>So erstellst du die App-Registrierung (einmalig)</summary>
          <ol>
            <li>
              Ein persönliches Microsoft-Konto braucht zuerst ein eigenes Verzeichnis: auf{' '}
              <button type="button" className="link-btn" onClick={() => void platform.openExternal(AZURE_FREE_URL)}>
                azure.microsoft.com/free <ExternalLink size={12} />
              </button>{' '}
              mit diesem Konto „Kostenlos starten“ durchlaufen. Telefonnummer und Kreditkarte dienen dort nur der Identitätsprüfung; ohne Upgrade kostet es
              nichts. Mit einem Uni- oder Arbeitskonto entfällt dieser Schritt, sofern die Organisation App-Registrierungen erlaubt.
            </li>
            <li>
              Auf{' '}
              <button type="button" className="link-btn" onClick={() => void platform.openExternal(REGISTRATIONS_URL)}>
                portal.azure.com <ExternalLink size={12} />
              </button>{' '}
              anmelden, falls nötig über dein Profil oben rechts → „Verzeichnis wechseln“ das neue „Standardverzeichnis“ wählen, dann „App-Registrierungen“ →
              „Neue Registrierung“.
            </li>
            <li>Name z. B. „NextNote“. Bei „Unterstützte Kontotypen“ die Option mit „… und persönliche Microsoft-Konten“ wählen.</li>
            <li>
              Bei „Umleitungs-URI“ die Plattform „Öffentlicher Client/nativ (mobil und Desktop)“ wählen, <code>http://localhost</code> eintragen und
              registrieren.
            </li>
            <li>Die „Anwendungs-ID (Client)“ von der Übersichtsseite kopieren und oben einfügen.</li>
          </ol>
          <p className="muted">
            Meldet das Portal „… does not exist in tenant 'Microsoft Services'“, fehlt Schritt 1 oder das neue Verzeichnis ist nicht ausgewählt. Berechtigungen
            musst du nicht eintragen – bei der Anmeldung fragt Microsoft, ob NextNote deine Notizbücher lesen darf. NextNote speichert dabei kein
            Microsoft-Passwort; der Zugriff gilt nur für diesen Import.
          </p>
        </details>
        {error && <p className="error">{error}</p>}
        {step.kind === 'signin' && (
          <div className="waiting">
            <RefreshCw size={16} className="spin" />
            <span>Bitte melde dich im Browser bei Microsoft an und erlaube den Zugriff …</span>
            <button type="button" className="btn small" onClick={() => void platform.oauthCancel?.()}>
              Abbrechen
            </button>
          </div>
        )}
      </>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={() => void close()}>
          Schließen
        </button>
        <button type="button" className="btn primary" disabled={!validId || step.kind === 'signin'} onClick={() => void signIn()}>
          <LogIn size={15} /> Bei Microsoft anmelden
        </button>
      </>
    );
  } else if (step.kind === 'loading') {
    body = (
      <div className="waiting">
        <RefreshCw size={16} className="spin" /> Notizbücher werden geladen …
      </div>
    );
  } else if (step.kind === 'select') {
    const all = step.notebooks;
    body = (
      <>
        {account && (
          <p className="hint">
            Angemeldet bei Microsoft als <strong>{account}</strong>.
          </p>
        )}
        {all.length === 0 ? (
          <p className="hint">In diesem Microsoft-Konto wurden keine Notizbücher gefunden.</p>
        ) : (
          <>
            <div className="list-title import-list-title">
              <span>Welche Notizbücher sollen importiert werden?</span>
              {all.length > 1 && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setSelected(selected.size === all.length ? new Set() : new Set(all.map((n) => n.id)))}
                >
                  {selected.size === all.length ? 'Keine auswählen' : 'Alle auswählen'}
                </button>
              )}
            </div>
            <div className="import-list" role="group">
              {all.map((nb) => (
                <label key={nb.id} className="import-item">
                  <input
                    type="checkbox"
                    checked={selected.has(nb.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(nb.id);
                      else next.delete(nb.id);
                      setSelected(next);
                    }}
                  />
                  <BookOpen size={16} className="import-item-icon" />
                  <span className="import-item-name">{nb.displayName}</span>
                  {nb.lastModifiedDateTime && <span className="muted">{new Date(nb.lastModifiedDateTime).toLocaleDateString('de-DE')}</span>}
                </label>
              ))}
            </div>
            <p className="hint import-note">
              Abschnittsgruppen werden zu Abschnitten namens „Gruppe › Abschnitt“. OneNote verrät die Reihenfolge der Abschnitte nicht – sie werden nach
              Erstelldatum sortiert und lassen sich danach per Ziehen umordnen. Große Notizbücher brauchen eine Weile, weil Microsoft die Abfragen bremst.
            </p>
          </>
        )}
      </>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={() => void close()}>
          Abbrechen
        </button>
        <button type="button" className="btn primary" disabled={selected.size === 0} onClick={() => void runImport(all)}>
          {selected.size === 0 ? 'Importieren' : selected.size === 1 ? 'Notizbuch importieren' : `${selected.size} Notizbücher importieren`}
        </button>
      </>
    );
  } else if (step.kind === 'importing') {
    const p = step.progress;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    body = (
      <div className="import-progress">
        <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.total || 1} aria-valuenow={p.done}>
          <div className={p.total ? '' : 'indeterminate'} style={p.total ? { transform: `scaleX(${pct / 100})` } : undefined} />
        </div>
        {p.total ? (
          <>
            <p className="import-status">
              Seite {fmt(Math.min(p.done + 1, p.total))} von {fmt(p.total)}
            </p>
            <p className="muted import-current">
              {p.notebook} › {p.section} › {p.page}
            </p>
          </>
        ) : (
          <>
            <p className="import-status">Inhaltsverzeichnis wird geladen …</p>
            <p className="muted import-current">{[p.notebook, p.section].filter(Boolean).join(' › ')}</p>
          </>
        )}
      </div>
    );
    footer = (
      <button type="button" className="btn" disabled={cancelling} onClick={() => void close()}>
        {cancelling ? 'Wird abgebrochen …' : 'Abbrechen'}
      </button>
    );
  } else {
    const summary = step.summary;
    body = <Summary summary={summary} />;
    footer = (
      <>
        <button type="button" className="btn" onClick={() => useUI.setState({ importOpen: false })}>
          Schließen
        </button>
        {summary.notebooks.length > 0 && (
          <button type="button" className="btn primary" onClick={() => void openImported(summary)}>
            Notizbuch öffnen
          </button>
        )}
      </>
    );
  }

  return (
    <Modal title="Aus OneNote importieren" onClose={() => void close()} footer={footer} wide className="onenote-import">
      {body}
    </Modal>
  );
}
