import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useUI } from '../state/ui';

/**
 * Bottom bar of a side pane (hidden in the narrow drawer). The notebook pane holds the one
 * button that collapses the notebooks and the page list together, at the left edge where
 * the rail's button brings them back.
 */
export function PaneFoot({ pane }: { pane: 'nav' | 'pages' }) {
  const label = 'Notizbücher und Seitenliste ausblenden';
  return (
    <div className="pane-foot">
      {pane === 'nav' && (
        <button type="button" className="icon-btn small" onClick={() => useUI.setState({ navOpen: false, pagesOpen: false })} title={label} aria-label={label}>
          <ChevronsLeft size={16} />
        </button>
      )}
    </div>
  );
}

/** Slim strip in place of the collapsed side panes, with one button that brings both back. */
export function PaneRail() {
  const label = 'Notizbücher und Seitenliste einblenden';
  return (
    <div className="pane-rail nav">
      <button type="button" className="icon-btn small" onClick={() => useUI.setState({ navOpen: true, pagesOpen: true })} title={label} aria-label={label}>
        <ChevronsRight size={16} />
      </button>
    </div>
  );
}
