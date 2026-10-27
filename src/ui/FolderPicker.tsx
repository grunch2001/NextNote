import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { ChevronRight, FileText, Folder, FolderPlus, HardDrive } from 'lucide-react';
import { joinPath, type DavEntry } from '../sync/webdav';
import { syncManager, useSync } from '../sync/manager';
import { isPdfName } from '../pdf/repo';
import { Modal, promptDialog } from './Dialogs';
import { toast } from './Toasts';

const usePicker = create<{ open: boolean; resolve: ((path: string | null) => void) | null }>(() => ({ open: false, resolve: null }));

/** Lets the user choose a folder of their Nextcloud. Resolves with its path (relative to the user's files) or null. */
export function pickNextcloudFolder(): Promise<string | null> {
  return new Promise((resolve) => usePicker.setState({ open: true, resolve }));
}

interface Listing {
  folders: DavEntry[];
  pdfs: number;
}

export function FolderPicker() {
  const open = usePicker((s) => s.open);
  if (!open) return null;
  return <FolderPickerDialog />;
}

function FolderPickerDialog() {
  const root = useSync((s) => s.account?.rootFolder ?? 'NextNote');
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setListing(null);
    setError(null);
    const client = syncManager.client();
    if (!client) {
      setError('Nicht mit Nextcloud verbunden.');
      return;
    }
    client
      .list(path)
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setError('Diesen Ordner gibt es nicht mehr.');
          return;
        }
        const folders = res.children.filter((c) => c.isDir && !c.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
        setListing({ folders, pdfs: res.children.filter((c) => !c.isDir && isPdfName(c.name)).length });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, reload]);

  const close = (result: string | null) => {
    const { resolve } = usePicker.getState();
    usePicker.setState({ open: false, resolve: null });
    resolve?.(result);
  };

  const newFolder = async () => {
    const name = (await promptDialog({ title: 'Neuer Ordner', label: 'Name des Ordners', value: 'Neuer Ordner', ok: 'Erstellen' }))?.trim();
    if (!name) return;
    if (/[\\/]/.test(name)) {
      toast('Der Name darf keinen Schrägstrich enthalten.', 'error');
      return;
    }
    try {
      await syncManager.client()?.mkcol(joinPath(path, name));
      setPath(joinPath(path, name));
    } catch (e) {
      toast(`Ordner konnte nicht erstellt werden: ${e instanceof Error ? e.message : e}`, 'error');
      setReload((n) => n + 1);
    }
  };

  const segments = path ? path.split('/') : [];
  const insideNextNote = joinPath(path) === joinPath(root) || joinPath(path).startsWith(joinPath(root) + '/');
  const blocked = !path ? 'Wähle einen Ordner in deiner Nextcloud.' : insideNextNote ? 'Der NextNote-Ordner selbst kann nicht verwendet werden.' : null;

  return (
    <Modal
      title="PDF-Ordner wählen"
      onClose={() => close(null)}
      className="folder-picker"
      footer={
        <>
          <button type="button" className="btn ghost-left" onClick={() => void newFolder()} disabled={!!error}>
            <FolderPlus size={16} /> Neuer Ordner
          </button>
          <button type="button" className="btn" onClick={() => close(null)}>
            Abbrechen
          </button>
          <button type="button" className="btn primary" disabled={!!blocked || !!error} onClick={() => close(joinPath(path))}>
            Diesen Ordner verwenden
          </button>
        </>
      }
    >
      <p className="hint">Die PDFs dieses Ordners erscheinen im Abschnitt und werden dort auch gespeichert.</p>
      <nav className="folder-crumbs" aria-label="Pfad">
        <button type="button" className="crumb" onClick={() => setPath('')}>
          <HardDrive size={15} /> Nextcloud
        </button>
        {segments.map((seg, i) => (
          <span key={i} className="crumb-wrap">
            <ChevronRight size={14} className="crumb-sep" />
            <button type="button" className="crumb" onClick={() => setPath(segments.slice(0, i + 1).join('/'))}>
              {seg}
            </button>
          </span>
        ))}
      </nav>
      <div className="move-tree folder-list">
        {error && <div className="folder-msg error">{error}</div>}
        {!error && !listing && <div className="folder-msg">Wird geladen …</div>}
        {listing?.folders.map((f) => (
          <button key={f.path} type="button" className="move-item" onClick={() => setPath(joinPath(path, f.name))}>
            <Folder size={16} className="folder-icon" /> <span className="folder-name">{f.name}</span>
            <ChevronRight size={15} className="folder-go" />
          </button>
        ))}
        {listing && !listing.folders.length && <div className="folder-msg">Keine Unterordner</div>}
      </div>
      <p className={`folder-summary${blocked && path ? ' warn' : ''}`}>
        {blocked && path ? (
          blocked
        ) : listing ? (
          <>
            <FileText size={14} /> {listing.pdfs === 0 ? 'Keine PDFs direkt in diesem Ordner' : listing.pdfs === 1 ? '1 PDF direkt in diesem Ordner' : `${listing.pdfs} PDFs direkt in diesem Ordner`}
          </>
        ) : null}
      </p>
    </Modal>
  );
}
