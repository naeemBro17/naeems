// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invoiceFromOrder } from './invoice/invoiceData';
import { INVOICE_DEFAULTS, invoiceShop } from './invoice/invoiceShop';
import { buildInvoicePdf } from './invoice/renderInvoice';
import { sizedOrder } from '../../e2e/helpers/invoiceFixtures';
import { QR_REGION, decodeRegion, fontFilesFromDisk, renderPdfPage, type PageImage } from '../../e2e/helpers/invoicePdf';

const SCREENS = join(process.cwd(), 'reports', 'fix-order-actions-screens');
const FOLD = 841.89 / 3;

/** Rows (in points from the top) where a dashed fold line is drawn. */
function dashedLines(image: PageImage): number[] {
  const tops: number[] = [];
  let last = -10;
  for (let y = 0; y < image.height; y += 1) {
    // A dashed row: many grey/white switches and nothing dark (text and
    // the barcode always have dark pixels).
    let changes = 0;
    let dark = false;
    let prevGrey = false;
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * 4;
      const [r, g, b] = [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2]];
      if (r < 150 || g < 150 || b < 150) dark = true;
      const grey = Math.abs(r - 189) < 40 && Math.abs(g - 189) < 40 && Math.abs(b - 195) < 40;
      if (grey !== prevGrey) changes += 1;
      prevGrey = grey;
    }
    if (!dark && changes > 150) {
      if (y - last > 3) tops.push(y / image.scale);
      last = y;
    }
  }
  return tops;
}

/** True when nothing is drawn within `gap` points above and below the fold
 *  (apart from the dashed line itself). */
function clearAroundFold(image: PageImage, gap: number): boolean {
  const line = Math.round(FOLD * image.scale);
  for (let y = Math.round((FOLD - gap) * image.scale); y <= Math.round((FOLD + gap) * image.scale); y += 1) {
    if (Math.abs(y - line) <= 2) continue;
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * 4;
      if (image.rgba[i] < 235 || image.rgba[i + 1] < 235 || image.rgba[i + 2] < 235) return false;
    }
  }
  return true;
}

describe('Fix 1.38.1 invoice PDF: one fold line, content flows', () => {
  const fonts = fontFilesFromDisk();
  const shop = invoiceShop({ shop_whatsapp_number: '8801560040012' });

  for (const [count, pages] of [
    [3, 1],
    [12, 1],
    [14, 1],
    [20, 2],
  ] as const) {
    it(`${count} items → ${pages} page${pages === 1 ? '' : 's'}, one dashed line, nothing on the fold`, async () => {
      const pdf = await buildInvoicePdf([invoiceFromOrder(sizedOrder(count), [])], shop, fonts);
      expect(pdf.pageCount).toBe(pages);
      expect(pdf.missingCharacters).toEqual([]);
      const image = await renderPdfPage(pdf.bytes, 1, 2);
      const lines = dashedLines(image);
      expect(lines.length).toBe(1);
      expect(Math.abs(lines[0] - FOLD)).toBeLessThan(1.5);
      expect(clearAroundFold(image, 8)).toBe(true);
      const last = pages === 1 ? image : await renderPdfPage(pdf.bytes, pages, 2);
      if (pages > 1) expect(dashedLines(last).length).toBe(0);
      // The QR is on the last page, wherever the content put it.
      const region = pages === 1 ? QR_REGION : { x: 20, top: 60, width: 555, height: 710 };
      expect(decodeRegion(await renderPdfPage(pdf.bytes, pages, 3), region, 'qr')).toBe(INVOICE_DEFAULTS.communityLink);

      mkdirSync(SCREENS, { recursive: true });
      writeFileSync(join(SCREENS, `invoice-${count}-items.png`), image.png);
      if (pages > 1) writeFileSync(join(SCREENS, `invoice-${count}-items-page2.png`), last.png);
    }, 60_000);
  }
});
