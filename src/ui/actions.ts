import { repo } from '../state/repo';
import { db } from '../db/db';
import { useUI } from '../state/ui';
import type { ID } from '../model/types';
import { orderBetween } from '../model/util';
import { confirmDialog, promptDialog } from './Dialogs';
import { toast } from './Toasts';

let focusTitleOnNextPage = false;
export function consumeFocusTitle() {
  const v = focusTitleOnNextPage;
  focusTitleOnNextPage = false;
  return v;
}

export async function newNotebook() {
  const name = await promptDialog({ title: 'Neues Notizbuch', label: 'Name des Notizbuchs', value: 'Neues Notizbuch', ok: 'Erstellen' });
  if (name === null) return;
  const { notebook, section, page } = await repo.createNotebook(name);
  focusTitleOnNextPage = true;
  useUI.getState().openPage(page.id, section.id, notebook.id);
}

export async function newSection(notebookId?: ID | null) {
  const nb = notebookId ?? useUI.getState().notebookId;
  if (!nb) return newNotebook();
  const name = await promptDialog({ title: 'Neuer Abschnitt', label: 'Name des Abschnitts', value: 'Neuer Abschnitt', ok: 'Erstellen' });
  if (name === null) return;
  const section = await repo.createSection(nb, name);
  const page = (await repo.listPages(section.id))[0];
  focusTitleOnNextPage = true;
  useUI.getState().openPage(page?.id ?? null, section.id, nb);
}

export async function newPage(opts: { subpage?: boolean; sectionId?: ID } = {}) {
  const ui = useUI.getState();
  const sectionId = opts.sectionId ?? ui.sectionId;
  if (!sectionId) return newSection();
  let page;
  if (opts.subpage && ui.pageId) {
    const cur = await db.pages.get(ui.pageId);
    page = await repo.createPage(sectionId, { afterId: ui.pageId, level: Math.min(2, (cur?.level ?? 0) + 1) });
  } else {
    page = await repo.createPage(sectionId);
  }
  focusTitleOnNextPage = true;
  ui.openPage(page.id, sectionId);
}

export async function renameNotebook(id: ID) {
  const nb = await db.notebooks.get(id);
  if (!nb) return;
  const name = await promptDialog({ title: 'Notizbuch umbenennen', label: 'Name', value: nb.name, ok: 'Umbenennen' });
  if (name && name.trim()) await repo.updateNotebook(id, { name: name.trim() });
}

export async function renameSection(id: ID) {
  const s = await db.sections.get(id);
  if (!s) return;
  const name = await promptDialog({ title: 'Abschnitt umbenennen', label: 'Name', value: s.name, ok: 'Umbenennen' });
  if (name && name.trim()) await repo.updateSection(id, { name: name.trim() });
}

export async function deleteNotebook(id: ID) {
  const nb = await db.notebooks.get(id);
  if (!nb) return;
  const ok = await confirmDialog({
    title: 'Notizbuch löschen',
    message: `„${nb.name}“ wird auf allen Geräten gelöscht. In Nextcloud landet der Ordner im Papierkorb und kann dort wiederhergestellt werden.`,
    ok: 'Löschen',
    danger: true,
  });
  if (!ok) return;
  const ui = useUI.getState();
  if (ui.notebookId === id) ui.openPage(null, null, null);
  await repo.deleteNotebook(id);
  toast(`Notizbuch „${nb.name}“ gelöscht`);
}

export async function deleteSection(id: ID) {
  const s = await db.sections.get(id);
  if (!s) return;
  await repo.trashSection(id);
  const ui = useUI.getState();
  if (ui.sectionId === id) {
    const rest = await repo.listSections(s.notebookId);
    ui.openSection(rest[0]?.id ?? null, s.notebookId);
  }
  toast(`Abschnitt „${s.name}“ in den Papierkorb verschoben`, 'info', { label: 'Rückgängig', run: () => void repo.restoreSection(id) });
}

export async function deletePages(ids: ID[]) {
  if (!ids.length) return;
  const first = await db.pages.get(ids[0]);
  if (!first) return;
  const siblings = await repo.listPages(first.sectionId);
  for (const id of ids) await repo.trashPage(id);
  const ui = useUI.getState();
  if (ui.pageId && ids.includes(ui.pageId)) {
    const idx = siblings.findIndex((p) => p.id === ui.pageId);
    const next = siblings.slice(idx + 1).find((p) => !ids.includes(p.id)) ?? siblings.slice(0, idx).reverse().find((p) => !ids.includes(p.id));
    ui.openPage(next?.id ?? null);
  }
  toast(ids.length === 1 ? 'Seite in den Papierkorb verschoben' : `${ids.length} Seiten in den Papierkorb verschoben`, 'info', {
    label: 'Rückgängig',
    run: () => {
      for (const id of ids) void repo.restorePage(id);
    },
  });
}

/** A page plus the sub pages directly following it. */
export async function pageGroup(pageId: ID): Promise<ID[]> {
  const p = await db.pages.get(pageId);
  if (!p) return [];
  const pages = await repo.listPages(p.sectionId);
  const idx = pages.findIndex((x) => x.id === pageId);
  const out = [pageId];
  for (let i = idx + 1; i < pages.length && pages[i].level > p.level; i++) out.push(pages[i].id);
  return out;
}

export async function changeLevel(pageId: ID, delta: number) {
  const group = await pageGroup(pageId);
  const pages = await db.pages.bulkGet(group);
  for (const p of pages) if (p) await repo.updatePage(p.id, { level: Math.max(0, Math.min(2, p.level + delta)) });
}

export async function moveSectionTo(sectionId: ID, notebookId: ID, beforeId: ID | null) {
  const s = await db.sections.get(sectionId);
  if (!s) return;
  if (s.notebookId !== notebookId) await repo.moveSectionToNotebook(sectionId, notebookId);
  const list = (await repo.listSections(notebookId)).filter((x) => x.id !== sectionId);
  const idx = beforeId ? list.findIndex((x) => x.id === beforeId) : list.length;
  const i = idx < 0 ? list.length : idx;
  await repo.updateSection(sectionId, { order: orderBetween(list[i - 1]?.order, list[i]?.order) });
  const ui = useUI.getState();
  if (ui.sectionId === sectionId) ui.openSection(sectionId, notebookId);
}

export async function moveNotebookBefore(id: ID, beforeId: ID | null) {
  const list = (await repo.listNotebooks()).filter((n) => n.id !== id);
  const idx = beforeId ? list.findIndex((x) => x.id === beforeId) : list.length;
  const i = idx < 0 ? list.length : idx;
  await repo.updateNotebook(id, { order: orderBetween(list[i - 1]?.order, list[i]?.order) });
}

export async function movePagesTo(pageId: ID, sectionId: ID, beforeId: ID | null) {
  const group = await pageGroup(pageId);
  if (beforeId && group.includes(beforeId)) return;
  const metas = await db.pages.bulkGet(group);
  const base = metas[0]?.level ?? 0;
  const target = await db.sections.get(sectionId);
  await repo.movePages(group, sectionId, beforeId, metas.map((m) => Math.max(0, (m?.level ?? 0) - (beforeId ? 0 : base))));
  const ui = useUI.getState();
  if (ui.pageId && group.includes(ui.pageId) && target) ui.openPage(ui.pageId, sectionId, target.notebookId);
}
