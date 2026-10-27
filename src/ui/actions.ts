import { pdfRepo, repo } from '../state/repo';
import { db } from '../db/db';
import { useUI } from '../state/ui';
import type { ID } from '../model/types';
import { orderBetween } from '../model/util';
import { syncManager } from '../sync/manager';
import { joinPath } from '../sync/webdav';
import { isPdfName, pdfTitle } from '../pdf/repo';
import { confirmDialog, promptDialog } from './Dialogs';
import { pickNextcloudFolder } from './FolderPicker';
import { pickFiles } from './assets';
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

/** A section that shows the PDFs of a Nextcloud folder. */
export async function newPdfSection(notebookId?: ID | null) {
  const nb = notebookId ?? useUI.getState().notebookId;
  if (!nb) return newNotebook();
  if (!syncManager.configured) {
    toast('Verbinde NextNote zuerst in den Einstellungen mit deiner Nextcloud.', 'error');
    return;
  }
  const folder = await pickNextcloudFolder();
  if (folder === null) return;
  const name = folder.split('/').at(-1) || 'PDFs';
  const section = await repo.createSection(nb, name, { pdfFolder: folder });
  useUI.getState().openSection(section.id, nb);
  toast(`Der Ordner „${folder}“ wird eingelesen. Eine PDF wird erst geladen, wenn du sie öffnest.`);
  void syncManager.syncNow();
}

/** Adds PDFs from this device to the Nextcloud folder of a PDF section (optionally into a sub folder). */
export async function addPdfFiles(sectionId: ID, folder = '') {
  const files = (await pickFiles('application/pdf,.pdf', { multiple: true })).filter((f) => isPdfName(f.name) || f.type === 'application/pdf');
  if (!files.length) return;
  let first: ID | null = null;
  for (const f of files) {
    try {
      const doc = await pdfRepo.addFile(sectionId, f.name, new Uint8Array(await f.arrayBuffer()), folder);
      first ??= doc.id;
    } catch (e) {
      toast(`„${f.name}“ konnte nicht hinzugefügt werden: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }
  if (first) useUI.getState().openPage(first, sectionId);
  void syncManager.syncNow();
}

export async function renamePdf(id: ID) {
  const doc = await pdfRepo.getDoc(id);
  const section = doc && (await db.sections.get(doc.sectionId));
  if (!doc || !section?.pdfFolder) return;
  const name = (await promptDialog({ title: 'PDF umbenennen', label: 'Name', value: pdfTitle(doc.path), ok: 'Umbenennen' }))?.trim();
  if (!name || name === pdfTitle(doc.path)) return;
  if (/[\/:*?"<>|]/.test(name)) {
    toast('Der Name darf keines dieser Zeichen enthalten: \\ / : * ? " < > |', 'error');
    return;
  }
  const dir = doc.path.split('/').slice(0, -1).join('/');
  const path = joinPath(dir, isPdfName(name) ? name : `${name}.pdf`);
  if (doc.etag === null) {
    // not uploaded yet: it gets the new name with the upload
    await pdfRepo.setPath(id, path);
    return;
  }
  const client = syncManager.client();
  if (!client) {
    toast('Umbenennen geht nur mit Verbindung zu Nextcloud.', 'error');
    return;
  }
  try {
    if (!(await client.move(joinPath(section.pdfFolder, doc.path), joinPath(section.pdfFolder, path)))) {
      toast(`Eine Datei „${pdfTitle(path)}“ gibt es in diesem Ordner schon.`, 'error');
      return;
    }
    await pdfRepo.setPath(id, path);
    void syncManager.syncNow();
  } catch (e) {
    toast(`Umbenennen hat nicht geklappt: ${e instanceof Error ? e.message : e}`, 'error');
  }
}

export async function deletePdf(id: ID) {
  const doc = await pdfRepo.getDoc(id);
  if (!doc) return;
  const ok = await confirmDialog({
    title: 'PDF löschen',
    message: `„${pdfTitle(doc.path)}“ wird aus dem Nextcloud-Ordner gelöscht, auf allen Geräten. In Nextcloud landet die Datei im Papierkorb und kann dort wiederhergestellt werden.`,
    ok: 'Löschen',
    danger: true,
  });
  if (!ok) return;
  const siblings = await pdfRepo.listDocs(doc.sectionId);
  await pdfRepo.trash(id);
  const ui = useUI.getState();
  if (ui.pageId === id) {
    const idx = siblings.findIndex((d) => d.id === id);
    ui.openPage((siblings[idx + 1] ?? siblings[idx - 1])?.id ?? null);
  }
  void syncManager.syncNow();
}

export async function newPage(opts: { subpage?: boolean; sectionId?: ID } = {}) {
  const ui = useUI.getState();
  const sectionId = opts.sectionId ?? ui.sectionId;
  if (!sectionId) return newSection();
  // a PDF section has no pages, only the PDFs of its folder
  if ((await db.sections.get(sectionId))?.pdfFolder) return addPdfFiles(sectionId);
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

/** Hides a notebook on this device; it is no longer synced and its PDFs are not kept here. */
export async function closeNotebook(id: ID) {
  const nb = await db.notebooks.get(id);
  if (!nb) return;
  const ui = useUI.getState();
  if (ui.notebookId === id) {
    const other = (await repo.listNotebooks()).find((n) => n.id !== id);
    ui.openPage(null, null, other?.id ?? null);
  }
  // bring the last changes to Nextcloud first
  if (syncManager.configured) await syncManager.syncFresh({ force: true });
  const { keptPdfs } = await repo.closeNotebook(id);
  const pending = syncManager.configured && ((await db.kv.get(`dirty:${id}`)) !== undefined || keptPdfs > 0);
  toast(
    pending
      ? `„${nb.name}“ geschlossen. Noch nicht synchronisierte Änderungen werden hochgeladen, sobald du es wieder öffnest.`
      : `„${nb.name}“ geschlossen. Du findest es unter „Notizbuch öffnen“.`,
    'info',
    { label: 'Rückgängig', run: () => void reopenNotebook(id) },
  );
}

/** Shows a closed notebook again and brings it up to date. */
export async function reopenNotebook(id: ID) {
  const nb = await db.notebooks.get(id);
  if (!nb) return;
  await repo.reopenNotebook(id);
  useUI.setState((s) => ({ expanded: { ...s.expanded, [id]: true } }));
  useUI.getState().openPage(null, null, id);
  if (syncManager.configured) {
    toast(`„${nb.name}“ wird mit Nextcloud abgeglichen …`);
    void syncManager.syncNow();
  }
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
  const msg = s.pdfFolder ? `Abschnitt „${s.name}“ in den Papierkorb verschoben. Die PDFs bleiben in Nextcloud.` : `Abschnitt „${s.name}“ in den Papierkorb verschoben`;
  toast(msg, 'info', { label: 'Rückgängig', run: () => void repo.restoreSection(id) });
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
  const target = await db.sections.get(sectionId);
  if (target?.pdfFolder) {
    toast('In einen PDF-Ordner lassen sich keine Seiten verschieben.');
    return;
  }
  const group = await pageGroup(pageId);
  if (beforeId && group.includes(beforeId)) return;
  const metas = await db.pages.bulkGet(group);
  const base = metas[0]?.level ?? 0;
  await repo.movePages(group, sectionId, beforeId, metas.map((m) => Math.max(0, (m?.level ?? 0) - (beforeId ? 0 : base))));
  const ui = useUI.getState();
  if (ui.pageId && group.includes(ui.pageId) && target) ui.openPage(ui.pageId, sectionId, target.notebookId);
}
