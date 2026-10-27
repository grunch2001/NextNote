import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown, ChevronRight, CloudUpload, FilePlus2, Folder, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { db } from '../db/db';
import { pdfRepo } from '../state/repo';
import type { ID, PdfDoc, Section } from '../model/types';
import { useUI } from '../state/ui';
import { useSync } from '../sync/manager';
import { isPdfDirty, pdfTitle } from '../pdf/repo';
import { openMenu, openMenuAt, type MenuItem } from './Dialogs';
import { addPdfFiles, deletePdf, renamePdf } from './actions';
import { PaneFoot } from './PaneToggles';

type Row = { kind: 'folder'; path: string; name: string; depth: number; count: number } | { kind: 'doc'; doc: PdfDoc; depth: number };

/** Docs are sorted with files before sub folders on every level, so folders can be emitted on the way. */
function treeRows(docs: PdfDoc[], collapsed: Record<string, boolean>, sectionId: ID): Row[] {
  const rows: Row[] = [];
  const folders = new Map<string, Extract<Row, { kind: 'folder' }>>();
  let open: string[] = [];
  for (const doc of docs) {
    const dirs = doc.path.split('/').slice(0, -1);
    let k = 0;
    while (k < open.length && k < dirs.length && open[k] === dirs[k]) k++;
    open = open.slice(0, k);
    for (let i = k; i < dirs.length; i++) {
      open.push(dirs[i]);
      const row: Extract<Row, { kind: 'folder' }> = { kind: 'folder', path: dirs.slice(0, i + 1).join('/'), name: dirs[i], depth: i, count: 0 };
      folders.set(row.path, row);
      rows.push(row);
    }
    for (let i = 1; i <= dirs.length; i++) {
      const f = folders.get(dirs.slice(0, i).join('/'));
      if (f) f.count++;
    }
    rows.push({ kind: 'doc', doc, depth: dirs.length });
  }
  // hide what is inside collapsed folders
  return rows.filter((r) => {
    const segs = (r.kind === 'doc' ? r.doc.path : r.path).split('/');
    for (let i = 1; i < segs.length; i++) if (collapsed[`${sectionId}/${segs.slice(0, i).join('/')}`]) return false;
    return true;
  });
}

function shortDate(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

const indent = (depth: number) => ({ paddingLeft: 10 + depth * 16 });

function DocRow({ doc, depth, active }: { doc: PdfDoc; depth: number; active: boolean }) {
  const items = (): MenuItem[] => [
    { label: 'Umbenennen', icon: <Pencil size={15} />, run: () => void renamePdf(doc.id) },
    { separator: true, label: '' },
    { label: 'Löschen', icon: <Trash2 size={15} />, danger: true, run: () => void deletePdf(doc.id) },
  ];
  const unsaved = isPdfDirty(doc) && !doc.readOnly;
  return (
    <div
      className={`page-row pdf-row${active ? ' active' : ''}`}
      style={indent(depth)}
      role="option"
      aria-selected={active}
      tabIndex={0}
      title={doc.path}
      onClick={() => useUI.getState().openPage(doc.id, doc.sectionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') useUI.getState().openPage(doc.id, doc.sectionId);
        if (e.key === 'F2') void renamePdf(doc.id);
        if (e.key === 'Delete') void deletePdf(doc.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, items());
      }}
    >
      <div className="page-row-text">
        <span className="page-row-title">{pdfTitle(doc.path)}</span>
        <span className="page-row-date">
          {shortDate(doc.lastModified)}
          {doc.pages ? ` · ${doc.pages.length} ${doc.pages.length === 1 ? 'Seite' : 'Seiten'}` : ''}
        </span>
      </div>
      {unsaved && (
        <span className="pdf-row-state" title="Noch nicht in Nextcloud gespeichert" aria-label="Noch nicht in Nextcloud gespeichert">
          <CloudUpload size={14} />
        </span>
      )}
      <button
        type="button"
        className="icon-btn small row-more"
        aria-label="PDF-Optionen"
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

function FolderRow({ row, sectionId, collapsed }: { row: Extract<Row, { kind: 'folder' }>; sectionId: ID; collapsed: boolean }) {
  const toggle = () => useUI.setState((s) => ({ collapsedFolders: { ...s.collapsedFolders, [`${sectionId}/${row.path}`]: !collapsed } }));
  const items = (): MenuItem[] => [{ label: 'PDF hier hinzufügen …', icon: <FilePlus2 size={15} />, run: () => void addPdfFiles(sectionId, row.path) }];
  return (
    <div
      className="page-row pdf-folder-row"
      style={indent(row.depth)}
      role="treeitem"
      aria-expanded={!collapsed}
      tabIndex={0}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') toggle();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, items());
      }}
    >
      <span className="chev">{collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</span>
      <Folder size={15} className="pdf-folder-icon" />
      <span className="nav-label">{row.name}</span>
      <span className="pdf-folder-count">{row.count}</span>
    </div>
  );
}

/** The page list of a PDF section: the PDFs of its Nextcloud folder. */
export function PdfList({ section }: { section: Section }) {
  const pageId = useUI((s) => s.pageId);
  const collapsed = useUI((s) => s.collapsedFolders);
  const docs = useLiveQuery(() => pdfRepo.listDocs(section.id), [section.id]);
  const synced = useLiveQuery(() => db.getKV<number>(`pdfSynced:${section.id}`), [section.id]);
  const syncing = useSync((s) => s.status === 'syncing');
  const progress = useSync((s) => s.progress);
  const connected = useSync((s) => !!s.account);
  const rows = docs ? treeRows(docs, collapsed, section.id) : [];

  let empty: string | null = null;
  if (docs && !docs.length) {
    if (!connected) empty = 'Nicht mit Nextcloud verbunden.';
    else if (!synced) empty = (syncing && progress) || 'Wird aus Nextcloud geladen …';
    else empty = 'In diesem Ordner liegen keine PDFs.';
  }

  return (
    <aside className="page-list" aria-label="PDFs">
      <div className="pane-head" style={{ boxShadow: `inset 0 3px 0 ${section.color}` }}>
        <span className="pane-title">{section.name}</span>
        <button type="button" className="icon-btn small" onClick={() => void addPdfFiles(section.id)} title="PDF hinzufügen" aria-label="PDF hinzufügen">
          <Plus size={16} />
        </button>
      </div>
      <div className="pdf-folder-path" title={`Nextcloud: ${section.pdfFolder}`}>
        <Folder size={13} /> {section.pdfFolder}
      </div>
      <div className="pane-scroll" role="listbox" aria-label="PDFs im Ordner">
        {rows.map((r) =>
          r.kind === 'folder' ? (
            <FolderRow key={`f:${r.path}`} row={r} sectionId={section.id} collapsed={!!collapsed[`${section.id}/${r.path}`]} />
          ) : (
            <DocRow key={r.doc.id} doc={r.doc} depth={r.depth} active={r.doc.id === pageId} />
          ),
        )}
        {empty && <div className="pdf-empty">{empty}</div>}
        <button type="button" className="nav-add" onClick={() => void addPdfFiles(section.id)}>
          <Plus size={14} /> PDF hinzufügen
        </button>
      </div>
      <PaneFoot pane="pages" />
    </aside>
  );
}
