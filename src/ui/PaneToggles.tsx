import { ChevronsLeft, PanelLeft, Rows2 } from 'lucide-react';
import { useUI } from '../state/ui';

/** Bottom bar of a side pane with a button that collapses it (hidden in the narrow drawer). */
export function PaneFoot({ pane }: { pane: 'nav' | 'pages' }) {
  const label = pane === 'nav' ? 'Notizbücher ausblenden' : 'Seitenliste ausblenden';
  return (
    <div className="pane-foot">
      <button
        type="button"
        className="icon-btn small"
        onClick={() => useUI.setState(pane === 'nav' ? { navOpen: false } : { pagesOpen: false })}
        title={label}
        aria-label={label}
      >
        <ChevronsLeft size={16} />
      </button>
    </div>
  );
}

/** Slim strip in place of collapsed side panes, with a button to bring each one back. */
export function PaneRail({ nav = false, pages = false }: { nav?: boolean; pages?: boolean }) {
  return (
    <div className={`pane-rail${nav ? ' nav' : ''}`}>
      {nav && (
        <button type="button" className="icon-btn small" onClick={() => useUI.setState({ navOpen: true })} title="Notizbücher einblenden" aria-label="Notizbücher einblenden">
          <PanelLeft size={16} />
        </button>
      )}
      {pages && (
        <button type="button" className="icon-btn small" onClick={() => useUI.setState({ pagesOpen: true })} title="Seitenliste einblenden" aria-label="Seitenliste einblenden">
          <Rows2 size={16} />
        </button>
      )}
    </div>
  );
}
