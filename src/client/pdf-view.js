/**
 * PDF reading for the inbox: pdfjs-dist with the worker handler imported on
 * the main thread (the reader-proven approach — no separate unserved worker
 * URL). Renders pages to canvases lazily as the container scrolls.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

globalThis.pdfjsWorker = { WorkerMessageHandler };

export async function openPdf(base64) {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  const task = getDocument({ data: bytes, useSystemFonts: true });
  const pdf = await task.promise;
  return {
    numPages: pdf.numPages,
    async renderPage(pageNumber, canvas, scale = 1.2) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    },
    /** scale=1 时的页宽（pt/px），适宽缩放的基准（InboxView PdfPane 用）。 */
    async pageWidth(pageNumber) {
      const page = await pdf.getPage(pageNumber);
      return page.getViewport({ scale: 1 }).width;
    },
    async textOf(pageNumber) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      return content.items.map((item) => item.str || '').join(' ');
    },
    destroy() {
      return task.destroy();
    },
  };
}
