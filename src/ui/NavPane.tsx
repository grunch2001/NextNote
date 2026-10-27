import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen, ChevronDown, ChevronRight, FileStack, FileText, FolderInput, GripVertical, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { db } from '../db/db';
import { repo } from '../state/repo';
import type { ID, Notebook, Section } from '../model/types';
import { NOTEBOOK_COLORS, SECTION_COLORS } from '../model/colors';
import { useUI } from '../state/ui';
import { syncManager } from '../sync/manager';
import { isTouchDevice } from '../platform';
import { openMenu, openMenuAt, type MenuItem } from './Dialogs';
import { deleteNotebook, deleteSection, moveNotebookBefore, movePagesTo, moveSectionTo, newNotebook, newPdfSection, newSection, renameNotebook, renameSection } from './actions';
import { beginDrag, dropClass, useDnd, type DragPayload, type DropTarget } from './dnd';
import { openMoveDialog } from './MoveDialog';
import { PaneFoot } from './PaneToggles';

async function handleDrop(payload: DragPayload, target: DropTarget) {
  if (payload.kind === 'notebook' && target.kind === 'notebook') {
    const list = await repo.listNotebooks();
    const idx = list.findIndex((n) => n.id === target.id);
    const beforeId = target.before ? target.id : (list[idx + 1]?.id ?? null);
    await moveNotebookBefore(payload.id, beforeId === payload.id ? (list[idx + 2]?.id ?? null) : beforeId);
  } else if (payload.kind === 'section') {
    if (target.kind === 'notebook') {
      await moveSectionTo(payload.id, target.id, null);
    } else if (target.kind === 'section') {
      const t = await db.sections.get(target.id);
      if (!t) return;
      const list = (await repo.listSections(t.notebookId)).filter((s) => s.id !== payload.id);
      const idx = list.findIndex((s) => s.id === target.id);
      const beforeId = target.before ? target.id : (list[idx + 1]?.id ?? null);
      await moveSectionTo(payload.id, t.notebookId, beforeId);
    }
  } else if (payload.kind === 'page' && target.kind === 'section') {
    await movePagesTo(payload.id, target.id, null);
  }
}

function SectionRow({ section, active }: { section: Section; active: boolean }) {
  const target = useDnd((s) => s.target);
  const dragging = useDnd((s) => s.payload);
  const items = (): MenuItem[] => [
    { label: 'Umbenennen', icon: <Pencil size={15} />, run: () => void renameSection(section.id) },
    { label: 'Verschieben nach …', icon: <FolderInput size={15} />, run: () => openMoveDialog({ kind: 'section', id: section.id }) },
    { label: 'Abschnittsfarbe', swatches: { colors: SECTION_COLORS, current: section.color, apply: (c) => void repo.updateSection(section.id, { color: c }) } },
    { separator: true, label: '' },
    { label: 'Löschen', icon: <Trash2 size={15} />, danger: true, run: () => void deleteSection(section.id) },
  ];
  return (
    <div
      className={`nav-row section-row${active ? ' active' : ''}${dropClass('section', section.id, target)}${dragging?.id === section.id ? ' dragging' : ''}`}
      data-drop-kind="section"
      data-drop-id={section.id}
      role="treeitem"
      aria-selected={active}
      tabIndex={0}
      onClick={() => useUI.getState().openSection(section.id, section.notebookId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') useUI.getState().openSection(section.id, section.notebookId);
        if (e.key === 'F2') void renameSection(section.id);
      }}
      onDoubleClick={() => void renameSection(section.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, items());
      }}
      onPointerDown={(e) => beginDrag(e, { kind: 'section', id: section.id, label: section.name }, (p, t) => void handleDrop(p, t))}
      title={section.pdfFolder ? `PDF-Ordner in Nextcloud: ${section.pdfFolder}` : undefined}
    >
      <span className="section-tab" style={{ background: section.color }} />
      <span className="nav-label">{section.name}</span>
      {section.pdfFolder && <FileStack size={14} className="section-kind" aria-label="PDF-Ordner" />}
      {isTouchDevice && (
        <span className="drag-handle" aria-hidden="true">
          <GripVertical size={15} />
        </span>
      )}
      <button
        type="button"
        className="icon-btn small row-more"
        aria-label="Abschnittsoptionen"
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

function NotebookBlock({ nb }: { nb: Notebook }) {
  const expanded = useUI((s) => s.expanded[nb.id] ?? false);
  const activeSection = useUI((s) => s.sectionId);
  const activeNb = useUI((s) => s.notebookId);
  const target = useDnd((s) => s.target);
  const sections = useLiveQuery(() => repo.listSections(nb.id), [nb.id]) ?? [];
  const trashCount = useLiveQuery(
    async () =>
      (await db.pages.where('notebookId').equals(nb.id).filter((p) => p.deletedAt !== null).count()) +
      (await db.sections.where('notebookId').equals(nb.id).filter((s) => s.deletedAt !== null).count()),
    [nb.id],
  );
  const toggle = () => useUI.setState((s) => ({ expanded: { ...s.expanded, [nb.id]: !expanded } }));
  const items = (): MenuItem[] => [
    { label: 'Neuer Abschnitt', icon: <Plus size={15} />, run: () => void newSection(nb.id) },
    { label: 'PDF-Ordner aus Nextcloud …', icon: <FileStack size={15} />, run: () => void newPdfSection(nb.id) },
    { label: 'Umbenennen', icon: <Pencil size={15} />, run: () => void renameNotebook(nb.id) },
    { label: 'Jetzt synchronisieren', icon: <RefreshCw size={15} />, run: () => void syncManager.syncNow() },
    { label: `Papierkorb${trashCount ? ` (${trashCount})` : ''}`, icon: <Trash2 size={15} />, run: () => useUI.setState({ recycleBinFor: nb.id }) },
    { label: 'Farbe', swatches: { colors: NOTEBOOK_COLORS, current: nb.color, apply: (c) => void repo.updateNotebook(nb.id, { color: c }) } },
    { separator: true, label: '' },
    { label: 'Notizbuch löschen', icon: <Trash2 size={15} />, danger: true, run: () => void deleteNotebook(nb.id) },
  ];
  return (
    <div className="nb-block" role="group">
      <div
        className={`nav-row notebook-row${activeNb === nb.id && !expanded ? ' active' : ''}${dropClass('notebook', nb.id, target)}`}
        data-drop-kind="notebook"
        data-drop-id={nb.id}
        role="treeitem"
        aria-expanded={expanded}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY, items());
        }}
        onPointerDown={(e) => beginDrag(e, { kind: 'notebook', id: nb.id, label: nb.name }, (p, t) => void handleDrop(p, t))}
      >
        <span className="chev">{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
        <span className="nb-icon" style={{ color: nb.color }}>
          <BookOpen size={17} />
        </span>
        <span className="nav-label strong">{nb.name}</span>
        {isTouchDevice && (
          <span className="drag-handle" aria-hidden="true">
            <GripVertical size={15} />
          </span>
        )}
        <button
          type="button"
          className="icon-btn small row-more"
          aria-label="Notizbuchoptionen"
          onClick={(e) => {
            e.stopPropagation();
            openMenuAt(e.currentTarget, items());
          }}
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
      {expanded && (
        <div className="nb-sections" role="group">
          {sections.map((s) => (
            <SectionRow key={s.id} section={s} active={s.id === activeSection} />
          ))}
          <button
            type="button"
            className="nav-add"
            onClick={(e) =>
              openMenuAt(e.currentTarget, [
                { label: 'Neuer Abschnitt', icon: <FileText size={15} />, run: () => void newSection(nb.id) },
                { label: 'PDF-Ordner aus Nextcloud …', icon: <FileStack size={15} />, run: () => void newPdfSection(nb.id) },
              ])
            }
          >
            <Plus size={14} /> Abschnitt hinzufügen
          </button>
          {!!trashCount && (
            <button type="button" className="nav-add muted" onClick={() => useUI.setState({ recycleBinFor: nb.id })}>
              <Trash2 size={14} /> Papierkorb ({trashCount})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function NavPane() {
  const notebooks = useLiveQuery(() => repo.listNotebooks(), []) ?? [];
  return (
    <nav className="nav-pane" aria-label="Notizbücher">
      <div className="pane-head">
        <span>Notizbücher</span>
        <button type="button" className="icon-btn small" onClick={() => void newNotebook()} title="Neues Notizbuch" aria-label="Neues Notizbuch">
          <Plus size={16} />
        </button>
      </div>
      <div className="pane-scroll" role="tree">
        {notebooks.map((nb) => (
          <NotebookBlock key={nb.id} nb={nb} />
        ))}
        {notebooks.length === 0 && (
          <button type="button" className="nav-add" onClick={() => void newNotebook()}>
            <Plus size={14} /> Notizbuch erstellen
          </button>
        )}
      </div>
      <PaneFoot pane="nav" />
    </nav>
  );
}

export type { ID };
