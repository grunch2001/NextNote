import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ID, ShapeKind } from '../model/types';

export type Tool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'shape';
export type RibbonTab = 'home' | 'insert' | 'draw' | 'view' | 'table';

export interface PenPreset {
  color: string;
  size: number;
}

export const INK_TOOLS: ReadonlySet<Tool> = new Set(['pen', 'highlighter', 'eraser', 'lasso', 'shape']);

interface UIState {
  notebookId: ID | null;
  sectionId: ID | null;
  pageId: ID | null;
  expanded: Record<ID, boolean>;
  /** Collapsed sub folders of PDF sections, key "<sectionId>/<path>". */
  collapsedFolders: Record<string, boolean>;
  lastPageBySection: Record<ID, ID>;
  lastSectionByNotebook: Record<ID, ID>;
  navOpen: boolean;
  pagesOpen: boolean;
  ribbonTab: RibbonTab;
  ribbonCollapsed: boolean;
  tool: Tool;
  pens: PenPreset[];
  penIndex: number;
  highlighters: PenPreset[];
  highlighterIndex: number;
  shape: Exclude<ShapeKind, 'poly'>;
  eraserMode: 'stroke' | 'point';
  eraserSize: number;
  zoom: number;
  searchOpen: boolean;
  settingsOpen: boolean;
  importOpen: boolean;
  recycleBinFor: ID | null;

  openPage(pageId: ID | null, sectionId?: ID | null, notebookId?: ID | null): void;
  openSection(sectionId: ID | null, notebookId?: ID | null): void;
  setTool(tool: Tool): void;
  setPen(index: number, preset?: Partial<PenPreset>): void;
  setHighlighter(index: number, preset?: Partial<PenPreset>): void;
  setZoom(zoom: number): void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export const useUI = create<UIState>()(
  persist(
    (set, get) => ({
      notebookId: null,
      sectionId: null,
      pageId: null,
      expanded: {},
      collapsedFolders: {},
      lastPageBySection: {},
      lastSectionByNotebook: {},
      navOpen: true,
      pagesOpen: true,
      ribbonTab: 'home',
      ribbonCollapsed: false,
      tool: 'select',
      pens: [
        { color: '#000000', size: 2.5 },
        { color: '#1976D2', size: 2.5 },
        { color: '#D32F2F', size: 2.5 },
        { color: '#388E3C', size: 4 },
      ],
      penIndex: 0,
      highlighters: [
        { color: '#FFF200', size: 16 },
        { color: '#7CFC00', size: 16 },
        { color: '#FF4FD8', size: 16 },
      ],
      highlighterIndex: 0,
      shape: 'line',
      eraserMode: 'stroke',
      eraserSize: 10,
      zoom: 1,
      searchOpen: false,
      settingsOpen: false,
      importOpen: false,
      recycleBinFor: null,

      openPage(pageId, sectionId, notebookId) {
        const s = get();
        const sec = sectionId === undefined ? s.sectionId : sectionId;
        const nb = notebookId === undefined ? s.notebookId : notebookId;
        set({
          pageId,
          sectionId: sec,
          notebookId: nb,
          lastPageBySection: sec && pageId ? { ...s.lastPageBySection, [sec]: pageId } : s.lastPageBySection,
          lastSectionByNotebook: nb && sec ? { ...s.lastSectionByNotebook, [nb]: sec } : s.lastSectionByNotebook,
          expanded: nb ? { ...s.expanded, [nb]: true } : s.expanded,
        });
      },
      openSection(sectionId, notebookId) {
        const s = get();
        const nb = notebookId === undefined ? s.notebookId : notebookId;
        set({
          sectionId,
          notebookId: nb,
          pageId: sectionId ? (s.lastPageBySection[sectionId] ?? null) : null,
          lastSectionByNotebook: nb && sectionId ? { ...s.lastSectionByNotebook, [nb]: sectionId } : s.lastSectionByNotebook,
        });
      },
      setTool(tool) {
        set({ tool });
      },
      setPen(index, preset) {
        const pens = get().pens.slice();
        if (preset) pens[index] = { ...pens[index], ...preset };
        set({ pens, penIndex: index, tool: 'pen' });
      },
      setHighlighter(index, preset) {
        const highlighters = get().highlighters.slice();
        if (preset) highlighters[index] = { ...highlighters[index], ...preset };
        set({ highlighters, highlighterIndex: index, tool: 'highlighter' });
      },
      setZoom(zoom) {
        set({ zoom: Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 100) / 100 });
      },
    }),
    {
      name: 'nextnote.ui',
      version: 1,
      partialize: (s) => ({
        notebookId: s.notebookId,
        sectionId: s.sectionId,
        pageId: s.pageId,
        expanded: s.expanded,
        collapsedFolders: s.collapsedFolders,
        lastPageBySection: s.lastPageBySection,
        lastSectionByNotebook: s.lastSectionByNotebook,
        navOpen: s.navOpen,
        pagesOpen: s.pagesOpen,
        ribbonTab: s.ribbonTab === 'table' ? 'home' : s.ribbonTab,
        ribbonCollapsed: s.ribbonCollapsed,
        pens: s.pens,
        penIndex: s.penIndex,
        highlighters: s.highlighters,
        highlighterIndex: s.highlighterIndex,
        shape: s.shape,
        eraserMode: s.eraserMode,
        eraserSize: s.eraserSize,
        zoom: s.zoom,
      }),
    },
  ),
);

export { MIN_ZOOM, MAX_ZOOM };
