import { BookPlus, RefreshCw } from 'lucide-react';
import { repo } from '../state/repo';
import { useUI } from '../state/ui';
import { useSync } from '../sync/manager';
import { ConnectForm } from './SettingsDialog';

async function startLocal() {
  const { notebook, section, page } = await repo.createNotebook('Mein Notizbuch');
  useUI.getState().openPage(page.id, section.id, notebook.id);
}

export function Welcome() {
  const account = useSync((s) => s.account);
  const status = useSync((s) => s.status);
  return (
    <div className="welcome">
      <div className="welcome-card">
        <svg viewBox="0 0 32 32" width="56" height="56" aria-hidden="true">
          <rect x="2" y="2" width="28" height="28" rx="7" fill="#7A3FB8" />
          <path d="M10 23V9h2.6l6.8 9.6V9H22v14h-2.6l-6.8-9.6V23z" fill="#fff" />
        </svg>
        <h1>Willkommen bei NextNote</h1>
        {account ? (
          <>
            <p>
              Verbunden mit <strong>{account.server}</strong>.{' '}
              {status === 'syncing' ? 'Deine Notizbücher werden geladen …' : 'In deinem Ordner gibt es noch keine Notizbücher.'}
            </p>
            {status === 'syncing' ? (
              <RefreshCw className="spin" size={28} />
            ) : (
              <button type="button" className="btn primary wide" onClick={() => void startLocal()}>
                <BookPlus size={16} /> Erstes Notizbuch anlegen
              </button>
            )}
          </>
        ) : (
          <>
            <p>Deine Notizbücher mit freier Seite, Text, Bildern und Stifteingabe – gespeichert und synchronisiert über deine eigene Nextcloud.</p>
            <ConnectForm />
            <div className="or">oder</div>
            <button type="button" className="btn wide" onClick={() => void startLocal()}>
              <BookPlus size={16} /> Erst einmal ohne Nextcloud starten
            </button>
          </>
        )}
      </div>
    </div>
  );
}
