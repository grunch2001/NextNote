import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { repo } from '../../state/repo';
import { CanvasController } from '../../ink/controller';
import { elementBounds, translateElement, unionRect } from '../../ink/geometry';
import { editorsById, setLastInputKind } from '../../editor/active';
import { paragraphDoc } from '../../model/text';
import type { ID, ImageElement, PageMeta, TextElement } from '../../model/types';
import { debounce, newId, now } from '../../model/util';
import { draftTexts, elementClipboard, measured, pageActions, usePage } from '../../state/page';
import { useUI } from '../../state/ui';
import { syncManager } from '../../sync/manager';
import { createImageElement } from '../assets';
import { isDarkNow } from '../theme';
import { toast } from '../Toasts';
import { consumeFocusTitle } from '../actions';
import { ImageView } from './ImageView';
import { InkLayer } from './InkLayer';
import { copySelection, duplicateSelection, SelectionOverlay } from './SelectionOverlay';
import { TextContainer } from './TextContainer';

const CLIPBOARD_MARKER = '⁣NextNote-Elemente⁣';

/** Shared with the ribbon: inserts content at a sensible place of the current page. */
export const pageApi = {
  viewCenter: (): { x: number; y: number } => ({ x: 60, y: 140 }),
  createTextAt: (_x: number, _y: number, _doc?: TextElement['doc']): ID | null => null,
  insertImages: async (_files: File[], _at?: { x: number; y: number }) => {},
  insertPdf: async (_file: File) => {},
};

function formatPageDate(ts: number) {
  const d = new Date(ts);
  const date = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return { date, time };
}

function PageHeader({ meta }: { meta: PageMeta }) {
  const [title, setTitle] = useState(meta.title);
  const focused = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (consumeFocusTitle()) inputRef.current?.focus();
  }, [meta.id]);
  const saveTitle = useMemo(() => debounce((id: ID, t: string) => void repo.updatePage(id, { title: t }), 400), []);
  useEffect(() => {
    if (!focused.current) setTitle(meta.title);
  }, [meta.title]);
  useEffect(() => () => saveTitle.flush(), [saveTitle, meta.id]);
  const { date, time } = formatPageDate(meta.createdAt);
  return (
    <div className="page-header">
      <input
        ref={inputRef}
        className="page-title"
        value={title}
        placeholder="Seitentitel"
        aria-label="Seitentitel"
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          saveTitle.flush();
        }}
        onChange={(e) => {
          setTitle(e.target.value);
          saveTitle(meta.id, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            saveTitle.flush();
            const texts = Object.values(usePage.getState().elements).filter((x): x is TextElement => x.type === 'text');
            const first = texts.sort((a, b) => a.y - b.y)[0];
            if (first) pageActions.requestFocus({ id: first.id, atEnd: true });
            else pageApi.createTextAt(48, 118);
          }
        }}
      />
      <div className="page-date">
        <span>{date}</span>
        <span>{time}</span>
      </div>
    </div>
  );
}

export function PageView() {
  const pageId = useUI((s) => s.pageId);
  const zoom = useUI((s) => s.zoom);
  const meta = useLiveQuery(() => (pageId ? db.pages.get(pageId) : undefined), [pageId]);
  const elements = usePage((s) => s.elements);
  const loadedId = usePage((s) => s.pageId);
  const selection = usePage((s) => s.selection);
  const drag = usePage((s) => s.drag);
  const measureVersion = usePage((s) => s.measureVersion);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<CanvasController | null>(null);
  const [view, setView] = useState({ w: 800, h: 600 });

  useEffect(() => {
    void pageActions.load(pageId);
  }, [pageId]);

  // keep the open page in sync with remote changes
  useEffect(() => {
    const off1 = syncManager.onAfterSync((report) => {
      const id = usePage.getState().pageId;
      if (id && report.changedPages.has(id)) void pageActions.reloadFromDb();
    });
    const off2 = syncManager.onBeforeSync(() => pageActions.flush());
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') void pageActions.flush();
    };
    document.addEventListener('visibilitychange', flushOnHide);
    window.addEventListener('beforeunload', flushOnHide);
    return () => {
      off1();
      off2();
      document.removeEventListener('visibilitychange', flushOnHide);
      window.removeEventListener('beforeunload', flushOnHide);
    };
  }, []);

  useEffect(() => {
    const s = scrollerRef.current;
    if (!s) return;
    const ro = new ResizeObserver(() => setView({ w: s.clientWidth, h: s.clientHeight }));
    ro.observe(s);
    setView({ w: s.clientWidth, h: s.clientHeight });
    return () => ro.disconnect();
  }, [pageId, !!meta]);

  const createTextAt = useCallback((x: number, y: number, doc?: TextElement['doc']): ID | null => {
    const s = usePage.getState();
    if (!s.pageId) return null;
    // clean up other empty boxes
    const empties = Object.values(s.elements).filter((e) => e.type === 'text' && draftTexts.has(e.id));
    if (empties.length) pageActions.remove(empties.map((e) => e.id), false);
    const ts = now();
    const el: TextElement = {
      id: newId(),
      type: 'text',
      x: Math.max(0, Math.round(x - 6)),
      y: Math.max(0, Math.round(y - 14)),
      w: null,
      z: ts,
      updatedAt: ts,
      doc: doc ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    };
    if (!doc) draftTexts.add(el.id);
    flushSync(() => pageActions.add([el], !!doc));
    const ed = editorsById.get(el.id);
    if (ed) ed.commands.focus('end');
    else pageActions.requestFocus({ id: el.id, atEnd: true });
    setLastInputKind('text');
    return el.id;
  }, []);

  const viewCenter = useCallback(() => {
    const s = scrollerRef.current;
    const c = controllerRef.current;
    if (!s || !c) return { x: 60, y: 140 };
    const r = s.getBoundingClientRect();
    const p = c.toPage(r.left + Math.min(r.width / 2, 360), r.top + Math.min(r.height / 3, 240));
    return { x: Math.max(20, p.x - 100), y: Math.max(110, p.y) };
  }, []);

  const insertImages = useCallback(async (files: File[], at?: { x: number; y: number }) => {
    const nb = usePage.getState().notebookId;
    if (!nb) return;
    let pos = at ?? viewCenter();
    const created: ImageElement[] = [];
    for (const f of files) {
      try {
        const el = await createImageElement(nb, f, pos.x, pos.y);
        created.push(el);
        pos = { x: pos.x, y: pos.y + el.h + 16 };
      } catch (e) {
        toast(`Bild konnte nicht eingefügt werden: ${e instanceof Error ? e.message : e}`, 'error');
      }
    }
    if (created.length) {
      pageActions.add(created);
      pageActions.select(created.map((c) => c.id));
      setLastInputKind('page');
    }
  }, [viewCenter]);

  const insertPdf = useCallback(async (file: File) => {
    const nb = usePage.getState().notebookId;
    const pageAtStart = usePage.getState().pageId;
    if (!nb || !pageAtStart) return;
    toast(`„${file.name}“ wird eingefügt …`);
    try {
      const { renderPdf } = await import('../pdf');
      const pages = await renderPdf(file);
      const all = Object.values(usePage.getState().elements);
      const bottom = unionRect(all.map((el) => elementBounds(el, measured)));
      let y = Math.max(110, bottom ? bottom.y + bottom.h + 32 : 110);
      const created: ImageElement[] = [];
      for (const p of pages) {
        const el = await createImageElement(nb, p.blob, 48, y, Math.round(p.width));
        created.push(el);
        y += el.h + 24;
      }
      if (usePage.getState().pageId !== pageAtStart) return;
      pageActions.add(created);
      setLastInputKind('page');
      toast(pages.length === 1 ? 'PDF-Seite eingefügt' : `${pages.length} PDF-Seiten eingefügt`);
    } catch (e) {
      toast(`PDF konnte nicht eingefügt werden: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }, []);

  useEffect(() => {
    pageApi.createTextAt = createTextAt;
    pageApi.viewCenter = viewCenter;
    pageApi.insertImages = insertImages;
    pageApi.insertPdf = insertPdf;
  }, [createTextAt, viewCenter, insertImages, insertPdf]);

  const onPasteFiles = useCallback(
    (files: File[], afterId: ID) => {
      const el = usePage.getState().elements[afterId];
      const m = measured.get(afterId);
      const at = el && el.type === 'text' ? { x: el.x, y: el.y + (m?.h ?? 30) + 12 } : undefined;
      void insertImages(files, at);
    },
    [insertImages],
  );

  // canvas controller
  useEffect(() => {
    const scroller = scrollerRef.current;
    const page = pageRef.current;
    const canvas = canvasRef.current;
    if (!scroller || !page || !canvas) return;
    const c = new CanvasController({ scroller, page, canvas, isDark: isDarkNow, createTextAt: (x, y) => createTextAt(x, y) });
    controllerRef.current = c;
    return () => {
      c.destroy();
      controllerRef.current = null;
    };
  }, [createTextAt, pageId, !!meta]);

  // keyboard, clipboard, drag & drop
  useEffect(() => {
    const inField = (t: EventTarget | null) => !!(t as Element | null)?.closest?.('.ProseMirror, input, textarea, select, [contenteditable="true"]');
    const onKey = (e: KeyboardEvent) => {
      if (inField(e.target) || document.querySelector('.dialog-backdrop')) return;
      const mod = e.ctrlKey || e.metaKey;
      const sel = usePage.getState().selection;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
        e.preventDefault();
        pageActions.remove(sel);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        pageActions.undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        pageActions.redo();
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        pageActions.select(Object.keys(usePage.getState().elements));
      } else if (mod && e.key.toLowerCase() === 'd' && sel.length) {
        e.preventDefault();
        duplicateSelection();
      } else if (e.key === 'Escape') {
        pageActions.clearSelection();
        useUI.getState().setTool('select');
      } else if (sel.length && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const els = usePage.getState().elements;
        const patches: Record<ID, ReturnType<typeof translateElement>> = {};
        for (const id of sel) if (els[id]) patches[id] = translateElement(els[id], dx, dy);
        pageActions.replace(patches);
      } else if (mod && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        useUI.getState().setZoom(useUI.getState().zoom + 0.1);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        useUI.getState().setZoom(useUI.getState().zoom - 0.1);
      }
    };
    const onCopy = (e: ClipboardEvent) => {
      if (inField(e.target) || !usePage.getState().selection.length) return;
      e.preventDefault();
      copySelection(e.type === 'cut');
      e.clipboardData?.setData('text/plain', CLIPBOARD_MARKER);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e.target) || !usePage.getState().pageId || document.querySelector('.dialog-backdrop')) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      const text = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      if (files.length) {
        void insertImages(files);
      } else if (elementClipboard.length && (text === CLIPBOARD_MARKER || !text)) {
        const ts = now();
        const copies = elementClipboard.map((el, i) => ({ ...translateElement(structuredClone(el), 24, 24), id: newId(), z: ts + i * 1e-3, updatedAt: ts }));
        pageActions.add(copies);
        pageActions.select(copies.map((c) => c.id));
      } else if (text.trim()) {
        const c = viewCenter();
        createTextAt(c.x, c.y, paragraphDoc(text));
      }
    };
    const scroller = scrollerRef.current;
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (e: DragEvent) => {
      const all = Array.from(e.dataTransfer?.files ?? []);
      const pdfs = all.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      if (pdfs.length) {
        e.preventDefault();
        void (async () => {
          for (const f of pdfs) await insertPdf(f);
        })();
        return;
      }
      const files = all.filter((f) => f.type.startsWith('image/'));
      if (!files.length || (e.target as Element).closest('.ProseMirror')) return;
      e.preventDefault();
      const c = controllerRef.current;
      void insertImages(files, c ? c.toPage(e.clientX, e.clientY) : undefined);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    scroller?.addEventListener('dragover', onDragOver);
    scroller?.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
      scroller?.removeEventListener('dragover', onDragOver);
      scroller?.removeEventListener('drop', onDrop);
    };
  }, [createTextAt, insertImages, insertPdf, viewCenter, pageId, !!meta]);

  // scroll to the top when another page opens
  useEffect(() => {
    scrollerRef.current?.scrollTo({ left: 0, top: 0 });
  }, [pageId]);

  const list = useMemo(() => Object.values(elements), [elements]);
  const bounds = useMemo(() => {
    void measureVersion;
    return unionRect(list.map((el) => elementBounds(el, measured)));
  }, [list, measureVersion]);

  const width = Math.max(view.w / zoom, (bounds ? bounds.x + bounds.w : 0) + 320, 860);
  const height = Math.max(view.h / zoom, (bounds ? bounds.y + bounds.h : 0) + 480);
  const sel = useMemo(() => new Set(selection), [selection]);

  if (!pageId) {
    return (
      <div className="page-view empty">
        <div className="page-empty-hint">Wähle links eine Seite aus oder lege eine neue an.</div>
      </div>
    );
  }
  if (meta === undefined) return <div className="page-view" />;
  if (meta === null || !meta) {
    return (
      <div className="page-view empty">
        <div className="page-empty-hint">Diese Seite existiert nicht mehr.</div>
      </div>
    );
  }

  const ready = loadedId === pageId;
  const images = list.filter((e): e is ImageElement => e.type === 'image').sort((a, b) => a.z - b.z);
  const texts = list.filter((e): e is TextElement => e.type === 'text').sort((a, b) => a.z - b.z);

  return (
    <div className="page-view">
      <div className="page-scroller" ref={scrollerRef}>
        <div className="page-sizer" style={{ width: width * zoom, height: height * zoom }}>
          <div
            ref={pageRef}
            className={`page rule-${meta.rule}${meta.bgColor ? ' has-color' : ''}`}
            style={{ width, height, transform: `scale(${zoom})`, ['--page-color' as string]: meta.bgColor ?? undefined }}
          >
            <PageHeader key={meta.id} meta={meta} />
            {ready && images.map((el) => <ImageView key={el.id} el={el} selected={sel.has(el.id)} drag={sel.has(el.id) ? drag : null} />)}
            {ready &&
              texts.map((el) => (
                <TextContainer key={el.id} el={el} selected={sel.has(el.id)} drag={sel.has(el.id) ? drag : null} onPasteFiles={onPasteFiles} />
              ))}
            {ready && <InkLayer width={Math.ceil(width)} height={Math.ceil(height)} />}
            {ready && <SelectionOverlay />}
          </div>
        </div>
      </div>
      <canvas ref={canvasRef} className="live-ink" />
      {zoom !== 1 && (
        <button type="button" className="zoom-badge" onClick={() => useUI.getState().setZoom(1)} title="Zoom zurücksetzen">
          {Math.round(zoom * 100)} %
        </button>
      )}
    </div>
  );
}

/** Focus the editor of a text element if mounted. */
export function focusElement(id: ID) {
  editorsById.get(id)?.commands.focus();
}
