// Batch 37: draws the A4 fold-to-label invoice (docs/mockups/batch-37/
// NAEEMS_Invoice_v2.pdf). Top third = parcel label, the rest = invoice;
// fold the lower two-thirds back and the label stays on top.
//
// Plus Jakarta Sans for Latin text, Noto Sans Bengali for ৳ and any Bengali —
// both embedded (subset), so it prints the same on every printer. fontkit
// shapes Bengali properly (vowel signs and joined letters); its Indic
// shaper needs regenerator-runtime loaded first. Noto Sans Bengali places
// vowel signs and joined letters with small offsets that pdf-lib's own
// drawText ignores, so Bengali is drawn glyph by glyph at its shaped
// position (Writer.drawShaped).
import 'regenerator-runtime/runtime.js';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  PDFHexString,
  PrintScaling,
  degrees,
  drawText as drawTextOperators,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import { encode as encodeQr } from 'uqr';
import { code128Widths } from './code128';
import { fullAddress, invoiceMoney, type InvoiceData } from './invoiceData';
import type { InvoiceShop } from './invoiceShop';
import type { InvoiceFontFiles, InvoiceWeight } from './invoiceFonts';

export interface InvoicePdfResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Characters no embedded font could draw (printed as "?"). Empty = every
   *  character, Bengali included, has a real glyph. */
  missingCharacters: string[];
}

/* ---------- Page geometry (points, measured from the top) ---------- */
const W = 595.28;
const H = 841.89;
const M = 40;
const R = W - M;
const FOLD_1 = H / 3;

const BOX_X = 311;
const COMMUNITY_H = 108;
const COMMUNITY_GAP = 18;
// Fix 1.38.1: more than this many items → tighter rows and the small
// community box beside the totals, so about 14 items still fit on page 1.
const COMPACT_AFTER = 8;
const SMALL_QR = 58;
const SMALL_BOX_H = SMALL_QR + 12;
const FOOTER_RULE = 770;
const CONT_TABLE_TOP = 80;

// Items table columns.
const COL_NUM = M + 12;
const COL_ITEM = 70;
const ITEM_MAX_W = 258;
const COL_UNIT = 387;
const COL_QTY = 432;
const COL_DISC = 487;
const COL_AMOUNT = 547;
const TABLE_HEAD_H = 22;
const ROW_LINE = 12;

// Totals block.
const TOTALS_X = 367;
const TOTAL_STEP = 14.5;
const COMPACT_TOTAL_STEP = 13;

function hex(color: string): RGB {
  const n = parseInt(color.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const INK = hex('#1C1C1E');
const GREY = hex('#6E6E73');
const RULE = hex('#D9D9DE');
const PANEL = hex('#F4F4F6');
const ORANGE = hex('#FF7A45');
const WHITE = hex('#FFFFFF');
const FOLD = hex('#BDBDC3');
const ON_DARK_GREY = hex('#B5B5BA');

const BENGALI_CHAR = /[ঀ-৿‌‍।॥]/u;
/** Kept in a Bengali run between Bengali words, so shaping is not split. */
const NEUTRAL_CHAR = /[\s,.\-/()]/u;

interface Face {
  font: PDFFont;
  chars: Set<number>;
  /** Bengali: the same font file, laid out by fontkit for the glyph
   *  positions (offsets) pdf-lib does not apply by itself. */
  shaper: ReturnType<typeof fontkit.create> | null;
}

interface Run {
  face: Face;
  text: string;
}

interface TextOptions {
  size: number;
  weight?: InvoiceWeight;
  color?: RGB;
  /** Extra space after every character (letter spacing). */
  spacing?: number;
  align?: 'left' | 'right';
}

const graphemes = (text: string): string[] => {
  type GraphemeSegmenter = new (locale: undefined, options: { granularity: 'grapheme' }) => {
    segment: (input: string) => Iterable<{ segment: string }>;
  };
  const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenter }).Segmenter;
  if (!Segmenter) return Array.from(text);
  return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
};

/** Text with per-character font fallback, measuring and wrapping. */
class Writer {
  readonly missing = new Set<string>();

  constructor(private readonly faces: Record<'latin' | 'bengali', Record<InvoiceWeight, Face>>) {}

  runs(text: string, weight: InvoiceWeight): Run[] {
    const latin = this.faces.latin[weight];
    const bengali = this.faces.bengali[weight];
    const runs: Run[] = [];
    for (const original of text) {
      let ch = original;
      const cp = ch.codePointAt(0) ?? 0;
      const current = runs.length > 0 ? runs[runs.length - 1] : null;
      let face: Face | null;
      if (BENGALI_CHAR.test(ch)) face = bengali.chars.has(cp) ? bengali : null;
      else if (current?.face === bengali && NEUTRAL_CHAR.test(ch) && bengali.chars.has(cp)) face = bengali;
      else if (latin.chars.has(cp)) face = latin;
      else if (bengali.chars.has(cp)) face = bengali;
      else face = null;
      if (!face) {
        if (!/\s/u.test(ch)) this.missing.add(ch);
        ch = /\s/u.test(ch) ? ' ' : '?';
        face = latin;
      }
      if (current && current.face === face) current.text += ch;
      else runs.push({ face, text: ch });
    }
    return runs;
  }

  /** One run's width — Bengali from its shaped positions, exactly as drawn. */
  private runWidth(run: Run, size: number): number {
    const shaper = run.face.shaper;
    if (!shaper) return run.face.font.widthOfTextAtSize(run.text, size);
    const { positions } = shaper.layout(run.text);
    return (positions.reduce((sum, p) => sum + p.xAdvance, 0) * size) / shaper.unitsPerEm;
  }

  /** Draws a Bengali run glyph by glyph, each at its shaped position, so
   *  vowel signs and joined letters sit where the font puts them. */
  private drawShaped(page: PDFPage, run: Run, x: number, y: number, size: number, color: RGB): void {
    const shaper = run.face.shaper;
    const { font } = run.face;
    const hex = font.encodeText(run.text).asString();
    const positions = shaper ? shaper.layout(run.text).positions : [];
    if (!shaper || hex.length !== positions.length * 4) {
      page.drawText(run.text, { x, y, size, font, color });
      return;
    }
    const key = page.node.newFontDictionary(font.name, font.ref);
    const scale = size / shaper.unitsPerEm;
    let pen = x;
    positions.forEach((p, i) => {
      page.pushOperators(
        ...drawTextOperators(PDFHexString.of(hex.slice(i * 4, i * 4 + 4)), {
          color,
          font: key,
          size,
          rotate: degrees(0),
          xSkew: degrees(0),
          ySkew: degrees(0),
          x: pen + p.xOffset * scale,
          y: y + p.yOffset * scale,
        })
      );
      pen += p.xAdvance * scale;
    });
  }

  width(text: string, opts: TextOptions): number {
    const weight = opts.weight ?? 'regular';
    let w = 0;
    for (const run of this.runs(text, weight)) w += this.runWidth(run, opts.size);
    return w + (opts.spacing ?? 0) * Array.from(text).length;
  }

  /** Draws at `x` (left, or right edge when align = right) on `baseline`
   *  measured from the top of the page. Returns the drawn width. */
  draw(page: PDFPage, text: string, x: number, baseline: number, opts: TextOptions): number {
    const weight = opts.weight ?? 'regular';
    const color = opts.color ?? INK;
    const width = this.width(text, opts);
    let cx = opts.align === 'right' ? x - width : x;
    const y = H - baseline;
    for (const run of this.runs(text, weight)) {
      if (opts.spacing) {
        for (const ch of run.text) {
          page.drawText(ch, { x: cx, y, size: opts.size, font: run.face.font, color });
          cx += run.face.font.widthOfTextAtSize(ch, opts.size) + opts.spacing;
        }
      } else if (run.face.shaper) {
        this.drawShaped(page, run, cx, y, opts.size, color);
        cx += this.runWidth(run, opts.size);
      } else {
        page.drawText(run.text, { x: cx, y, size: opts.size, font: run.face.font, color });
        cx += run.face.font.widthOfTextAtSize(run.text, opts.size);
      }
    }
    return width;
  }

  /** Cuts the text and adds "…" until it fits. */
  ellipsize(text: string, maxWidth: number, opts: TextOptions): string {
    if (this.width(text, opts) <= maxWidth) return text;
    const parts = graphemes(text);
    while (parts.length > 0 && this.width(`${parts.join('').trimEnd()}…`, opts) > maxWidth) parts.pop();
    return `${parts.join('').trimEnd()}…`;
  }

  /** Largest size (down to `min`) that fits on one line; still too long → "…". */
  fit(text: string, maxWidth: number, opts: TextOptions, min: number): { text: string; size: number } {
    let size = opts.size;
    while (size > min && this.width(text, { ...opts, size }) > maxWidth) size -= 0.5;
    return { text: this.ellipsize(text, maxWidth, { ...opts, size }), size };
  }

  /** Word-wrapped lines; with `maxLines`, the last kept line ends in "…". */
  wrap(text: string, maxWidth: number, opts: TextOptions, maxLines?: number): string[] {
    const words = text.replace(/\s+/gu, ' ').trim().split(' ').filter((w) => w !== '');
    const lines: string[] = [];
    let line = '';
    const pushWord = (word: string) => {
      if (this.width(word, opts) <= maxWidth) {
        line = word;
        return;
      }
      // One word wider than the column: break it between characters.
      let chunk = '';
      for (const g of graphemes(word)) {
        if (chunk !== '' && this.width(chunk + g, opts) > maxWidth) {
          lines.push(chunk);
          chunk = g;
        } else chunk += g;
      }
      line = chunk;
    };
    for (const word of words) {
      if (line === '') pushWord(word);
      else if (this.width(`${line} ${word}`, opts) <= maxWidth) line = `${line} ${word}`;
      else {
        lines.push(line);
        pushWord(word);
      }
    }
    if (line !== '') lines.push(line);
    if (maxLines !== undefined && lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      kept[maxLines - 1] = this.ellipsize(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, maxWidth, opts);
      return kept;
    }
    return lines;
  }
}

/* ---------- Shapes ---------- */

function roundedRect(
  page: PDFPage,
  x: number,
  top: number,
  w: number,
  h: number,
  r: number,
  style: { fill?: RGB; stroke?: RGB; strokeWidth?: number }
) {
  const path = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
  page.drawSvgPath(path, {
    x,
    y: H - top,
    color: style.fill,
    borderColor: style.stroke,
    borderWidth: style.stroke ? (style.strokeWidth ?? 1) : undefined,
  });
}

function rect(page: PDFPage, x: number, top: number, w: number, h: number, color: RGB) {
  page.drawRectangle({ x, y: H - top - h, width: w, height: h, color });
}

function hline(page: PDFPage, x1: number, x2: number, top: number, thickness: number, color: RGB, dash?: number[]) {
  page.drawLine({ start: { x: x1, y: H - top }, end: { x: x2, y: H - top }, thickness, color, dashArray: dash });
}

/** Code 128 bars; returns the drawn width. */
function barcode(page: PDFPage, text: string, x: number, top: number, height: number, maxWidth: number): number {
  const widths = code128Widths(text);
  const modules = widths.reduce((a, b) => a + b, 0);
  const unit = Math.min(1.3, Math.max(0.8, maxWidth / modules));
  let cx = x;
  widths.forEach((w, i) => {
    if (i % 2 === 0) rect(page, cx, top, w * unit, height, INK);
    cx += w * unit;
  });
  return modules * unit;
}

function qrCode(page: PDFPage, text: string, x: number, top: number, size: number) {
  const qr = encodeQr(text, { ecc: 'M', border: 0 });
  const unit = size / qr.size;
  qr.data.forEach((row, ry) => {
    let start = -1;
    for (let cx = 0; cx <= row.length; cx += 1) {
      const on = cx < row.length && row[cx];
      if (on && start < 0) start = cx;
      if (!on && start >= 0) {
        // Slight overlap so no hairline gaps show between modules.
        rect(page, x + start * unit, top + ry * unit, (cx - start) * unit + 0.05, unit + 0.05, INK);
        start = -1;
      }
    }
  });
}

/* ---------- Layout ---------- */

const SMALL_LABEL: TextOptions = { size: 6.8, weight: 'semibold', color: GREY, spacing: 0.8 };

function drawLabel(page: PDFPage, w: Writer, inv: InvoiceData, shop: InvoiceShop) {
  // Brand row.
  w.draw(page, shop.name, M, 63, { size: 25, weight: 'extrabold', spacing: 4 });
  rect(page, M, 70, 58, 3, ORANGE);
  w.draw(page, 'Invoice', R, 63, { size: 20, weight: 'bold', align: 'right' });
  hline(page, M, R, 86, 0.8, INK);

  // Left column: consignment.
  const leftW = BOX_X - M - 16;
  if (inv.audience === 'customer') {
    w.draw(page, 'ORDER NO.', M, 108, SMALL_LABEL);
    const fitted = w.fit(inv.orderNumber, leftW, { size: 28, weight: 'extrabold' }, 14);
    w.draw(page, fitted.text, M, 136, { size: fitted.size, weight: 'extrabold' });
  } else if (inv.consignmentId) {
    w.draw(page, 'CONSIGNMENT ID', M, 108, SMALL_LABEL);
    const fitted = w.fit(inv.consignmentId, leftW, { size: 28, weight: 'extrabold' }, 14);
    w.draw(page, fitted.text, M, 136, { size: fitted.size, weight: 'extrabold' });
    barcode(page, inv.consignmentId, M, 146, 44, 200);
    const tracking = inv.trackingCode ? `Tracking ${inv.trackingCode}` : 'Tracking —';
    w.draw(page, w.ellipsize(tracking, leftW, { size: 8 }), M, 203, { size: 8, color: GREY });
    w.draw(page, `Steadfast Courier · ${inv.deliveryType}`, M, 215, { size: 8, weight: 'semibold' });
  } else {
    w.draw(page, 'CONSIGNMENT ID', M, 108, SMALL_LABEL);
    w.draw(page, 'Not booked yet', M, 134, { size: 22, weight: 'extrabold' });
    w.draw(page, 'Book with Steadfast to print the label', M, 152, { size: 8.5, color: GREY });
  }
  const city = shop.city.split(',')[0].trim();
  const from = [`From ${shop.name}`, shop.phone, city].filter((v) => v !== '').join(' · ');
  w.draw(page, w.ellipsize(from, leftW, { size: 7.5 }), M, 245, { size: 7.5, color: GREY });
  const itemsText = `${inv.itemCount} item${inv.itemCount === 1 ? '' : 's'}`;
  w.draw(page, `Order ${inv.orderNumber} · ${itemsText} · ${inv.date}`, M, 257, { size: 7.5, color: GREY });

  // Right: Deliver to.
  const boxW = R - BOX_X;
  const pad = 14;
  const innerW = boxW - pad * 2;
  const tx = BOX_X + pad;
  w.draw(page, 'DELIVER TO', tx, 122, SMALL_LABEL);
  const name = w.fit(inv.customer.name, innerW, { size: 17, weight: 'bold' }, 12);
  w.draw(page, name.text, tx, 143, { size: name.size, weight: 'bold' });
  w.draw(page, inv.customer.phone, tx, 160, { size: 11.5, weight: 'semibold' });
  let baseline = 160;
  for (const line of w.wrap(inv.customer.addressLine, innerW, { size: 10 }, 3)) {
    baseline += 13;
    w.draw(page, line, tx, baseline, { size: 10 });
  }
  if (inv.customer.area !== '') {
    baseline += 13;
    const area = w.ellipsize(inv.customer.area, innerW, { size: 10, weight: 'semibold' });
    w.draw(page, area, tx, baseline, { size: 10, weight: 'semibold' });
  }
  const panelTop = Math.max(baseline + 12, 203);
  const panelH = 40;
  const boxBottom = panelTop + panelH + 10;
  roundedRect(page, BOX_X, 104, boxW, boxBottom - 104, 8, { stroke: INK, strokeWidth: 1.2 });
  const px = BOX_X + 10;
  const pw = boxW - 20;
  roundedRect(page, px, panelTop, pw, panelH, 6, { fill: INK });
  w.draw(page, 'COLLECT (COD)', px + 12, panelTop + 17, { size: 7.5, weight: 'semibold', color: WHITE, spacing: 0.8 });
  w.draw(page, inv.cod.note, px + 12, panelTop + 29, { size: 7, color: ON_DARK_GREY });
  w.draw(page, invoiceMoney(inv.cod.amount), px + pw - 12, panelTop + 27, {
    size: 20,
    weight: 'extrabold',
    color: WHITE,
    align: 'right',
  });

  // The one fold guide, under the label. Nothing is printed on or near it.
  hline(page, 14, W - 14, FOLD_1, 0.6, FOLD, [2.5, 2.5]);
}

/** Sold by / Billed to / Invoice. Returns where the block ends. */
function drawParties(page: PDFPage, w: Writer, inv: InvoiceData, shop: InvoiceShop): number {
  // A clear gap below the fold line.
  const top = Math.round(FOLD_1) + 24;
  const col2 = 221;
  const col3 = 391;
  const col2W = col3 - col2 - 14;
  w.draw(page, 'SOLD BY', M, top, SMALL_LABEL);
  w.draw(page, 'BILLED TO', col2, top, SMALL_LABEL);
  w.draw(page, 'INVOICE', col3, top, SMALL_LABEL);

  const step = 12.5;
  let y1 = top + 14;
  w.draw(page, shop.name, M, y1, { size: 10, weight: 'bold' });
  for (const line of [shop.city, shop.phone].filter((v) => v !== '')) {
    y1 += step;
    w.draw(page, w.ellipsize(line, col2 - M - 14, { size: 9.5 }), M, y1, { size: 9.5, color: GREY });
  }

  let y2 = top + 14;
  const nameLines = w.wrap(inv.customer.name, col2W, { size: 10, weight: 'bold' }, 2);
  nameLines.forEach((line, i) => {
    if (i > 0) y2 += step;
    w.draw(page, line, col2, y2, { size: 10, weight: 'bold' });
  });
  y2 += step;
  w.draw(page, inv.customer.phone, col2, y2, { size: 9.5, color: GREY });
  for (const line of w.wrap(fullAddress(inv.customer), col2W, { size: 9.5 }, 5)) {
    y2 += step;
    w.draw(page, line, col2, y2, { size: 9.5, color: GREY });
  }

  const rows: [string, string, InvoiceWeight][] = [
    ['Invoice no.', inv.invoiceNumber, 'bold'],
    ['Order no.', inv.orderNumber, 'semibold'],
    ['Date', inv.date, 'semibold'],
    ['Payment', inv.paymentLabel, 'semibold'],
  ];
  let y3 = top + 14;
  rows.forEach(([label, value, weight], i) => {
    if (i > 0) y3 += step;
    const labelW = w.draw(page, label, col3, y3, { size: 9.5, color: GREY });
    const fitted = w.fit(value, R - col3 - labelW - 8, { size: 9.5, weight }, 7.5);
    w.draw(page, fitted.text, R, y3, { size: fitted.size, weight, align: 'right' });
  });

  return Math.max(y1, y2, y3) + 16;
}

function drawTableHead(page: PDFPage, w: Writer, top: number) {
  roundedRect(page, M, top, R - M, TABLE_HEAD_H, 6, { fill: PANEL });
  const base = top + 14.5;
  const head: TextOptions = { size: 8.5, weight: 'medium', color: GREY };
  w.draw(page, '#', COL_NUM, base, head);
  w.draw(page, 'Item', COL_ITEM, base, head);
  w.draw(page, 'Unit price', COL_UNIT, base, { ...head, align: 'right' });
  w.draw(page, 'Qty', COL_QTY, base, { ...head, align: 'right' });
  w.draw(page, 'Discount', COL_DISC, base, { ...head, align: 'right' });
  w.draw(page, 'Amount', COL_AMOUNT, base, { ...head, align: 'right' });
}

interface RowLayout {
  index: number;
  lines: string[];
  height: number;
}

function rowHeight(lineCount: number, compact: boolean): number {
  return compact ? 7 + lineCount * 11 : 13 + lineCount * ROW_LINE;
}

function drawRow(page: PDFPage, w: Writer, inv: InvoiceData, row: RowLayout, top: number, compact: boolean) {
  const line = inv.lines[row.index];
  const base = top + (compact ? 12.5 : 16);
  const cell: TextOptions = { size: 9 };
  w.draw(page, String(row.index + 1), COL_NUM, base, { ...cell, color: GREY });
  row.lines.forEach((text, i) => w.draw(page, text, COL_ITEM, base + i * (compact ? 11 : ROW_LINE), cell));
  w.draw(page, invoiceMoney(line.unitPrice), COL_UNIT, base, { ...cell, align: 'right' });
  w.draw(page, String(line.quantity), COL_QTY, base, { ...cell, align: 'right' });
  w.draw(page, line.discount > 0 ? `−${invoiceMoney(line.discount)}` : invoiceMoney(0), COL_DISC, base, {
    ...cell,
    color: GREY,
    align: 'right',
  });
  w.draw(page, invoiceMoney(line.amount), COL_AMOUNT, base, { ...cell, weight: 'bold', align: 'right' });
  hline(page, M, R, top + row.height, 0.6, RULE);
}

interface TotalsRow {
  label: string;
  value: string;
}

function totalsRows(inv: InvoiceData): TotalsRow[] {
  const rows: TotalsRow[] = [
    { label: 'Subtotal', value: invoiceMoney(inv.subtotal) },
    { label: 'Delivery charge', value: invoiceMoney(inv.deliveryFee) },
    { label: 'Discount', value: inv.discount > 0 ? `−${invoiceMoney(inv.discount)}` : invoiceMoney(0) },
    { label: 'Order total', value: invoiceMoney(inv.total) },
  ];
  for (const r of inv.paidRows) {
    rows.push({ label: r.label, value: r.minus && r.amount > 0 ? `−${invoiceMoney(r.amount)}` : invoiceMoney(r.amount) });
  }
  return rows;
}

const WORDS_W = TOTALS_X - M - 24;

function wordsLines(w: Writer, inv: InvoiceData): string[] {
  return w.wrap(inv.amountInWords, WORDS_W, { size: 10, weight: 'semibold' }, 3);
}

function totalsHeight(inv: InvoiceData, compact: boolean): number {
  return totalsRows(inv).length * (compact ? COMPACT_TOTAL_STEP : TOTAL_STEP) + 30;
}

/** Where the small community box starts, measured from the tail's top. */
function smallBoxOffset(w: Writer, inv: InvoiceData): number {
  return 10 + 15 + (wordsLines(w, inv).length - 1) * 13 + 12;
}

/** Totals + amount in words (+ the small community box when compact). */
function tailHeight(w: Writer, inv: InvoiceData, shop: InvoiceShop, compact: boolean): number {
  const totals = totalsHeight(inv, compact);
  if (!compact || !shop.community.show) return totals;
  return Math.max(totals, smallBoxOffset(w, inv) + SMALL_BOX_H);
}

function drawTail(page: PDFPage, w: Writer, inv: InvoiceData, shop: InvoiceShop, top: number, compact: boolean) {
  const rows = totalsRows(inv);
  const step = compact ? COMPACT_TOTAL_STEP : TOTAL_STEP;
  let y = top + 10;
  for (const r of rows) {
    const labelW = TOTALS_X;
    w.draw(page, w.ellipsize(r.label, COL_AMOUNT - labelW - 60, { size: 9.5 }), labelW, y, { size: 9.5, color: GREY });
    w.draw(page, r.value, COL_AMOUNT, y, { size: 9.5, align: 'right' });
    y += step;
  }
  const ruleTop = y - 6;
  hline(page, TOTALS_X, R, ruleTop, 1, INK);
  w.draw(page, inv.finalRow.label, TOTALS_X, ruleTop + 18, { size: 11, weight: 'bold' });
  w.draw(page, invoiceMoney(inv.finalRow.amount), COL_AMOUNT, ruleTop + 18, { size: 13, weight: 'extrabold', align: 'right' });

  const smallBox = compact && shop.community.show;
  const wordsTop = top + (smallBox ? 10 : Math.max(10, totalsHeight(inv, compact) / 2 - 12));
  w.draw(page, 'AMOUNT IN WORDS', M, wordsTop, SMALL_LABEL);
  wordsLines(w, inv).forEach((line, i) => w.draw(page, line, M, wordsTop + 15 + i * 13, { size: 10, weight: 'semibold' }));
  if (smallBox) drawSmallCommunity(page, w, shop, top + smallBoxOffset(w, inv));
}

/** The small community box (long orders): QR left, two lines right. */
function drawSmallCommunity(page: PDFPage, w: Writer, shop: InvoiceShop, top: number) {
  roundedRect(page, M, top, WORDS_W, SMALL_BOX_H, 8, { fill: PANEL });
  const qrX = M + 8;
  const qrTop = top + 6;
  roundedRect(page, qrX - 2, qrTop - 2, SMALL_QR + 4, SMALL_QR + 4, 3, { fill: WHITE });
  qrCode(page, shop.community.link, qrX, qrTop, SMALL_QR);
  const tx = qrX + SMALL_QR + 12;
  const maxW = M + WORDS_W - 10 - tx;
  const lines = w.wrap(shop.community.line2, maxW, { size: 7.5 }, 2);
  let y = top + SMALL_BOX_H / 2 - (lines.length > 1 ? 7 : 2);
  w.draw(page, w.ellipsize(shop.community.title, maxW, { size: 9, weight: 'bold' }), tx, y, { size: 9, weight: 'bold' });
  for (const line of lines) {
    y += 11;
    w.draw(page, line, tx, y, { size: 7.5, color: GREY });
  }
}

/** The big community box, right after the totals (short orders). */
function drawCommunity(page: PDFPage, w: Writer, shop: InvoiceShop, top: number) {
  roundedRect(page, M, top, R - M, COMMUNITY_H, 10, { fill: PANEL });
  const qrSize = 76;
  const qrX = R - 18 - qrSize;
  const qrTop = top + (COMMUNITY_H - qrSize) / 2;
  roundedRect(page, qrX - 5, qrTop - 5, qrSize + 10, qrSize + 10, 4, { fill: WHITE });
  qrCode(page, shop.community.link, qrX, qrTop, qrSize);
  const tx = M + 18;
  const maxW = qrX - 16 - tx;
  w.draw(page, w.ellipsize(shop.community.title, maxW, { size: 12, weight: 'bold' }), tx, top + 30, { size: 12, weight: 'bold' });
  w.draw(page, w.ellipsize(shop.community.line1, maxW, { size: 9 }), tx, top + 48, { size: 9, color: GREY });
  w.draw(page, w.ellipsize(shop.community.line2, maxW, { size: 9 }), tx, top + 61, { size: 9, color: GREY });
  rect(page, tx, top + 80, 40, 3, ORANGE);
}

function drawFooter(page: PDFPage, w: Writer, shop: InvoiceShop) {
  hline(page, M, R, FOOTER_RULE, 0.6, RULE);
  w.draw(page, `Thank you for shopping with ${shop.name}.`, M, FOOTER_RULE + 14, { size: 9, weight: 'bold' });
  const ask = shop.phone !== '' ? `Questions? WhatsApp ${shop.phone}` : 'Questions? Message us on WhatsApp.';
  w.draw(page, ask, M, FOOTER_RULE + 26, { size: 8, color: GREY });
  w.draw(page, 'This is a computer-generated invoice and needs no signature.', R, FOOTER_RULE + 26, {
    size: 7,
    color: GREY,
    align: 'right',
  });
}

function drawContinuationHead(page: PDFPage, w: Writer, inv: InvoiceData, shop: InvoiceShop, pageNo: number, pageCount: number) {
  w.draw(page, shop.name, M, 54, { size: 11, weight: 'extrabold', spacing: 2 });
  w.draw(page, `Invoice ${inv.invoiceNumber} · page ${pageNo} of ${pageCount}`, R, 54, { size: 8.5, color: GREY, align: 'right' });
  hline(page, M, R, 64, 0.6, RULE);
}

interface PagePlan {
  rows: RowLayout[];
  tail: boolean;
}

/** Splits one invoice into pages: rows while they fit, totals, community
 *  and footer on the last page only. */
function planPages(w: Writer, inv: InvoiceData, firstTableTop: number, shop: InvoiceShop, compact: boolean): PagePlan[] {
  const rows: RowLayout[] = inv.lines.map((line, index) => {
    const lines = w.wrap(line.name, ITEM_MAX_W, { size: 9 });
    return { index, lines, height: rowHeight(lines.length, compact) };
  });
  const rowLimit = 790;
  const tailLimit = FOOTER_RULE - 12;
  const pages: PagePlan[] = [{ rows: [], tail: false }];
  let y = firstTableTop + TABLE_HEAD_H;
  for (const row of rows) {
    if (y + row.height > rowLimit) {
      pages.push({ rows: [], tail: false });
      y = CONT_TABLE_TOP + TABLE_HEAD_H;
    }
    pages[pages.length - 1].rows.push(row);
    y += row.height;
  }
  const tailH = tailHeight(w, inv, shop, compact) + 4 + (shop.community.show && !compact ? COMMUNITY_GAP + COMMUNITY_H : 0);
  if (y + tailH > tailLimit) {
    const last = pages[pages.length - 1];
    const moved = last.rows.length >= 2 ? [last.rows.pop() as RowLayout] : [];
    pages.push({ rows: moved, tail: true });
  } else {
    pages[pages.length - 1].tail = true;
  }
  return pages;
}

function drawInvoice(doc: PDFDocument, w: Writer, inv: InvoiceData, shop: InvoiceShop) {
  const first = doc.addPage([W, H]);
  drawLabel(first, w, inv, shop);
  const firstTableTop = drawParties(first, w, inv, shop);
  const compact = inv.lines.length > COMPACT_AFTER;
  const plan = planPages(w, inv, firstTableTop, shop, compact);
  plan.forEach((pagePlan, i) => {
    const page = i === 0 ? first : doc.addPage([W, H]);
    if (i > 0) drawContinuationHead(page, w, inv, shop, i + 1, plan.length);
    let y = i === 0 ? firstTableTop : CONT_TABLE_TOP;
    if (pagePlan.rows.length > 0) {
      drawTableHead(page, w, y);
      y += TABLE_HEAD_H;
      for (const row of pagePlan.rows) {
        drawRow(page, w, inv, row, y, compact);
        y += row.height;
      }
    }
    if (pagePlan.tail) {
      // Sections follow each other; only the footer is pinned to the bottom.
      const tailTop = y + 4;
      drawTail(page, w, inv, shop, tailTop, compact);
      if (shop.community.show && !compact) drawCommunity(page, w, shop, tailTop + tailHeight(w, inv, shop, compact) + COMMUNITY_GAP);
      drawFooter(page, w, shop);
    } else {
      w.draw(page, `Continued on page ${i + 2} of ${plan.length}`, R, 812, { size: 7.5, color: GREY, align: 'right' });
    }
  });
}

/** One PDF with every invoice in order (each starts on a new page). */
export async function buildInvoicePdf(
  invoices: InvoiceData[],
  shop: InvoiceShop,
  files: InvoiceFontFiles
): Promise<InvoicePdfResult> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embedded = new Map<Uint8Array, Promise<Face>>();
  const face = (bytes: Uint8Array, shaped: boolean): Promise<Face> => {
    let found = embedded.get(bytes);
    if (!found) {
      found = doc.embedFont(bytes, { subset: true }).then((font) => ({
        font,
        chars: new Set(font.getCharacterSet()),
        shaper: shaped ? fontkit.create(bytes) : null,
      }));
      embedded.set(bytes, found);
    }
    return found;
  };
  const weights: InvoiceWeight[] = ['regular', 'medium', 'semibold', 'bold', 'extrabold'];
  const faces = { latin: {}, bengali: {} } as Record<'latin' | 'bengali', Record<InvoiceWeight, Face>>;
  for (const family of ['latin', 'bengali'] as const) {
    for (const weight of weights) faces[family][weight] = await face(files[family][weight], family === 'bengali');
  }
  const writer = new Writer(faces);
  for (const inv of invoices) drawInvoice(doc, writer, inv, shop);

  const title = invoices.length === 1 ? `Invoice ${invoices[0].invoiceNumber}` : `Invoices (${invoices.length})`;
  doc.setTitle(title);
  doc.setAuthor(shop.name);
  doc.setCreator(shop.name);
  doc.setProducer(shop.name);
  // Print at actual size (no "fit to page" shrinking the barcode).
  doc.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const bytes = await doc.save();
  return { bytes, pageCount: doc.getPageCount(), missingCharacters: Array.from(writer.missing) };
}
