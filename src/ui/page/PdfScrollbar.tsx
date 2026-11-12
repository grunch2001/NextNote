import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { pageIndexAt, type PageSlot } from '../../pdf/layout';

/** How long the bar stays after the last scroll before it fades out. */
const HIDE_AFTER = 1400;
/** Thumb diameter in CSS pixels, keep in sync with .pdf-scrollbar-thumb. */
const THUMB = 22;

/**
 * Scroll bar on the right edge of a PDF: dragging the thumb (or tapping the track) scrolls
 * through the document. It shows up while scrolling and fades out afterwards; next to the
 * thumb it shows the current page, below the track the number of pages.
 */
export const PdfScrollbar = memo(function PdfScrollbar({ scroller, slots, zoom }: { scroller: HTMLElement | null; slots: PageSlot[]; zoom: number }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [frac, setFrac] = useState(0);
  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const grab = useRef(0);
  const hovered = useRef(false);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      if (!hovered.current) setShown(false);
    }, HIDE_AFTER);
  }, []);

  const update = useCallback(() => {
    if (!scroller) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    setFrac(max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0);
    // the page in the middle of the view, at the ends the first and last one
    const center = (scroller.scrollTop + scroller.clientHeight / 2) / zoom;
    setPage(max <= 0 ? 0 : scroller.scrollTop <= 1 ? 0 : scroller.scrollTop >= max - 1 ? slots.length - 1 : pageIndexAt(slots, center));
  }, [scroller, slots, zoom]);

  useEffect(() => {
    if (!scroller) return;
    let raf = 0;
    const onScroll = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          update();
        });
      setShown(true);
      scheduleHide();
    };
    update();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(scroller);
    if (scroller.firstElementChild) ro.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [scroller, update, scheduleHide]);

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  const scrollToPointer = (clientY: number) => {
    const track = trackRef.current;
    if (!scroller || !track) return;
    const r = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientY - r.top - grab.current) / Math.max(1, r.height - THUMB)));
    scroller.scrollTop = f * (scroller.scrollHeight - scroller.clientHeight);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !trackRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const r = trackRef.current.getBoundingClientRect();
    const thumbTop = r.top + frac * (r.height - THUMB);
    // grabbing the thumb keeps it under the pointer, elsewhere the thumb jumps there
    grab.current = e.clientY >= thumbTop - 6 && e.clientY <= thumbTop + THUMB + 6 ? Math.min(THUMB, Math.max(0, e.clientY - thumbTop)) : THUMB / 2;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    scrollToPointer(e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) scrollToPointer(e.clientY);
  };
  const endDrag = () => {
    if (!dragging) return;
    setDragging(false);
    scheduleHide();
  };

  if (slots.length < 2) return null;
  const visible = shown || dragging;
  return (
    <div
      className={`pdf-scrollbar${visible ? ' visible' : ''}${dragging ? ' dragging' : ''}`}
      data-own-pointer=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        hovered.current = true;
        setShown(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return;
        hovered.current = false;
        scheduleHide();
      }}
      role="scrollbar"
      aria-orientation="vertical"
      aria-valuemin={1}
      aria-valuemax={slots.length}
      aria-valuenow={page + 1}
      aria-label="Seiten"
    >
      <div className="pdf-scrollbar-track" ref={trackRef}>
        <div className="pdf-scrollbar-thumb" style={{ top: `calc(${frac} * (100% - ${THUMB}px))` }}>
          <span className="pdf-scrollbar-page">{page + 1}</span>
        </div>
      </div>
      <span className="pdf-scrollbar-total" title={`${slots.length} Seiten`}>
        {slots.length}
      </span>
    </div>
  );
});
