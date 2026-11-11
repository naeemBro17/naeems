// Batch 43 Part 4: draws the one-page A4 investor report. Black text on
// white; the only colour is a small orange mark on the logo line. Plus
// Jakarta Sans (the invoice's font) for the text and Noto Sans Bengali only
// for the ৳ sign, both embedded (subset).
// fontkit's Bengali shaper (used for the ৳ sign) needs regenerator-runtime.
import 'regenerator-runtime/runtime.js';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import type { InvoiceFontFiles } from '../invoice/invoiceFonts';
import type { InvestorReportModel } from './investorReport';

export interface InvestorPdfResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Characters neither font could draw (printed as "?"). */
  missingCharacters: string[];
}

const W = 595.28;
const H = 841.89;
const M = 56;
const R = W - M;

function hex(color: string): RGB {
  const n = parseInt(color.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const INK = hex('#1C1C1E');
const GREY = hex('#6E6E73');
const RULE = hex('#D9D9DE');
const ORANGE = hex('#FF7A45');

interface Face {
  font: PDFFont;
  chars: Set<number>;
}

type Weight = 'regular' | 'semibold' | 'bold';

class Pen {
  readonly missing = new Set<string>();

  constructor(
    private readonly page: PDFPage,
    private readonly latin: Record<Weight, Face>,
    private readonly bengali: Record<Weight, Face>
  ) {}

  private runs(text: string, weight: Weight): { face: Face; text: string }[] {
    const out: { face: Face; text: string }[] = [];
    for (const original of text) {
      let ch = original;
      const cp = ch.codePointAt(0) ?? 0;
      let face: Face;
      if (this.latin[weight].chars.has(cp)) face = this.latin[weight];
      else if (this.bengali[weight].chars.has(cp)) face = this.bengali[weight];
      else {
        if (!/\s/u.test(ch)) this.missing.add(ch);
        ch = /\s/u.test(ch) ? ' ' : '?';
        face = this.latin[weight];
      }
      const last = out[out.length - 1];
      if (last && last.face === face) last.text += ch;
      else out.push({ face, text: ch });
    }
    return out;
  }

  width(text: string, size: number, weight: Weight = 'regular'): number {
    return this.runs(text, weight).reduce((w, r) => w + r.face.font.widthOfTextAtSize(r.text, size), 0);
  }

  /** Text on a baseline measured from the top of the page. */
  text(text: string, x: number, top: number, size: number, opts: { weight?: Weight; color?: RGB; align?: 'left' | 'right' } = {}): void {
    const weight = opts.weight ?? 'regular';
    let cx = opts.align === 'right' ? x - this.width(text, size, weight) : x;
    for (const run of this.runs(text, weight)) {
      this.page.drawText(run.text, { x: cx, y: H - top, size, font: run.face.font, color: opts.color ?? INK });
      cx += run.face.font.widthOfTextAtSize(run.text, size);
    }
  }

  /** Cuts the text with "…" until it fits. */
  fit(text: string, maxWidth: number, size: number, weight: Weight = 'regular'): string {
    if (this.width(text, size, weight) <= maxWidth) return text;
    const chars = Array.from(text);
    while (chars.length > 0 && this.width(`${chars.join('')}…`, size, weight) > maxWidth) chars.pop();
    return `${chars.join('').trimEnd()}…`;
  }

  /** Word-wrapped lines. */
  wrap(text: string, maxWidth: number, size: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/u)) {
      const next = line ? `${line} ${word}` : word;
      if (line && this.width(next, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  rule(top: number, color: RGB = RULE, x1 = M, x2 = R, thickness = 0.75): void {
    this.page.drawLine({ start: { x: x1, y: H - top }, end: { x: x2, y: H - top }, thickness, color });
  }
}

export async function buildInvestorPdf(model: InvestorReportModel, files: InvoiceFontFiles): Promise<InvestorPdfResult> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embed = async (bytes: Uint8Array): Promise<Face> => {
    const font = await doc.embedFont(bytes, { subset: true });
    return { font, chars: new Set(font.getCharacterSet()) };
  };
  const latin = { regular: await embed(files.latin.regular), semibold: await embed(files.latin.semibold), bold: await embed(files.latin.bold) };
  const bengali = { regular: await embed(files.bengali.regular), semibold: await embed(files.bengali.semibold), bold: await embed(files.bengali.bold) };
  const page = doc.addPage([W, H]);
  const pen = new Pen(page, latin, bengali);

  // Logo line: the only colour on the page.
  let y = 72;
  page.drawRectangle({ x: M, y: H - y - 16, width: 5, height: 18, color: ORANGE });
  pen.text(model.shop, M + 14, y + 14, 20, { weight: 'bold' });
  pen.text(model.title, R, y + 14, 11, { color: GREY, align: 'right' });
  y += 34;
  pen.rule(y, INK, M, R, 1);

  y += 34;
  pen.text(pen.fit(model.investor, R - M, 18, 'bold'), M, y, 18, { weight: 'bold' });
  y += 20;
  pen.text(model.period, M, y, 11, { color: GREY });

  const section = (title: string) => {
    y += 34;
    pen.text(title.toUpperCase(), M, y, 9, { weight: 'semibold', color: GREY });
    y += 8;
    pen.rule(y);
  };
  const row = (label: string, value: string, bold = false) => {
    y += 22;
    pen.text(label, M, y, 11, { weight: bold ? 'semibold' : 'regular' });
    pen.text(value, R, y, 11, { weight: bold ? 'bold' : 'semibold', align: 'right' });
    y += 8;
    pen.rule(y);
  };

  section('The business in this period');
  model.business.forEach((b, i) => row(b.label, b.value, i === 1));

  section(model.investor);
  model.investorRows.forEach((b) => row(b.label, b.value));

  section(model.monthsTitle);
  const colSales = R - 150;
  y += 18;
  pen.text('Month', M, y, 9, { weight: 'semibold', color: GREY });
  pen.text('Sales', colSales, y, 9, { weight: 'semibold', color: GREY, align: 'right' });
  pen.text('Net profit', R, y, 9, { weight: 'semibold', color: GREY, align: 'right' });
  y += 6;
  pen.rule(y);
  const step = model.months.length > 10 ? 16 : 18;
  for (const [month, sales, net] of model.months) {
    y += step;
    pen.text(month, M, y, 10);
    pen.text(sales, colSales, y, 10, { align: 'right' });
    pen.text(net, R, y, 10, { align: 'right' });
  }
  y += 6;
  pen.rule(y, INK);
  y += 16;
  pen.text(model.monthsTotal[0], M, y, 10, { weight: 'bold' });
  pen.text(model.monthsTotal[1], colSales, y, 10, { weight: 'bold', align: 'right' });
  pen.text(model.monthsTotal[2], R, y, 10, { weight: 'bold', align: 'right' });

  // Footer at the bottom of the page.
  const lines = pen.wrap(model.footer, R - M, 8);
  let fy = H - 48 - (lines.length - 1) * 11;
  pen.rule(fy - 16);
  for (const line of lines) {
    pen.text(line, M, fy, 8, { color: GREY });
    fy += 11;
  }

  doc.setTitle(`${model.shop} — ${model.title} — ${model.investor}`);
  doc.setAuthor(model.shop);
  doc.setCreator(model.shop);
  doc.setProducer(model.shop);
  const bytes = await doc.save();
  return { bytes, pageCount: doc.getPageCount(), missingCharacters: Array.from(pen.missing) };
}
