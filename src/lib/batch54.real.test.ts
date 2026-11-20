// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allocatePaid, buildDraft, receivablesNote } from './kaarbar/merge';
import { billProblems, readStatement, type PdfText } from './kaarbar/oldSales';

/* Batch 54: the reader on a real Kaarbar statement kept ONLY on Naeem's
   computer (a "<name>-statement.pdf" next to package.json, in .gitignore —
   it holds a real customer's phone and address). Skipped when the file is
   not there (CI, other computers). Nothing personal is printed: only
   counts and amounts are compared. */

const FILE = readdirSync('.').find((f) => /-statement\.pdf$/i.test(f)) ?? '';
const has = FILE !== '';

async function pieces(): Promise<PdfText[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(FILE)), verbosity: 0 });
  const pdf = await task.promise;
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
    await task.destroy();
  }
  return out;
}

describe.skipIf(!has)('the real statement (local only)', () => {
  it('7 bills, every line separate, every bill passes the checks and adds up; Money In ৳56,969; due ৳5,950', async () => {
    const result = readStatement(await pieces());
    expect(result.error).toBeNull();
    const s = result.statement;
    if (!s) throw new Error('not read');
    expect(s.bills).toHaveLength(7);
    expect(s.phoneKey).not.toBeNull();
    expect(s.partyName).not.toMatch(/tk\.?$/i);
    expect(s.bills.map((b) => b.lines.length)).toEqual([3, 5, 3, 10, 4, 6, 4]);
    for (const b of s.bills) {
      expect(billProblems(b), b.billNo).toEqual([]);
      expect(Math.round((b.itemsTotal + b.delivery - b.billDiscount) * 100) / 100, b.billNo).toBe(b.total);
      expect(b.lines.every((l) => !/(?:\btk\.?|৳)\s*\d/i.test(l.name)), b.billNo).toBe(true);
    }
    const moneyIn = s.bills.reduce((t, b) => t + (b.paid ?? 0), 0) + s.payments.reduce((t, p) => t + p.amount, 0);
    expect(moneyIn).toBe(56969);
    expect(s.totalReceivables).toBe(5950);
    expect(receivablesNote(s, allocatePaid(s))).toBeNull();
    expect(buildDraft(FILE, s, '2026-09-30').receipts).toHaveLength(7);
  });
});
