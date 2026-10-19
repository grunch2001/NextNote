import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { repo } from '../state/repo';
import type { ID, ImageElement } from '../model/types';
import { newId, now } from '../model/util';

/** Bumped when the sync downloaded new assets. */
export const useAssetVersion = create<{ v: number }>(() => ({ v: 0 }));

const urls = new Map<ID, string>();

export function useAssetUrl(assetId: ID): string | null {
  const v = useAssetVersion((s) => s.v);
  const [url, setUrl] = useState<string | null>(() => urls.get(assetId) ?? null);
  useEffect(() => {
    let cancelled = false;
    const cached = urls.get(assetId);
    if (cached) {
      setUrl(cached);
      return;
    }
    void repo.getAsset(assetId).then((a) => {
      if (cancelled || !a) return;
      const u = URL.createObjectURL(new Blob([a.data], { type: a.mime }));
      urls.set(assetId, u);
      setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [assetId, v]);
  return url;
}

const MAX_DIM = 2400;

async function loadBitmap(blob: Blob): Promise<{ width: number; height: number; draw(ctx: CanvasRenderingContext2D, w: number, h: number): void }> {
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(blob);
      return { width: bmp.width, height: bmp.height, draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h) };
    } catch {
      // fall through
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h) };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Reads an image file, shrinks very large photos and returns the data plus its natural size. */
export async function prepareImage(blob: Blob): Promise<{ data: ArrayBuffer; mime: string; width: number; height: number }> {
  const mime = blob.type || 'image/png';
  if (mime === 'image/svg+xml' || mime === 'image/gif') {
    const bmp = await loadBitmap(blob).catch(() => ({ width: 400, height: 300 }));
    return { data: await blob.arrayBuffer(), mime, width: bmp.width, height: bmp.height };
  }
  const bmp = await loadBitmap(blob);
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  if (scale >= 1 && blob.size < 3_000_000) {
    return { data: await blob.arrayBuffer(), mime, width: bmp.width, height: bmp.height };
  }
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  bmp.draw(ctx, w, h);
  const outMime = mime === 'image/png' && blob.size < 6_000_000 ? 'image/png' : 'image/jpeg';
  const out = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht verarbeitet werden'))), outMime, 0.88));
  return { data: await out.arrayBuffer(), mime: outMime, width: w, height: h };
}

/** Creates an image element (and stores the asset) at the given page position. */
export async function createImageElement(notebookId: ID, blob: Blob, x: number, y: number, maxWidth = 640): Promise<ImageElement> {
  const img = await prepareImage(blob);
  const assetId = await repo.addAsset(notebookId, img.data, img.mime);
  const s = Math.min(1, maxWidth / img.width);
  const ts = now();
  return {
    id: newId(),
    type: 'image',
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(img.width * s),
    h: Math.round(img.height * s),
    asset: assetId,
    mime: img.mime,
    z: ts,
    updatedAt: ts,
  };
}

export function pickFiles(accept: string, opts: { multiple?: boolean; capture?: string } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = !!opts.multiple;
    if (opts.capture) input.setAttribute('capture', opts.capture);
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
