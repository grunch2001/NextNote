import { memo, useMemo } from 'react';
import type { InkElement } from '../../model/types';
import { displayInkColor, HIGHLIGHTER_OPACITY, inkGeometry } from '../../ink/render';
import { usePage, type DragTransform } from '../../state/page';
import { useSettings } from '../../state/settings';
import { useIsDark } from '../theme';

export function dragSvgTransform(d: DragTransform): string {
  return `translate(${d.dx + d.ox} ${d.dy + d.oy}) scale(${d.s}) translate(${-d.ox} ${-d.oy})`;
}

const InkPath = memo(function InkPath({
  el,
  dark,
  invert,
  selected,
}: {
  el: InkElement;
  dark: boolean;
  invert: boolean;
  selected: boolean;
}) {
  const geo = inkGeometry(el);
  const color = displayInkColor(el.color, dark, invert);
  const cls = selected ? 'ink selected' : 'ink';
  // data-id: the live canvas keeps a finished stroke until its path is here
  if (geo.mode === 'fill') return <path className={cls} data-id={el.id} d={geo.d} fill={color} />;
  return (
    <path
      className={cls}
      data-id={el.id}
      d={geo.d}
      fill="none"
      stroke={color}
      strokeWidth={el.size}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={el.tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1}
    />
  );
});

export const InkLayer = memo(function InkLayer({ width, height }: { width: number; height: number }) {
  const elements = usePage((s) => s.elements);
  const selection = usePage((s) => s.selection);
  const drag = usePage((s) => s.drag);
  // PDF pages stay white: ink keeps its colour
  const onPdf = usePage((s) => s.kind === 'pdf');
  const dark = useIsDark() && !onPdf;
  const invert = useSettings((s) => s.invertInkInDark);

  const strokes = useMemo(
    () =>
      Object.values(elements)
        .filter((e): e is InkElement => e.type === 'ink')
        .sort((a, b) => (a.tool === 'highlighter' ? 0 : 1) - (b.tool === 'highlighter' ? 0 : 1) || a.z - b.z),
    [elements],
  );
  const sel = useMemo(() => new Set(selection), [selection]);
  const still = drag ? strokes.filter((s) => !sel.has(s.id)) : strokes;
  const moving = drag ? strokes.filter((s) => sel.has(s.id)) : [];

  return (
    <svg className="ink-layer" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {still.map((s) => (
        <InkPath key={s.id} el={s} dark={dark} invert={invert} selected={sel.has(s.id)} />
      ))}
      {drag && (
        <g transform={dragSvgTransform(drag)}>
          {moving.map((s) => (
            <InkPath key={s.id} el={s} dark={dark} invert={invert} selected />
          ))}
        </g>
      )}
    </svg>
  );
});
