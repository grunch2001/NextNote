import { memo } from 'react';
import type { ImageElement } from '../../model/types';
import type { DragTransform } from '../../state/page';
import { useAssetUrl } from '../assets';

export const ImageView = memo(function ImageView({ el, selected, drag }: { el: ImageElement; selected: boolean; drag: DragTransform | null }) {
  const url = useAssetUrl(el.asset);
  let transform: string | undefined;
  if (selected && drag) {
    const nx = (el.x - drag.ox) * drag.s + drag.ox + drag.dx;
    const ny = (el.y - drag.oy) * drag.s + drag.oy + drag.dy;
    transform = `translate(${nx - el.x}px, ${ny - el.y}px) scale(${drag.s})`;
  }
  return (
    <div
      className={`image-el${selected ? ' selected' : ''}`}
      data-el={el.id}
      style={{ left: el.x, top: el.y, width: el.w, height: el.h, transform }}
    >
      {url ? <img src={url} alt="" draggable={false} /> : <div className="image-loading">Bild wird geladen …</div>}
    </div>
  );
});
