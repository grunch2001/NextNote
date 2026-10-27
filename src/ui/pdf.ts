/** Renders the pages of a PDF into images ("Dateiausdruck"), so they can be annotated with the pen. */
export interface RenderedPdfPage {
  blob: Blob;
  /** Size in CSS pixels at 100 % (PDF points × 96/72). */
  width: number;
  height: number;
}

export async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/** Opens a PDF with pdf.js (the data is copied: pdf.js hands it over to its worker). */
export async function openPdfjs(data: ArrayBuffer | Uint8Array) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(data).slice() }).promise;
}

/** Page sizes in CSS pixels at 100 % (for PDFs that pdf-lib cannot open). */
export async function pdfjsPageBoxes(data: Uint8Array): Promise<{ w: number; h: number }[]> {
  const doc = await openPdfjs(data);
  try {
    const out: { w: number; h: number }[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 96 / 72 });
      out.push({ w: Math.round(vp.width * 100) / 100, h: Math.round(vp.height * 100) / 100 });
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/** Converts a picture (GIF, WebP, SVG …) to PNG. */
export async function imageToPng(data: ArrayBuffer, mime: string): Promise<Uint8Array> {
  const bmp = await createImageBitmap(new Blob([data], { type: mime }));
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht umgewandelt werden'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function renderPdf(file: Blob, onProgress?: (page: number, total: number) => void): Promise<RenderedPdfPage[]> {
  const doc = await openPdfjs(await file.arrayBuffer());
  const out: RenderedPdfPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress?.(i, doc.numPages);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // ~1700 px wide keeps small print readable when zooming in
      const scale = Math.min(3, 1700 / base.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Seite konnte nicht gerendert werden'))), 'image/jpeg', 0.9),
      );
      out.push({ blob, width: (base.width * 96) / 72, height: (base.height * 96) / 72 });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return out;
}
