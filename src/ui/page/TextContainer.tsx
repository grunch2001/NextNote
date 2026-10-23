import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { editorExtensions } from '../../editor/extensions';
import { editorsById, getActiveEditor, setActiveEditor, setLastInputKind } from '../../editor/active';
import { isDocEmpty } from '../../model/text';
import type { ID, TextElement } from '../../model/types';
import { draftTexts, pageActions, reportMeasure, usePage, type DragTransform } from '../../state/page';
import { useUI } from '../../state/ui';
import { platform } from '../../platform';

export interface TextContainerProps {
  el: TextElement;
  selected: boolean;
  drag: DragTransform | null;
  onPasteFiles(files: File[], afterId: ID): void;
}

function removeIfEmpty(id: ID) {
  const el = usePage.getState().elements[id];
  if (!el || el.type !== 'text') return;
  const editor = editorsById.get(id);
  if (editor?.isFocused) return;
  if (document.activeElement?.closest('.ribbon, .popover, .dialog')) return;
  if (isDocEmpty(editor ? editor.getJSON() : el.doc)) {
    draftTexts.delete(id);
    pageActions.remove([id], false);
  }
}

function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files).filter((f) => f.type.startsWith('image/'));
}

export const TextContainer = memo(function TextContainer({ el, selected, drag, onPasteFiles }: TextContainerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastDoc = useRef<JSONContent>(el.doc);
  const idRef = useRef(el.id);
  const pasteRef = useRef(onPasteFiles);
  pasteRef.current = onPasteFiles;

  const editor = useEditor(
    {
      extensions: editorExtensions(),
      content: el.doc,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: { class: 'nn-editor', spellcheck: 'true' },
        handlePaste: (_view, event) => {
          const files = imageFiles(event.clipboardData);
          if (files.length === 0) return false;
          pasteRef.current(files, idRef.current);
          return true;
        },
        handleDrop: (_view, event) => {
          const files = imageFiles((event as DragEvent).dataTransfer);
          if (files.length === 0) return false;
          pasteRef.current(files, idRef.current);
          return true;
        },
        handleClickOn: (_view, _pos, node, _nodePos, event) => {
          // open links with Ctrl+click (or a single tap on touch devices)
          const a = (event.target as HTMLElement).closest('a[href]');
          if (a && (event.ctrlKey || event.metaKey || platform.kind === 'android')) {
            event.preventDefault();
            void platform.openExternal((a as HTMLAnchorElement).href);
            return true;
          }
          void node;
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        const doc = ed.getJSON();
        lastDoc.current = doc;
        setLastInputKind('text');
        pageActions.setTextDoc(idRef.current, doc);
      },
      onFocus: ({ editor: ed }) => {
        setActiveEditor(ed, idRef.current);
        setLastInputKind('text');
        pageActions.clearSelection();
      },
      onBlur: () => {
        const id = idRef.current;
        setTimeout(() => removeIfEmpty(id), 200);
      },
    },
    [],
  );

  // apply changes that came from elsewhere (sync, undo of a move does not touch the doc)
  useEffect(() => {
    if (!editor || el.doc === lastDoc.current) return;
    lastDoc.current = el.doc;
    if (!editor.isFocused) editor.commands.setContent(el.doc, { emitUpdate: false });
  }, [el.doc, editor]);

  useLayoutEffect(() => {
    if (!editor) return;
    editorsById.set(el.id, editor);
    return () => {
      editorsById.delete(el.id);
      if (getActiveEditor() === editor) setActiveEditor(null);
    };
  }, [editor, el.id]);

  const focusReq = usePage((s) => (s.focusRequest?.id === el.id ? s.focusRequest : null));
  useEffect(() => {
    if (!focusReq || !editor) return;
    pageActions.requestFocus(null);
    requestAnimationFrame(() => {
      if (focusReq.clientX !== undefined && focusReq.clientY !== undefined) {
        const pos = editor.view.posAtCoords({ left: focusReq.clientX, top: focusReq.clientY });
        editor.chain().focus().setTextSelection(pos?.pos ?? editor.state.doc.content.size).run();
      } else {
        editor.commands.focus(focusReq.atEnd === false ? 'start' : 'end');
      }
    });
  }, [focusReq, editor]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const ro = new ResizeObserver(() => reportMeasure(el.id, node.offsetWidth, node.offsetHeight));
    ro.observe(node);
    reportMeasure(el.id, node.offsetWidth, node.offsetHeight);
    return () => ro.disconnect();
  }, [el.id]);

  const startMove = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const x0 = el.x;
    const y0 = el.y;
    let moved = false;
    pageActions.beginBatch();
    const onMove = (ev: PointerEvent) => {
      const z = useUI.getState().zoom;
      const dx = (ev.clientX - startX) / z;
      const dy = (ev.clientY - startY) / z;
      if (!moved && Math.hypot(dx, dy) < 2) return;
      moved = true;
      pageActions.update({ [el.id]: { x: Math.round(Math.max(0, x0 + dx)), y: Math.round(Math.max(0, y0 + dy)) } });
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      pageActions.endBatch();
      setLastInputKind('page');
      if (!moved) editor?.commands.focus();
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const w0 = ref.current?.offsetWidth ?? 200;
    pageActions.beginBatch();
    const onMove = (ev: PointerEvent) => {
      const z = useUI.getState().zoom;
      pageActions.update({ [el.id]: { w: Math.max(60, Math.round(w0 + (ev.clientX - startX) / z)) } });
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      pageActions.endBatch();
      setLastInputKind('page');
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  let transform: string | undefined;
  if (selected && drag) {
    const tx = (el.x - drag.ox) * drag.s + drag.ox + drag.dx - el.x;
    const ty = (el.y - drag.oy) * drag.s + drag.oy + drag.dy - el.y;
    transform = `translate(${tx}px, ${ty}px)`;
  }

  return (
    <div
      ref={ref}
      className={`text-container${selected ? ' selected' : ''}${el.w ? ' fixed-width' : ''}${el.conflictOf ? ' conflict' : ''}`}
      style={{ left: el.x, top: el.y, width: el.w ?? undefined, transform }}
      data-el={el.id}
    >
      <div className="tc-grip" data-own-pointer onPointerDown={startMove} title="Verschieben">
        <span />
      </div>
      {el.conflictOf && (
        <div className="tc-conflict" data-own-pointer>
          <span>Konfliktkopie – auf einem anderen Gerät gleichzeitig bearbeitet</span>
          <button type="button" onClick={() => pageActions.update({ [el.id]: { conflictOf: undefined } as Partial<TextElement> })}>
            Behalten
          </button>
          <button type="button" onClick={() => pageActions.remove([el.id])}>
            Verwerfen
          </button>
        </div>
      )}
      <EditorContent editor={editor} className="tc-editor" />
      <div className="tc-resize" data-own-pointer onPointerDown={startResize} title="Breite ändern" />
    </div>
  );
});
