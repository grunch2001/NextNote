import { useLiveQuery } from 'dexie-react-hooks';
import { RotateCcw, Trash2 } from 'lucide-react';
import { db } from '../db/db';
import { repo, } from '../state/repo';
import { TRASH_RETENTION_DAYS } from '../db/repo';
import { useUI } from '../state/ui';
import { confirmDialog, Modal } from './Dialogs';

function daysLeft(deletedAt: number) {
  const left = TRASH_RETENTION_DAYS - Math.floor((Date.now() - deletedAt) / 86400000);
  return Math.max(0, left);
}

export function RecycleBin() {
  const notebookId = useUI((s) => s.recycleBinFor);
  const data = useLiveQuery(async () => {
    if (!notebookId) return null;
    const nb = await db.notebooks.get(notebookId);
    const sections = await db.sections.where('notebookId').equals(notebookId).toArray();
    const sectionById = new Map(sections.map((s) => [s.id, s]));
    const pages = await db.pages.where('notebookId').equals(notebookId).toArray();
    const deletedSections = sections.filter((s) => s.deletedAt !== null);
    const deletedPages = pages.filter((p) => {
      const sec = sectionById.get(p.sectionId);
      return p.deletedAt !== null || !sec;
    });
    return { nb, deletedSections, deletedPages, sectionById, alive: sections.filter((s) => s.deletedAt === null) };
  }, [notebookId]);
  if (!notebookId) return null;
  const close = () => useUI.setState({ recycleBinFor: null });

  const restorePage = async (id: string, sectionId: string) => {
    const sec = data?.sectionById.get(sectionId);
    if (!sec) {
      // section gone: restore into the first section
      const target = data?.alive[0];
      if (!target) return;
      await repo.movePages([id], target.id, null);
    } else if (sec.deletedAt !== null) {
      await repo.restoreSection(sec.id);
    }
    await repo.restorePage(id);
  };

  const empty = (data?.deletedPages.length ?? 0) + (data?.deletedSections.length ?? 0) === 0;
  return (
    <Modal
      title={`Papierkorb – ${data?.nb?.name ?? ''}`}
      onClose={close}
      wide
      footer={
        <>
          {!empty && (
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                if (!(await confirmDialog({ title: 'Papierkorb leeren', message: 'Alle Elemente endgültig löschen?', ok: 'Endgültig löschen', danger: true }))) return;
                for (const p of data?.deletedPages ?? []) await repo.purgePage(p.id);
                for (const s of data?.deletedSections ?? []) await repo.purgeSection(s.id);
              }}
            >
              Papierkorb leeren
            </button>
          )}
          <button type="button" className="btn primary" onClick={close}>
            Fertig
          </button>
        </>
      }
    >
      <p className="hint">Gelöschte Seiten und Abschnitte bleiben {TRASH_RETENTION_DAYS} Tage hier. Endgültig gelöschte Dateien findest du zusätzlich im Papierkorb deiner Nextcloud.</p>
      {empty && <p className="empty-state">Der Papierkorb ist leer.</p>}
      {!!data?.deletedSections.length && <h3 className="list-title">Abschnitte</h3>}
      {data?.deletedSections.map((s) => (
        <div key={s.id} className="bin-row">
          <span className="section-tab" style={{ background: s.color }} />
          <span className="bin-name">{s.name}</span>
          <span className="bin-meta">noch {daysLeft(s.deletedAt ?? Date.now())} Tage</span>
          <button type="button" className="btn small" onClick={() => void repo.restoreSection(s.id)}>
            <RotateCcw size={14} /> Wiederherstellen
          </button>
          <button type="button" className="icon-btn small" aria-label="Endgültig löschen" onClick={() => void repo.purgeSection(s.id)}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {!!data?.deletedPages.length && <h3 className="list-title">Seiten</h3>}
      {data?.deletedPages.map((p) => {
        const sec = data.sectionById.get(p.sectionId);
        return (
          <div key={p.id} className="bin-row">
            <span className="bin-name">{p.title || 'Unbenannte Seite'}</span>
            <span className="bin-meta">
              {sec ? sec.name : 'ohne Abschnitt'}
              {p.deletedAt ? ` · noch ${daysLeft(p.deletedAt)} Tage` : ''}
            </span>
            <button type="button" className="btn small" onClick={() => void restorePage(p.id, p.sectionId)}>
              <RotateCcw size={14} /> Wiederherstellen
            </button>
            <button type="button" className="icon-btn small" aria-label="Endgültig löschen" onClick={() => void repo.purgePage(p.id)}>
              <Trash2 size={15} />
            </button>
          </div>
        );
      })}
    </Modal>
  );
}
