import { useState } from 'react';
import { create } from 'zustand';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen } from 'lucide-react';
import { db } from '../db/db';
import { repo } from '../state/repo';
import type { ID } from '../model/types';
import { Modal } from './Dialogs';
import { movePagesTo, moveSectionTo } from './actions';
import { toast } from './Toasts';

type MoveTarget = { kind: 'page' | 'section'; id: ID };

const useMove = create<{ item: MoveTarget | null }>(() => ({ item: null }));

export function openMoveDialog(item: MoveTarget) {
  useMove.setState({ item });
}

export function MoveDialog() {
  const item = useMove((s) => s.item);
  const [choice, setChoice] = useState<ID | null>(null);
  const tree = useLiveQuery(async () => {
    const nbs = await repo.listNotebooks();
    return Promise.all(nbs.map(async (nb) => ({ nb, sections: await repo.listSections(nb.id) })));
  }, []);
  const label = useLiveQuery(async () => {
    if (!item) return '';
    if (item.kind === 'page') return (await db.pages.get(item.id))?.title || 'Unbenannte Seite';
    return (await db.sections.get(item.id))?.name ?? '';
  }, [item?.id]);
  if (!item) return null;
  const close = () => {
    setChoice(null);
    useMove.setState({ item: null });
  };
  const run = async () => {
    if (!choice) return;
    if (item.kind === 'page') {
      await movePagesTo(item.id, choice, null);
      toast('Seite verschoben');
    } else {
      await moveSectionTo(item.id, choice, null);
      toast('Abschnitt verschoben');
    }
    close();
  };
  return (
    <Modal
      title={item.kind === 'page' ? `„${label}“ verschieben` : `Abschnitt „${label}“ verschieben`}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Abbrechen
          </button>
          <button type="button" className="btn primary" disabled={!choice} onClick={() => void run()}>
            Verschieben
          </button>
        </>
      }
    >
      <p className="hint">{item.kind === 'page' ? 'Wähle den Zielabschnitt:' : 'Wähle das Zielnotizbuch:'}</p>
      <div className="move-tree">
        {tree?.map(({ nb, sections }) =>
          item.kind === 'section' ? (
            <button key={nb.id} type="button" className={`move-item${choice === nb.id ? ' active' : ''}`} onClick={() => setChoice(nb.id)}>
              <BookOpen size={16} style={{ color: nb.color }} /> {nb.name}
            </button>
          ) : (
            <div key={nb.id} className="move-group">
              <div className="move-group-title">
                <BookOpen size={16} style={{ color: nb.color }} /> {nb.name}
              </div>
              {/* pages cannot go into a PDF section */}
              {sections
                .filter((s) => !s.pdfFolder)
                .map((s) => (
                  <button key={s.id} type="button" className={`move-item indent${choice === s.id ? ' active' : ''}`} onClick={() => setChoice(s.id)}>
                    <span className="section-tab" style={{ background: s.color }} /> {s.name}
                  </button>
                ))}
            </div>
          ),
        )}
      </div>
    </Modal>
  );
}
