import { useLiveQuery } from 'dexie-react-hooks';
import { CopyPlus, FilePlus2, FolderInput, GripVertical, IndentDecrease, IndentIncrease, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { db } from '../db/db';
import { repo } from '../state/repo';
import type { PageMeta } from '../model/types';
import { useUI } from '../state/ui';
import { isTouchDevice } from '../platform';
import { openMenu, openMenuAt, type MenuItem } from './Dialogs';
import { changeLevel, deletePages, movePagesTo, newPage } from './actions';
import { beginDrag, dropClass, useDnd, type DragPayload, type DropTarget } from './dnd';
import { openMoveDialog } from './MoveDialog';
import { PaneFoot } from './PaneToggles';
import { PdfList } from './PdfList';

function shortDate(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

async function handlePageDrop(payload: DragPayload, target: DropTarget) {
  if (payload.kind !== 'page') return;
  if (target.kind === 'section') {
    await movePagesTo(payload.id, target.id, null);
    return;
  }
  if (target.kind !== 'page') return;
  const t = await db.pages.get(target.id);
  if (!t) return;
  let beforeId: string | null = target.id;
  if (!target.before) {
    const list = await repo.listPages(t.sectionId);
    const idx = list.findIndex((p) => p.id === target.id);
    let end = idx;
    while (end + 1 < list.length && list[end + 1].level > t.level) end++;
    beforeId = list[end + 1]?.id ?? null;
    if (beforeId === payload.id) beforeId = list[end + 2]?.id ?? null;
  }
  await movePagesTo(payload.id, t.sectionId, beforeId);
}

function PageRow({ page, active, first }: { page: PageMeta; active: boolean; first: boolean }) {
  const target = useDnd((s) => s.target);
  const dragging = useDnd((s) => s.payload);
  const items = (): MenuItem[] => [
    { label: 'Neue Unterseite', icon: <FilePlus2 size={15} />, run: () => {
      useUI.getState().openPage(page.id);
      void newPage({ subpage: true });
    } },
    { label: 'Tiefer stufen (Unterseite)', icon: <IndentIncrease size={15} />, disabled: page.level >= 2 || first, run: () => void changeLevel(page.id, 1) },
    { label: 'Höher stufen', icon: <IndentDecrease size={15} />, disabled: page.level === 0, run: () => void changeLevel(page.id, -1) },
    { label: 'Duplizieren', icon: <CopyPlus size={15} />, run: () => void repo.duplicatePage(page.id).then((p) => p && useUI.getState().openPage(p.id)) },
    { label: 'Verschieben nach …', icon: <FolderInput size={15} />, run: () => openMoveDialog({ kind: 'page', id: page.id }) },
    { separator: true, label: '' },
    { label: 'Löschen', icon: <Trash2 size={15} />, danger: true, run: () => void deletePages([page.id]) },
  ];
  return (
    <div
      className={`page-row level-${page.level}${active ? ' active' : ''}${dropClass('page', page.id, target)}${dragging?.id === page.id ? ' dragging' : ''}`}
      data-drop-kind="page"
      data-drop-id={page.id}
      role="option"
      aria-selected={active}
      tabIndex={0}
      onClick={() => useUI.getState().openPage(page.id, page.sectionId, page.notebookId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') useUI.getState().openPage(page.id);
        if (e.key === 'Delete') void deletePages([page.id]);
        if (e.key === 'Tab') {
          e.preventDefault();
          void changeLevel(page.id, e.shiftKey ? -1 : 1);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, items());
      }}
      onPointerDown={(e) => beginDrag(e, { kind: 'page', id: page.id, label: page.title || 'Unbenannte Seite' }, (p, t) => void handlePageDrop(p, t))}
    >
      <div className="page-row-text">
        <span className={`page-row-title${page.title ? '' : ' untitled'}`}>{page.title || 'Unbenannte Seite'}</span>
        <span className="page-row-date">{shortDate(page.updatedAt)}</span>
      </div>
      {isTouchDevice && (
        <span className="drag-handle" aria-hidden="true">
          <GripVertical size={15} />
        </span>
      )}
      <button
        type="button"
        className="icon-btn small row-more"
        aria-label="Seitenoptionen"
        onClick={(e) => {
          e.stopPropagation();
          openMenuAt(e.currentTarget, items());
        }}
      >
        <MoreHorizontal size={15} />
      </button>
    </div>
  );
}

export function PageList() {
  const sectionId = useUI((s) => s.sectionId);
  const pageId = useUI((s) => s.pageId);
  const section = useLiveQuery(() => (sectionId ? db.sections.get(sectionId) : undefined), [sectionId]);
  const pages = useLiveQuery(() => (sectionId ? repo.listPages(sectionId) : Promise.resolve([] as PageMeta[])), [sectionId]) ?? [];

  if (section?.pdfFolder && section.deletedAt === null) return <PdfList section={section} />;
  return (
    <aside className="page-list" aria-label="Seiten">
      <div className="pane-head" style={section ? { boxShadow: `inset 0 3px 0 ${section.color}` } : undefined}>
        <span className="pane-title">{section?.deletedAt === null ? section.name : 'Seiten'}</span>
        <button
          type="button"
          className="icon-btn small"
          onClick={() => void newPage()}
          disabled={!sectionId}
          title="Neue Seite (Strg+N)"
          aria-label="Neue Seite"
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="pane-scroll" role="listbox" aria-label="Seiten im Abschnitt">
        {pages.map((p, i) => (
          <PageRow key={p.id} page={p} active={p.id === pageId} first={i === 0} />
        ))}
        {sectionId && (
          <button type="button" className="nav-add" onClick={() => void newPage()}>
            <Plus size={14} /> Seite hinzufügen
          </button>
        )}
      </div>
      <PaneFoot pane="pages" />
    </aside>
  );
}
