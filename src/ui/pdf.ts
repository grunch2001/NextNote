/** Renders the pages of a PDF into images ("Dateiausdruck"), so they can be annotated with the pen. */
export interface RenderedPdfPage {
  blob: Blob;
  /** Size in CSS pixels at 100 % (PDF points × 96/72). */
  width: number;
  height: number;
}

export async function renderPdf(file: Blob, onProgress?: (page: number, total: number) => void): Promise<RenderedPdfPage[]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
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
