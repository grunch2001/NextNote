import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { db } from '../../db/db';
import type { ID } from '../../model/types';
import type { PageSlot } from '../../pdf/layout';
import { openPdfjs } from '../pdf';

/** Upper limits for one rendered page, so that zooming in does not run out of memory on a tablet. */
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;

/**
 * The pages of a PDF as the background of the page. Only pages near the visible area are
 * rendered, at the resolution of the current zoom; others give their memory back.
 */
export const PdfPages = memo(function PdfPages({
  docId,
  version,
  slots,
  zoom,
  scroller,
}: {
  docId: ID;
  version: number;
  slots: PageSlot[];
  zoom: number;
  scroller: HTMLElement | null;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setError(null);
    void (async () => {
      const file = await db.pdfFiles.get(docId);
      if (!file || cancelled) return;
      loaded = await openPdfjs(file.data);
      if (cancelled) void loaded.destroy();
      else setPdf(loaded);
    })().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
      setPdf(null);
      void loaded?.destroy();
    };
  }, [docId, version]);

  return (
    <>
      {slots.map((slot, i) => (
        <PdfPageCanvas key={i} pdf={pdf} index={i} slot={slot} zoom={zoom} scroller={scroller} />
      ))}
      {error && (
        <div className="pdf-error" style={{ left: slots[0]?.x ?? 24, top: slots[0]?.y ?? 24 }}>
          Die PDF konnte nicht angezeigt werden: {error}
        </div>
      )}
    </>
  );
});

function PdfPageCanvas({ pdf, index, slot, zoom, scroller }: { pdf: PDFDocumentProxy | null; index: number; slot: PageSlot; zoom: number; scroller: HTMLElement | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shown = useRef<{ canvas: HTMLCanvasElement; zoom: number } | null>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !scroller) return;
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { root: scroller, rootMargin: '100% 50%' });
    io.observe(host);
    return () => io.disconnect();
  }, [scroller]);

  useEffect(() => {
    const host = hostRef.current;
    if (!near) {
      // far away: give the memory back
      if (shown.current) {
        shown.current.canvas.width = 0;
        shown.current.canvas.height = 0;
        shown.current.canvas.remove();
        shown.current = null;
      }
      return;
    }
    if (!pdf || !host || (shown.current && shown.current.zoom === zoom)) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    // while zooming, the old picture is scaled; render sharp once the zoom rests
    const timer = setTimeout(
      () =>
        void (async () => {
          const page = await pdf.getPage(index + 1);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const want = (96 / 72) * zoom * (window.devicePixelRatio || 1);
          const scale = Math.min(want, Math.sqrt(MAX_PIXELS / (base.width * base.height)), MAX_SIDE / Math.max(base.width, base.height));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          task = page.render({ canvas, canvasContext: ctx, viewport });
          await task.promise;
          if (cancelled) return;
          const old = shown.current?.canvas;
          host.appendChild(canvas);
          if (old) {
            old.width = 0;
            old.height = 0;
            old.remove();
          }
          shown.current = { canvas, zoom };
        })().catch(() => {
          // cancelled or broken page: the white page stays
        }),
      shown.current ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [pdf, near, zoom, index]);

  // a new file: drop the old picture
  useEffect(
    () => () => {
      if (shown.current) {
        shown.current.canvas.width = 0;
        shown.current.canvas.remove();
        shown.current = null;
      }
    },
    [pdf],
  );

  return <div ref={hostRef} className="pdf-page" data-page={index + 1} style={{ left: slot.x, top: slot.y, width: slot.w, height: slot.h }} />;
}
