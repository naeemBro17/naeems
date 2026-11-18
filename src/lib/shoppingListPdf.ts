import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadInvoiceFonts } from './invoice/invoiceOutput';
import { shoppingDateLabel, shoppingRowName, shoppingTotals, type ShoppingRow } from './shoppingList';

// Batch 51 Part 3: the Shopping list as an A4 PDF — the date at the top,
// then a tick box · product + option · quantity · order numbers.
// Near-black text, no orange. Loaded only when Download PDF is tapped.

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 40;
const INK = rgb(0.11, 0.11, 0.12);
const GREY = rgb(0.43, 0.43, 0.45);
const LINE = rgb(0.85, 0.85, 0.87);
const COL = { box: MARGIN, name: MARGIN + 26, qty: 380, orders: 430 };

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line === '' || font.widthOfTextAtSize(next, size) <= width) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

export async function buildShoppingListPdf(rows: readonly ShoppingRow[], now: Date = new Date()): Promise<Uint8Array> {
  const fonts = await loadInvoiceFonts();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fonts.latin.regular, { subset: true });
  const bold = await doc.embedFont(fonts.latin.bold, { subset: true });
  doc.setTitle('Shopping list');

  let page: PDFPage = doc.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;

  const columnHeads = () => {
    page.drawText('Product', { x: COL.name, y, size: 9, font: bold, color: GREY });
    page.drawText('Qty', { x: COL.qty, y, size: 9, font: bold, color: GREY });
    page.drawText('Orders', { x: COL.orders, y, size: 9, font: bold, color: GREY });
    y -= 8;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 0.8, color: LINE });
    y -= 18;
  };

  page.drawText('Shopping list', { x: MARGIN, y: y - 20, size: 20, font: bold, color: INK });
  y -= 40;
  page.drawText(shoppingDateLabel(now), { x: MARGIN, y, size: 11, font: regular, color: GREY });
  const totals = shoppingTotals(rows);
  const totalsText = `${totals.items} item${totals.items === 1 ? '' : 's'} · ${totals.units} unit${totals.units === 1 ? '' : 's'}`;
  page.drawText(totalsText, {
    x: A4.w - MARGIN - regular.widthOfTextAtSize(totalsText, 11),
    y,
    size: 11,
    font: regular,
    color: GREY,
  });
  y -= 28;
  columnHeads();

  for (const row of rows) {
    const nameLines = wrap(shoppingRowName(row), regular, 11, COL.qty - COL.name - 12);
    const orderLines = wrap(row.orders.map((o) => o.number).join(', '), regular, 9.5, A4.w - MARGIN - COL.orders);
    const height = Math.max(nameLines.length * 14, orderLines.length * 12.5, 14) + 10;
    if (y - height < MARGIN) {
      page = doc.addPage([A4.w, A4.h]);
      y = A4.h - MARGIN;
      columnHeads();
    }
    page.drawRectangle({ x: COL.box, y: y - 2, width: 11, height: 11, borderColor: INK, borderWidth: 1 });
    nameLines.forEach((line, i) => page.drawText(line, { x: COL.name, y: y - i * 14, size: 11, font: regular, color: INK }));
    const qty = row.unit ? `${row.qty} × ${row.unit}` : String(row.qty);
    page.drawText(qty, { x: COL.qty, y, size: 12, font: bold, color: INK });
    orderLines.forEach((line, i) =>
      page.drawText(line, { x: COL.orders, y: y - i * 12.5, size: 9.5, font: regular, color: GREY })
    );
    y -= height;
    page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: A4.w - MARGIN, y: y + 4 }, thickness: 0.5, color: LINE });
    y -= 10;
  }

  if (rows.length === 0) {
    page.drawText('Nothing to buy right now.', { x: MARGIN, y, size: 12, font: regular, color: GREY });
  }
  return doc.save();
}

/** Builds the PDF and starts the download ("Shopping list 19 Nov 2026.pdf"). */
export async function downloadShoppingListPdf(rows: readonly ShoppingRow[], now: Date = new Date()): Promise<void> {
  const bytes = await buildShoppingListPdf(rows, now);
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const stamp = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Shopping list ${stamp}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
