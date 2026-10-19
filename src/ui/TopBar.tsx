import { useEffect } from 'react';
import { ChevronUp, CloudAlert, CloudCheck, CloudOff, Menu, RefreshCw, Search, Settings } from 'lucide-react';
import { useUI, type RibbonTab } from '../state/ui';
import { syncManager, useSync } from '../sync/manager';
import { useInTable } from './Ribbon';

const TABS: Array<{ id: RibbonTab; label: string }> = [
  { id: 'home', label: 'Start' },
  { id: 'insert', label: 'Einfügen' },
  { id: 'draw', label: 'Zeichnen' },
  { id: 'view', label: 'Ansicht' },
];

function SyncIndicator() {
  const { status, progress, lastError, lastSync, account } = useSync();
  let icon = <CloudCheck size={18} />;
  let title = 'Synchronisiert';
  let cls = 'ok';
  if (status === 'disabled') {
    icon = <CloudOff size={18} />;
    title = 'Nicht mit Nextcloud verbunden – klicken zum Verbinden';
    cls = 'off';
  } else if (status === 'syncing') {
    icon = <RefreshCw size={18} className="spin" />;
    title = progress || 'Synchronisiere …';
    cls = 'busy';
  } else if (status === 'offline') {
    icon = <CloudOff size={18} />;
    title = `Offline – Änderungen werden später übertragen${lastError ? `\n${lastError}` : ''}`;
    cls = 'warn';
  } else if (status === 'error' || status === 'auth') {
    icon = <CloudAlert size={18} />;
    title = lastError ?? 'Fehler bei der Synchronisierung';
    cls = 'error';
  } else if (lastSync) {
    title = `Synchronisiert mit ${account?.server ?? 'Nextcloud'} – ${new Date(lastSync).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return (
    <button
      type="button"
      className={`icon-btn sync-indicator ${cls}`}
      title={title}
      aria-label={title}
      onClick={() => {
        if (status === 'disabled' || status === 'auth' || status === 'error') useUI.setState({ settingsOpen: true });
        else void syncManager.syncNow();
      }}
    >
      {icon}
      {status === 'syncing' && progress && <span className="sync-progress">{progress}</span>}
    </button>
  );
}

export function TopBar() {
  const tab = useUI((s) => s.ribbonTab);
  const collapsed = useUI((s) => s.ribbonCollapsed);
  const navOpen = useUI((s) => s.navOpen);
  const inTable = useInTable();
  const effectiveTab = tab === 'table' && !inTable ? 'home' : tab;
  const select = (id: RibbonTab) => useUI.setState({ ribbonTab: id, ribbonCollapsed: false });
  const toggleCollapse = () => useUI.setState((s) => ({ ribbonCollapsed: !s.ribbonCollapsed }));
  useEffect(() => {
    if (tab === 'table' && !inTable) useUI.setState({ ribbonTab: 'home' });
  }, [tab, inTable]);
  return (
    <header className="topbar">
      <button
        type="button"
        className={`icon-btn nav-toggle${navOpen ? ' active' : ''}`}
        onClick={() => useUI.setState((s) => ({ navOpen: !s.navOpen }))}
        aria-label="Navigation ein-/ausblenden"
        title="Notizbücher und Seiten"
      >
        <Menu size={19} />
      </button>
      <div className="brand" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="22" height="22">
          <rect x="2" y="2" width="28" height="28" rx="7" fill="#7A3FB8" />
          <path d="M10 23V9h2.6l6.8 9.6V9H22v14h-2.6l-6.8-9.6V23z" fill="#fff" />
        </svg>
      </div>
      <nav className="tabs" role="tablist" aria-label="Menüband-Reiter">
        <button type="button" role="tab" className="tab file" onClick={() => useUI.setState({ settingsOpen: true })}>
          Datei
        </button>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={effectiveTab === t.id}
            className={`tab${effectiveTab === t.id && !collapsed ? ' active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => select(t.id)}
            onDoubleClick={toggleCollapse}
          >
            {t.label}
          </button>
        ))}
        {inTable && (
          <button type="button" role="tab" aria-selected={effectiveTab === 'table'} className={`tab contextual${effectiveTab === 'table' && !collapsed ? ' active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => select('table')}>
            Tabelle
          </button>
        )}
        {!collapsed && (
          <button type="button" className="icon-btn small collapse-ribbon" onClick={() => useUI.setState({ ribbonCollapsed: true })} aria-label="Menüband ausblenden" title="Menüband ausblenden">
            <ChevronUp size={15} />
          </button>
        )}
      </nav>
      <div className="topbar-right">
        <button type="button" className="search-trigger" onClick={() => useUI.setState((s) => ({ searchOpen: !s.searchOpen }))} title="Suchen (Strg+E)">
          <Search size={16} />
          <span>Suchen</span>
        </button>
        <SyncIndicator />
        <button type="button" className="icon-btn" onClick={() => useUI.setState({ settingsOpen: true })} aria-label="Einstellungen" title="Einstellungen">
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}
