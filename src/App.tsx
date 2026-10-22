import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/db';
import { repo } from './state/repo';
import { useUI } from './state/ui';
import { useSettings } from './state/settings';
import { syncManager } from './sync/manager';
import { platform } from './platform';
import { editorHooks, fontStack } from './editor/extensions';
import { useAssetVersion } from './ui/assets';
import { useApplyTheme } from './ui/theme';
import { TopBar } from './ui/TopBar';
import { Ribbon, insertLink } from './ui/Ribbon';
import { NavPane } from './ui/NavPane';
import { PageList } from './ui/PageList';
import { PaneRail } from './ui/PaneToggles';
import { PageView } from './ui/page/PageView';
import { SearchPanel } from './ui/SearchPanel';
import { SettingsDialog } from './ui/SettingsDialog';
import { RecycleBin } from './ui/RecycleBin';
import { MoveDialog } from './ui/MoveDialog';
import { DialogHost, MenuHost } from './ui/Dialogs';
import { Toasts, toast } from './ui/Toasts';
import { DragGhost } from './ui/dnd';
import { Welcome } from './ui/Welcome';
import { newPage, newSection } from './ui/actions';

/** Keeps notebook/section/page selection valid when things are deleted or arrive via sync. */
function useValidSelection() {
  const state = useLiveQuery(async () => {
    const notebooks = await repo.listNotebooks();
    return { notebooks };
  }, []);
  const notebookId = useUI((s) => s.notebookId);
  const sectionId = useUI((s) => s.sectionId);
  const pageId = useUI((s) => s.pageId);
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    void (async () => {
      const ui = useUI.getState();
      const nbs = state.notebooks;
      if (nbs.length === 0) {
        if (ui.notebookId || ui.pageId) ui.openPage(null, null, null);
        return;
      }
      const nb = nbs.find((n) => n.id === ui.notebookId) ?? nbs[0];
      const sections = await repo.listSections(nb.id);
      const sec = sections.find((s) => s.id === ui.sectionId) ?? sections.find((s) => s.id === ui.lastSectionByNotebook[nb.id]) ?? sections[0] ?? null;
      if (!sec) {
        if (!cancelled && (ui.notebookId !== nb.id || ui.sectionId || ui.pageId)) ui.openPage(null, null, nb.id);
        return;
      }
      const pages = await repo.listPages(sec.id);
      const page = pages.find((p) => p.id === ui.pageId) ?? pages.find((p) => p.id === ui.lastPageBySection[sec.id]) ?? pages[0] ?? null;
      if (cancelled) return;
      if (ui.notebookId !== nb.id || ui.sectionId !== sec.id || ui.pageId !== (page?.id ?? null)) {
        ui.openPage(page?.id ?? null, sec.id, nb.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, notebookId, sectionId, pageId]);
  return state;
}

/** Android back button: close the topmost overlay instead of leaving the app. */
function useBackButton() {
  useEffect(() => {
    platform.onBackButton?.(() => {
      if (document.querySelector('.dialog-backdrop, .context-menu, .popover')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return true;
      }
      const ui = useUI.getState();
      if (ui.searchOpen) {
        useUI.setState({ searchOpen: false });
        return true;
      }
      if (ui.settingsOpen || ui.recycleBinFor) {
        useUI.setState({ settingsOpen: false, recycleBinFor: null });
        return true;
      }
      if (ui.navOpen && window.innerWidth < 900) {
        useUI.setState({ navOpen: false });
        return true;
      }
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && active.closest('.page')) {
        active.blur();
        return true;
      }
      return false;
    });
  }, []);
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 900);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

function useGlobalShortcuts() {
  useEffect(() => {
    editorHooks.onLinkShortcut = () => void insertLink();
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'n' && e.altKey && e.shiftKey) {
        e.preventDefault();
        void newPage({ subpage: true });
      } else if (key === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void newPage();
      } else if (key === 't' && !e.shiftKey) {
        e.preventDefault();
        void newSection();
      } else if (key === 'e' || (key === 'f' && !e.shiftKey)) {
        e.preventDefault();
        useUI.setState({ searchOpen: true });
      } else if (key === 's') {
        e.preventDefault();
        if (syncManager.configured) void syncManager.syncNow();
        else toast('Alles ist lokal gespeichert. Verbinde Nextcloud, um zu synchronisieren.');
      } else if (key === ',') {
        e.preventDefault();
        useUI.setState({ settingsOpen: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  useApplyTheme();
  useGlobalShortcuts();
  useBackButton();
  const state = useValidSelection();
  const narrow = useNarrow();
  const navOpen = useUI((s) => s.navOpen);
  const pagesOpen = useUI((s) => s.pagesOpen);
  const pageId = useUI((s) => s.pageId);
  const searchOpen = useUI((s) => s.searchOpen);
  const defaultFont = useSettings((s) => s.defaultFont);
  const defaultSize = useSettings((s) => s.defaultFontSize);

  useEffect(() => {
    const off = syncManager.onAfterSync((r) => {
      if (r.assetsChanged) useAssetVersion.setState((s) => ({ v: s.v + 1 }));
      if (r.conflicts) toast(`${r.conflicts} gleichzeitige Änderung(en) erkannt – beide Versionen wurden behalten.`);
    });
    return () => {
      off();
    };
  }, []);

  // close the drawer on narrow screens after choosing a page
  useEffect(() => {
    if (narrow) useUI.setState({ navOpen: false });
  }, [pageId, narrow]);

  useEffect(() => {
    document.documentElement.style.setProperty('--default-font', fontStack(defaultFont));
    document.documentElement.style.setProperty('--default-size', `${defaultSize}pt`);
  }, [defaultFont, defaultSize]);

  const hasNotebooks = !!state && state.notebooks.length > 0;
  const loaded = !!state;

  return (
    <div className={`app${narrow ? ' narrow' : ''}`}>
      <TopBar />
      <Ribbon />
      <div className="main">
        {loaded && !hasNotebooks ? (
          <Welcome />
        ) : (
          <>
            {narrow && navOpen && <div className="drawer-backdrop" onClick={() => useUI.setState({ navOpen: false })} />}
            <div className={`panes${navOpen ? ' open' : ''}${narrow ? ' drawer' : ''}`}>
              {!narrow && !navOpen && <PaneRail nav pages={!pagesOpen} />}
              {(navOpen || narrow) && <NavPane />}
              {(pagesOpen || narrow) && (navOpen || !narrow) && <PageList />}
              {!narrow && navOpen && !pagesOpen && <PaneRail pages />}
            </div>
            <PageView />
            {searchOpen && <SearchPanel />}
          </>
        )}
      </div>
      <SettingsDialog />
      <RecycleBin />
      <MoveDialog />
      <DialogHost />
      <MenuHost />
      <DragGhost />
      <Toasts />
    </div>
  );
}

export async function bootstrap() {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // not supported
  }
  await db.open();
  await syncManager.init();
}
