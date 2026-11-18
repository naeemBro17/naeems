import type { PdfText } from './oldSales';

/**
 * Batch 50: every piece of text in a Kaarbar party statement PDF with its
 * position, read here in the browser with pdf.js (the file is never
 * uploaded). pdf.js and its worker are loaded only when this card reads a
 * file, so no customer's phone ever downloads them.
 */
export async function readPdfText(file: Blob): Promise<PdfText[]> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), verbosity: 0 });
  let pdf;
  try {
    pdf = await task.promise;
  } catch {
    void task.destroy();
    throw new Error('This is not a PDF that can be opened. Download the party statement from Kaarbar again.');
  }
  const out: PdfText[] = [];
  try {
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || item.str.trim() === '') continue;
        const [a, b, , d, x, y] = item.transform as number[];
        out.push({ str: item.str, x, y, w: item.width, h: Math.abs(d) || Math.hypot(a, b) || item.height, page });
      }
    }
  } finally {
    void task.destroy();
  }
  return out;
}
