import { describe, expect, it } from 'vitest';
import { statementPieces } from './batch54.fixture';
import {
  allocatePaid,
  amountToMatchKaarbar,
  buildDraft,
  chipTexts,
  currentEdit,
  dueBox,
  itemsByKey,
  mergeRows,
  paidChip,
  receiptCheck,
  receiptStatus,
  receiptTotals,
  receivablesNote,
  reviewCounts,
  wrongCustomer,
  type MatchContext,
  type MergeDraft,
} from './kaarbar/merge';
import {
  billKey,
  billProblems,
  billProblemText,
  itemKey,
  previewStatements,
  readStatement,
  type PdfText,
  type SavedItem,
  type SiteChoice,
  type Statement,
  type StatementBill,
} from './kaarbar/oldSales';

/* Batch 54: the party statement reader on the real layout (positions,
   widths and font sizes copied from a real statement; the party, phone,
   address and remarks made up), the bill checks, Paid / Unpaid like the
   Kaarbar app, the Due box and the merge rows. No real customer here. */

const read = (pieces: PdfText[]) => {
  const r = readStatement(pieces);
  if (!r.statement) throw new Error(r.error ?? 'not read');
  return r.statement;
};

const bill = (s: Statement, no: string): StatementBill => {
  const b = s.bills.find((x) => x.billNo === no);
  if (!b) throw new Error(`no bill ${no}`);
  return b;
};

/* ----------------------------------------------- the reader (Part 1) */

describe('party statement reader — the real layout', () => {
  const s = read(statementPieces());

  it('reads the header: name, phone, Total Sales, Total Receivables, the report day', () => {
    expect(s.partyName).toBe('Test Party Two');
    expect(s.phoneKey).toBe('01700000002');
    expect(s.headerTotal).toBe(62919);
    expect(s.totalReceivables).toBe(5950);
    expect(s.reportDate).toBe('2026-11-20');
  });

  it('all 7 bills, each with its Rec/Paid, Due and first Remarks line', () => {
    expect(s.bills.map((b) => `${b.billNo}:${b.date}:${b.total}:${b.paid}:${b.due}`)).toEqual([
      'SS0858:2025-11-12:5020:5020:0',
      'SS0907:2026-01-19:4860:4860:0',
      'SS0877:2026-05-18:6099:6099:0',
      'SS0976:2026-05-18:18092:18092:0',
      'SS1013:2026-07-08:15947:15947:0',
      'SS1039:2026-07-24:6951:6951:0',
      '1105:2026-09-25:5950:0:5950',
    ]);
    expect(bill(s, 'SS0858').note).toBe('Payment received in full.');
    expect(bill(s, 'SS0877').note).toBe("Black Friday Sale '25 Upto 40% Discount.");
    expect(bill(s, '1105').note).toBe('22% Discount');
    expect(bill(s, 'SS0976').note).toBe('');
    // Money In = every Rec/Paid (+ Payment In rows: none in this file).
    expect(s.bills.reduce((t, b) => t + (b.paid ?? 0), 0) + s.payments.reduce((t, p) => t + p.amount, 0)).toBe(56969);
  });

  it('a long name that ends right before the Total column stays its own line (SS0858)', () => {
    const b = bill(s, 'SS0858');
    expect(b.lines.map((l) => `${l.name} = ${l.total}`)).toEqual([
      'CeraVe Hydrating Facial Cleanser (France)236 ML = 2100',
      'Beauty of Joseon Relief Sun : Rice + Probiotics (SPF50+ PA++++) = 1600',
      'Cerave Moisturising Cream 56ml (USA) = 1320',
    ]);
    expect(b.lines[0]).toMatchObject({ rate: 2750, discount: 650 }); // the discount wrapped onto the next line
    expect(b.billDiscount).toBe(0);
  });

  it('Blistex and NIVEA are two lines; the whole-bill discount is ৳145 (SS1039)', () => {
    const b = bill(s, 'SS1039');
    expect(b.lines).toHaveLength(6);
    expect(b.lines[3]).toMatchObject({ name: 'Blistex Ultra Lip Balm SPF 50+ 4.25gm Stick', total: 799 });
    expect(b.lines[4]).toMatchObject({ name: 'NIVEA Watermelon Shine Lip Balm 4.8g', total: 499, rate: 500, discount: 1 });
    expect(b).toMatchObject({ itemsTotal: 6946, delivery: 150, billDiscount: 145 });
  });

  it('a 3-line name, 150 PCS, 473 ML, a bill split over a page break', () => {
    expect(bill(s, 'SS0907').lines[0].name).toBe('Skin1004 Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+ PA++++ 50ml');
    expect(bill(s, 'SS1013').lines[0]).toMatchObject({ quantity: 150, unit: 'pcs', rate: 80, discount: 4350, total: 7650 });
    const b = bill(s, '1105'); // its header is the last row of page 2, its items are on page 3
    expect(b.lines.map((l) => l.total)).toEqual([2050, 1500, 3999, 150]);
    expect(b.lines[2]).toMatchObject({ quantity: 473, unit: 'ml', rate: 8.5, discount: 21.5 });
    expect(itemKey(b.lines[2].name)).toBe(itemKey('CeraVe Hydrating Cleanser Eco-Recharge Refill 473ml'));
  });

  it('every bill passes the checks and adds up: lines + delivery − bill discount = bill total', () => {
    for (const b of s.bills) {
      expect(billProblems(b), b.billNo).toEqual([]);
      expect(Math.round((b.itemsTotal + b.delivery - b.billDiscount) * 100) / 100, b.billNo).toBe(b.total);
      expect(b.billDiscount, b.billNo).toBeGreaterThanOrEqual(0);
    }
  });

  it('a name and its price glued into one piece ("…473mlTk. 3,999") are split at the Total column', () => {
    const pieces = statementPieces().filter((p) => !(p.page === 3 && (p.str === 'CeraVe Hydrating Cleanser Eco-' || p.str === 'Recharge Refill 473ml' || (p.str === 'Tk. 3,999' && p.x > 260 && p.x < 262))));
    pieces.push({ page: 3, y: 746.7, x: 109.1, w: 301.7 - 109.1, h: 9, str: 'CeraVe Hydrating Cleanser Eco-Recharge Refill 473mlTk. 3,999' });
    const b = bill(read(pieces), '1105');
    expect(b.lines[2]).toMatchObject({ name: 'CeraVe Hydrating Cleanser Eco-Recharge Refill 473ml', total: 3999, quantity: 473, unit: 'ml' });
    expect(billProblems(b)).toEqual([]);
  });

  it('Payment In rows are read (date and amount), not as bills', () => {
    const pieces = statementPieces();
    const row = (y: number, cells: [string, number][]) => cells.forEach(([str, x]) => pieces.push({ page: 3, y, x, w: str.length * 4.6, h: 9, str }));
    row(676, [['08 Oct 2026', 30], ['Payment In #37', 109.1], ['--', 261.2], ['Tk. 3,950', 340.3], ['Tk. 0', 419.4], ['Tk. 2,000', 498.4]]);
    row(652, [['09 Oct 2026', 30], ['Payment In #38', 109.1], ['--', 261.2], ['Tk. 2,000', 340.3], ['Tk. 0', 419.4], ['Tk. 0', 498.4]]);
    const st = read(pieces);
    expect(st.bills).toHaveLength(7);
    expect(st.payments).toEqual([
      { date: '2026-10-08', amount: 3950 },
      { date: '2026-10-09', amount: 2000 },
    ]);
  });
});

describe('bill checks', () => {
  const line = (name: string, quantity: number, rate: number, discount: number, total: number) => ({ name, quantity, rate, discount, total });

  it("a lost line: ৳x less than Kaarbar's total", () => {
    const p = billProblems({ total: 5020, lines: [line('A', 1, 2750, 650, 2100), line('B', 1, 1760, 440, 1320)] });
    expect(p).toEqual([{ kind: 'short', amount: 1600 }]);
    expect(billProblemText(p[0], true)).toBe("Doesn't add up: ৳1,600 less than Kaarbar's total. Tap to check.");
  });

  it('a positive whole-bill discount is normal (Black Friday ৳3,601)', () => {
    expect(billProblems({ total: 6099, lines: [line('A', 1, 3100, 0, 3100), line('B', 1, 3100, 0, 3100), line('C', 1, 3500, 0, 3500)] })).toEqual([]);
  });

  it('line maths wrong, and a name holding a price', () => {
    expect(billProblems({ total: 500, lines: [line('A', 2, 300, 0, 500)] })).toEqual([{ kind: 'maths', name: 'A' }]);
    const merged = line('Blistex Ultra Lip Balm NIVEA Watermelon Tk. 499', 1, 850, 51, 799);
    expect(billProblems({ total: 799, lines: [merged] })).toEqual([{ kind: 'price-in-name', name: merged.name }]);
  });

  it('the old Step 2 card refuses a bill that does not add up, with the reason', () => {
    const s = read(statementPieces());
    const broken: Statement = { ...s, bills: s.bills.map((b) => (b.billNo === 'SS0858' ? { ...b, lines: b.lines.filter((l) => l.total !== 1600) } : b)) };
    const [p] = previewStatements([{ fileName: 'x.pdf', statement: broken }], { cutoff: '2026-09-30', done: new Set(), items: new Map() });
    expect(p.bills.find((b) => b.billNo === 'SS0858')).toMatchObject({ status: 'bad', reason: "Doesn't add up: ৳1,600 less than Kaarbar's total." });
  });
});

/* ------------------------------------------------- Paid / Unpaid (2.5) */

describe('paid and due per bill, like the Kaarbar app', () => {
  const sale = (billNo: string, date: string, total: number, paid: number | null): StatementBill => ({
    kind: 'sale', billNo, date, total, paid, due: null, note: '', lines: [], itemsTotal: total, delivery: 0, billDiscount: 0,
  });
  // The made-up figures of a customer who paid in parts, two payments in
  // October (after the cut-off) paying September's bills.
  const bills = [
    sale('SS0858', '2025-11-12', 5020, 5020),
    sale('SS0976', '2026-05-18', 16092, 0),
    sale('SS1013', '2026-07-08', 15947, 0),
    sale('SS1039', '2026-07-24', 6951, 0),
    sale('1105', '2026-09-25', 5950, 0),
  ];
  const payments = [
    { date: '2026-07-11', amount: 3000 },
    { date: '2026-07-22', amount: 7000 },
    { date: '2026-08-02', amount: 4600 },
    { date: '2026-08-25', amount: 10400 },
    { date: '2026-10-08', amount: 11990 },
    { date: '2026-10-08', amount: 2000 },
  ];

  it('oldest first; the October payments go to the bills still unpaid; the dues add up to the receivable', () => {
    const paid = allocatePaid({ bills, payments });
    const show = (no: string) => {
      const p = paid.get(`sale:${no}`);
      return p ? `${p.paid}/${p.due}/${paidChip(p).text}` : '';
    };
    expect(['SS0858', 'SS0976', 'SS1013', 'SS1039', '1105'].map(show)).toEqual([
      '5020/0/Paid',
      '16092/0/Paid',
      '15947/0/Paid',
      '6951/0/Paid',
      '0/5950/Unpaid',
    ]);
    expect(receivablesNote({ bills, totalReceivables: 5950 }, paid)).toBeNull();
    expect(receivablesNote({ bills, totalReceivables: 6000 }, paid)).toBe("Kaarbar's receipts add up to ৳5,950; its due says ৳6,000.");
  });

  it('part paid; a sales return counts like a payment', () => {
    const paid = allocatePaid({ bills, payments: payments.slice(0, 5) });
    expect(paidChip(paid.get('sale:SS1039') ?? { paid: 0, due: 0 })).toEqual({ tone: 'part', text: 'Part paid' });
    const ret: StatementBill = { ...sale('R1', '2026-10-09', 2000, 0), kind: 'return' };
    const withReturn = allocatePaid({ bills: [...bills, ret], payments: payments.slice(0, 5) });
    expect(withReturn.get('sale:SS1039')).toEqual({ paid: 6951, due: 0 });
  });

  it('the real layout: each bill keeps its own Rec/Paid; 1105 unpaid ৳5,950 = Total Receivables', () => {
    const s = read(statementPieces());
    const paid = allocatePaid(s);
    expect(paid.get('sale:1105')).toEqual({ paid: 0, due: 5950 });
    expect(paid.get('sale:SS1039')).toEqual({ paid: 6951, due: 0 });
    expect(receivablesNote(s, paid)).toBeNull();
  });
});

/* ---------------------------------------------------------- due box */

describe('the Due box', () => {
  it('the four cases', () => {
    expect(dueBox(5950, 5950)).toMatchObject({ tone: 'ok', text: 'Same', same: true, differs: false });
    expect(dueBox(5950, 5150)).toMatchObject({ tone: 'bad', text: '৳800 apart', differs: true });
    expect(dueBox(2300, 0)).toMatchObject({ tone: 'warn', text: 'Site has ৳0', differs: false });
    expect(dueBox(0, 1200)).toMatchObject({ tone: 'warn', text: 'Kaarbar has ৳0' });
    expect(dueBox(5950, 5950.4).same).toBe(true);
  });

  it('"Use this": Kaarbar − site orders due; hidden below 0', () => {
    expect(amountToMatchKaarbar(5950, 0)).toBe(5950);
    expect(amountToMatchKaarbar(5950, 1200)).toBe(4750);
    expect(amountToMatchKaarbar(1000, 1200)).toBeNull();
  });
});

/* ------------------------------------------------- review and merge */

const choice = (productId: string, name: string, costPerPack: number | null): SiteChoice => ({
  productId, variantId: null, name, option: null, isActive: true, stockUnit: 'pcs', packSize: 1, costPerPack, madeByImport: false,
});

describe('review page: receipts, statuses and the merge rows', () => {
  const s = read(statementPieces());
  const all = s.bills.flatMap((b) => b.lines.filter((l) => !l.isDelivery));
  const choices = [choice('p1', 'Site Product', 500)];
  const saved: SavedItem[] = [...new Set(all.map((l) => l.key))]
    .filter((k) => k !== itemKey('NIVEA Watermelon Shine Lip Balm 4.8g'))
    .map((key, i): SavedItem => ({
      id: `i${i}`, key, name: key, kaarbarPrice: 0, productId: 'p1', variantId: null, madeProductId: null, how: 'auto',
      costPerPack: 100, unitCosts: key === itemKey('CeraVe Hydrating Cleanser Eco-Recharge Refill 473ml') ? {} : ({ pcs: 40 } as Record<string, number>), billLines: 0,
    }));
  const draft = buildDraft('x.pdf', s, '2026-09-30');
  const ctx = (edits: MergeDraft['edits'] = {}): MatchContext => ({ items: itemsByKey(saved), edits, choices });

  it('newest first, up to the cut-off', () => {
    expect(draft.receipts.map((r) => r.billNo)).toEqual(['1105', 'SS1039', 'SS1013', 'SS0976', 'SS0877', 'SS0907', 'SS0858']);
    expect(draft.later).toBe(0);
    expect(buildDraft('x.pdf', s, '2026-08-31').later).toBe(1);
    expect(draft.receipts[0]).toMatchObject({ paid: 0, due: 5950, note: '22% Discount' });
  });

  it('item not on the site; a unit line with no unit price; ready; already merged', () => {
    const done = new Set(['sale:SS0858']);
    const st = draft.receipts.map((r) => receiptStatus(r, ctx(), done));
    const by = (no: string) => st[draft.receipts.findIndex((r) => r.billNo === no)];
    expect(by('SS1039')).toMatchObject({ tone: 'warn', text: '1 item is not on the site', needs: true });
    expect(by('1105')).toMatchObject({ tone: 'warn', text: '1 item needs a buying price' });
    expect(by('SS0976')).toMatchObject({ tone: 'ok', text: 'Ready', ready: true });
    expect(by('SS0858')).toMatchObject({ tone: 'muted', text: 'Already merged', already: true });
    const counts = reviewCounts(st);
    expect(chipTexts(counts).map((c) => c.text)).toEqual(['7 receipts', '4 ready', '2 need a product']);
    expect(mergeRows(draft, ctx(), done)).toBeNull();
  });

  it('a receipt that lost a line is red until "+ Add a missing item" puts it back', () => {
    const r = draft.receipts.find((x) => x.billNo === 'SS0858');
    if (!r) throw new Error('no SS0858');
    const lost = { ...r, lines: r.lines.filter((l) => l.total !== 1600) };
    expect(receiptStatus(lost, ctx(), new Set())).toMatchObject({ tone: 'bad', flag: true, text: "Doesn't add up: ৳1,600 less than Kaarbar's total. Tap to check." });
    const t = receiptTotals(lost);
    expect(t).toMatchObject({ itemsPlusDelivery: 3420, billDiscount: 0, total: 3420 });
    expect(receiptCheck(t)).toEqual({ ok: false, text: "Doesn't add up: ৳1,600 less than Kaarbar's total." });
    const fixed = { ...lost, lines: [...lost.lines, { id: 'h1', fromPdf: false, name: 'Beauty of Joseon Relief Sun : Rice + Probiotics (SPF50+ PA++++)', quantity: 1, unit: null, rate: 2100, discount: 500, total: 1600, isDelivery: false }] };
    expect(receiptStatus(fixed, ctx(), new Set())).toMatchObject({ ready: true });
    expect(receiptCheck(receiptTotals(fixed))).toEqual({ ok: true, text: "Adds up to Kaarbar's total" });
  });

  it('Add as new + a unit price → every receipt ready; the rows Merge sends', () => {
    const nivea = itemKey('NIVEA Watermelon Shine Lip Balm 4.8g');
    const refill = itemKey('CeraVe Hydrating Cleanser Eco-Recharge Refill 473ml');
    const c0 = ctx();
    const edits: MergeDraft['edits'] = {
      [nivea]: { ...currentEdit(nivea, 'NIVEA Watermelon Shine Lip Balm 4.8g', c0), how: 'hidden', choice: null, productName: 'NIVEA Lip Balm 4.8g', costPerPack: 320 },
      [refill]: { ...currentEdit(refill, 'x', c0), unitCosts: { ml: 6.5 } },
    };
    const rows = mergeRows({ ...draft, edits }, ctx(edits), new Set());
    if (!rows) throw new Error('not ready');
    expect(rows.bills).toHaveLength(7);
    expect(rows.bills[0]).toMatchObject({ bill_no: '1105', paid_amount: 0, due_amount: 5950, note: '22% Discount', bill_total: 5950, bill_discount: 1749, delivery: 150 });
    expect(rows.bills[1].lines.map((l) => l.line_total)).toEqual([2399, 1250, 1999, 799, 499]);
    expect(rows.items).toEqual([
      expect.objectContaining({ name_key: refill, choice: 'auto', product_id: 'p1', cost_per_pack: 100, unit_costs: { ml: 6.5 } }),
      expect.objectContaining({ name_key: nivea, choice: 'hidden', product_id: null, cost_per_pack: 320, product_name: 'NIVEA Lip Balm 4.8g' }),
    ]);
  });
});

describe('wrong customer', () => {
  const s = { partyName: 'Test Party Two', phone: '01700000002', phoneKey: '01700000002' };
  it('by phone; by name when the customer has no phone', () => {
    expect(wrongCustomer(s, { name: 'Anyone', phone: '+8801700000002' })).toBeNull();
    expect(wrongCustomer(s, { name: 'Test Party Two', phone: '01700000003' })).toBe('This statement is for Test Party Two (01700000002), not this customer.');
    expect(wrongCustomer(s, { name: 'test party two', phone: '' })).toBeNull();
    expect(wrongCustomer(s, { name: 'Someone Else', phone: '' })).not.toBeNull();
  });
});

describe('bill keys stay the same as Batch 50', () => {
  it('sale:no / return:no', () => {
    expect(billKey({ kind: 'return', billNo: 'R5' })).toBe('return:R5');
  });
});
