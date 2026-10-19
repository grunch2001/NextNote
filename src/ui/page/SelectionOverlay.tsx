import { useMemo, useState } from 'react';
import { Copy, CopyPlus, Palette, Scissors, Trash2 } from 'lucide-react';
import { elementBounds, translateElement, unionRect } from '../../ink/geometry';
import { setLastInputKind } from '../../editor/active';
import { INK_COLORS } from '../../model/colors';
import type { PageElement } from '../../model/types';
import { newId, now } from '../../model/util';
import { measured, pageActions, usePage } from '../../state/page';
import { copyElements } from '../clipboard';
import { toast } from '../Toasts';
import { isTouchDevice } from '../../platform';
import { useUI } from '../../state/ui';

export function duplicateSelection() {
  const { selection, elements } = usePage.getState();
  const ts = now();
  const copies: PageElement[] = selection
    .map((id) => elements[id])
    .filter(Boolean)
    .map((el, i) => ({ ...translateElement(structuredClone(el), 24, 24), id: newId(), z: ts + i * 1e-3, updatedAt: ts }));
  pageActions.add(copies);
  pageActions.select(copies.map((c) => c.id));
}

export function copySelection(cut = false) {
  const { selection, elements } = usePage.getState();
  const els = selection.map((id) => elements[id]).filter(Boolean);
  void copyElements(els);
  if (cut) pageActions.remove(selection);
  const how = isTouchDevice ? 'lange auf eine freie Stelle drücken' : 'Rechtsklick auf eine freie Stelle oder Strg+V';
  toast(`${cut ? 'Ausgeschnitten' : 'Kopiert'} – zum Einfügen ${how}`);
}

export function SelectionOverlay() {
  const selection = usePage((s) => s.selection);
  const elements = usePage((s) => s.elements);
  const drag = usePage((s) => s.drag);
  const measureVersion = usePage((s) => s.measureVersion);
  const zoom = useUI((s) => s.zoom);
  const [colorsOpen, setColorsOpen] = useState(false);

  const rect = useMemo(() => {
    void measureVersion;
    const rects = selection.map((id) => elements[id]).filter(Boolean).map((el) => elementBounds(el, measured));
    return unionRect(rects);
  }, [selection, elements, measureVersion]);

  if (!rect || selection.length === 0) return null;
  const hasInk = selection.some((id) => elements[id]?.type === 'ink');

  let r = rect;
  if (drag) {
    r = {
      x: (rect.x - drag.ox) * drag.s + drag.ox + drag.dx,
      y: (rect.y - drag.oy) * drag.s + drag.oy + drag.dy,
      w: rect.w * drag.s,
      h: rect.h * drag.s,
    };
  }
  const pad = 6 / zoom;

  const startMove = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('.sel-toolbar, .sel-handle')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    pageActions.setDrag({ dx: 0, dy: 0, s: 1, ox: 0, oy: 0 });
    const onMove = (ev: PointerEvent) => {
      const z = useUI.getState().zoom;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      pageActions.setDrag({ dx: (ev.clientX - sx) / z, dy: (ev.clientY - sy) / z, s: 1, ox: 0, oy: 0 });
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      if (moved) {
        pageActions.commitDrag();
        setLastInputKind('page');
      } else {
        pageActions.setDrag(null);
        // a click on a single selected text box starts editing it
        const only = selection.length === 1 ? elements[selection[0]] : null;
        if (only?.type === 'text') {
          pageActions.clearSelection();
          pageActions.requestFocus({ id: only.id, clientX: sx, clientY: sy });
        }
      }
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const startScale = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const ox = rect.x;
    const oy = rect.y;
    const base = Math.max(1, rect.w + rect.h);
    const page = target.closest('.page') as HTMLElement;
    const onMove = (ev: PointerEvent) => {
      const z = useUI.getState().zoom;
      const pr = page.getBoundingClientRect();
      const px = (ev.clientX - pr.left) / z;
      const py = (ev.clientY - pr.top) / z;
      const s = Math.max(0.1, (px - ox + (py - oy)) / base);
      pageActions.setDrag({ dx: 0, dy: 0, s, ox, oy });
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      pageActions.commitDrag();
      setLastInputKind('page');
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const recolor = (color: string) => {
    const patches: Record<string, Partial<PageElement>> = {};
    for (const id of selection) if (elements[id]?.type === 'ink') patches[id] = { color };
    pageActions.update(patches);
    setColorsOpen(false);
  };

  return (
    <div
      className="sel-box"
      data-own-pointer
      style={{ left: r.x - pad, top: r.y - pad, width: r.w + pad * 2, height: r.h + pad * 2, borderWidth: 1.5 / zoom }}
      onPointerDown={startMove}
    >
      {!drag && (
        <div className="sel-toolbar" style={{ transform: `scale(${1 / zoom})` }} onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" title="Löschen (Entf)" onClick={() => pageActions.remove(selection)}>
            <Trash2 size={16} />
          </button>
          <button type="button" title="Ausschneiden" onClick={() => copySelection(true)}>
            <Scissors size={16} />
          </button>
          <button type="button" title="Kopieren" onClick={() => copySelection(false)}>
            <Copy size={16} />
          </button>
          <button type="button" title="Duplizieren" onClick={duplicateSelection}>
            <CopyPlus size={16} />
          </button>
          {hasInk && (
            <button type="button" title="Farbe ändern" onClick={() => setColorsOpen((v) => !v)} className={colorsOpen ? 'active' : ''}>
              <Palette size={16} />
            </button>
          )}
          {colorsOpen && (
            <div className="sel-colors">
              {INK_COLORS.map((c) => (
                <button key={c} type="button" className="swatch" style={{ background: c }} onClick={() => recolor(c)} aria-label={c} />
              ))}
            </div>
          )}
        </div>
      )}
      <div className="sel-handle" style={{ transform: `scale(${1 / zoom})` }} onPointerDown={startScale} title="Größe ändern" />
    </div>
  );
}
