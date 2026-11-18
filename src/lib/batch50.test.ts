import { describe, expect, it } from 'vitest';
import {
  billCounts,
  billImportRows,
  buildDrafts,
  correctionView,
  derivedUnitCost,
  itemCounts,
  itemKey,
  itemSaveRows,
  nameScore,
  OLD_LAYOUT,
  parseQuantity,
  pickChoice,
  pickHidden,
  previewStatements,
  readItemList,
  readStatement,
  spreadDiscount,
  suggestMatch,
  tkAmount,
  unitNeeds,
  type PdfText,
  type SavedItem,
  type SiteChoice,
} from './kaarbar/oldSales';

/* Batch 50: old Kaarbar sales — the Item List, the name matcher, the party
   statement reader (made-up text positions in the real layout), per-unit
   cost, the bill-discount spread and the previous-balance correction. No
   real customer appears here. */

/* ------------------------------------------------------------ Item List */

describe('Item List Report', () => {
  it('reads Item Name and Purchase Price under a title row, skips blanks and a totals line', () => {
    const read = readItemList([
      ['Item List Report', null],
      [],
      ['Item Name', 'Purchase Price'],
      ['CeraVe Hydrating Cleanser 236 ML', 0],
      ['  Blackmores   Fish Oil ', '1,250'],
      [null, null],
      ['Total', 1250],
    ]);
    expect(read.error).toBeNull();
    expect(read.rows).toEqual([
      { n: 4, name: 'CeraVe Hydrating Cleanser 236 ML', key: 'ceravehydratingcleanser236ml', price: 0 },
      { n: 5, name: 'Blackmores Fish Oil', key: 'blackmoresfishoil', price: 1250 },
    ]);
  });

  it('a name that is the same without spaces / punctuation is one item', () => {
    const read = readItemList([['Item Name', 'Purchase Price'], ['Eco-Recharge Refill', 0], ['Eco Recharge  Refill', 5]]);
    expect(read.rows).toHaveLength(1);
    expect(read.twice).toEqual(['Eco Recharge Refill']);
  });

  it('refuses another report plainly', () => {
    expect(readItemList([['Party Name', 'Contact']]).error).toContain('Purchase Price');
  });
});

/* --------------------------------------------------------- name matcher */

const choice = (name: string, option: string | null = null, extra: Partial<SiteChoice> = {}): SiteChoice => ({
  productId: `p-${name}`,
  variantId: option ? `v-${option}` : null,
  name,
  option,
  isActive: true,
  stockUnit: 'pcs',
  packSize: 1,
  costPerPack: 1000,
  madeByImport: false,
  ...extra,
});

describe('name matcher', () => {
  it('ignores case, spaces, punctuation, Moisturising / Moisturizing, 236 ML / 236ml, (Australia/USA)', () => {
    expect(nameScore('CeraVe Moisturising Lotion 236 ML (Australia/USA)', 'Cerave moisturizing lotion 236ml')).toBeGreaterThanOrEqual(0.85);
  });

  it('different sizes never match', () => {
    expect(nameScore('CeraVe Foaming Cleanser 236 ML', 'CeraVe Foaming Cleanser 473ml')).toBe(0);
  });

  it('auto-matches only when sure, to the right option', () => {
    const choices = [
      choice('CeraVe Foaming Cleanser USA', '355 ml'),
      choice('CeraVe Foaming Cleanser USA', '473 ml'),
      choice('Nivea Men Body Wash 3 In 1 Shower Gel'),
    ];
    const sure = suggestMatch('CeraVe Foaming Cleanser 473 ML (USA)', choices);
    expect(sure.confident).toBe(true);
    expect(sure.best?.option).toBe('473 ml');
    // No size: two options are equally likely → Naeem picks.
    expect(suggestMatch('CeraVe Foaming Cleanser', choices).confident).toBe(false);
    expect(suggestMatch('Something Else Entirely', choices).confident).toBe(false);
  });

  it('never matches a hidden product the import made on its own', () => {
    expect(suggestMatch('Old Thing 50ml', [choice('Old Thing 50ml', null, { madeByImport: true })]).best).toBeNull();
  });
});

/* -------------------------------------------------------- Step 1 drafts */

describe('Step 1 list', () => {
  const site = choice('Blackmores Omega Triple Super Strength Fish Oil', null, { costPerPack: 2400 });
  const rows = [
    { n: 2, name: 'Blackmores Omega Triple Super Strength Fish Oil', key: itemKey('Blackmores Omega Triple Super Strength Fish Oil'), price: 0 },
    { n: 3, name: 'Unknown Toner', key: 'unknowntoner', price: 350 },
    { n: 4, name: 'Mystery Cream', key: 'mysterycream', price: 0 },
  ];

  it('matched → the site buying price; no sure match → a new hidden product with the Kaarbar price, else empty', () => {
    const d = buildDrafts(rows, [], [site]);
    expect(d[0]).toMatchObject({ how: 'auto', price: '2400', priceFrom: 'site' });
    expect(d[1]).toMatchObject({ how: 'hidden', price: '350', priceFrom: 'kaarbar' });
    expect(d[2]).toMatchObject({ how: 'hidden', price: '', priceFrom: 'none' });
    expect(itemCounts(d)).toEqual({ matched: 1, byHand: 0, hidden: 2, noPrice: 1 });
    expect(itemSaveRows(d)).toBeNull();
  });

  it('picking by hand / as hidden; then everything can be saved', () => {
    let d = buildDrafts(rows, [], [site]);
    d = [d[0], pickChoice(d[1], site), pickHidden({ ...d[2], price: '120', priceFrom: 'typed' })];
    expect(d[1]).toMatchObject({ how: 'hand', price: '2400', priceFrom: 'site' });
    expect(d[2]).toMatchObject({ how: 'hidden', price: '120' });
    const save = itemSaveRows(d);
    expect(save).not.toBeNull();
    expect(save?.[2]).toMatchObject({ choice: 'hidden', product_id: null, cost_per_pack: 120 });
  });

  it('what is saved wins over a new suggestion, and saved items not in the file stay', () => {
    const saved: SavedItem = {
      id: 'i1', key: 'mysterycream', name: 'Mystery Cream', kaarbarPrice: 0, productId: 'made-1', variantId: null,
      madeProductId: 'made-1', how: 'hidden', costPerPack: 90, unitCosts: {}, billLines: 0,
    };
    const other: SavedItem = { ...saved, id: 'i2', key: 'oldone', name: 'Old One', how: 'hand', productId: site.productId };
    const d = buildDrafts(rows, [saved, other], [site]);
    expect(d.find((x) => x.key === 'mysterycream')).toMatchObject({ how: 'hidden', price: '90', priceFrom: 'saved' });
    expect(d.find((x) => x.key === 'oldone')).toMatchObject({ how: 'hand' });
  });
});

/* ------------------------------------------------ party statement (PDF) */

const H = 8;
const TX = { date: 30, part: 110, total: 230, paid: 300, due: 370, bal: 440 };
const IT = { name: 44, total: 230, qty: 300, rate: 360, disc: 430 };

class Doc {
  items: PdfText[] = [];
  y = 800;
  page = 1;
  line(cells: [string, number][], dy = 12) {
    for (const [str, x] of cells) this.items.push({ str, x, y: this.y, w: str.length * H * 0.5, h: H, page: this.page });
    this.y -= dy;
  }
  newPage() {
    this.page++;
    this.y = 800;
  }
}

function header(d: Doc, total: string, layout: 'new' | 'old' = 'new') {
  d.line([['Party Statement of Test Party One', 30], [`Total Sales (Sales - Sales Return): Tk. ${total}`, 300]]);
  d.line([['Address: Test Road', 30], ['Total Purchases (Purchase - Purchase Return): Tk. 0', 300]]);
  d.line([['Phone No: 01700000001', 30], ['Money In: Tk. 1', 300]]);
  d.line([['Total Transactions : 9', 30], ['Report Generated on: 18 Nov 2026 • 5:39 PM', 300]]);
  if (layout === 'old') {
    d.line([['Date', TX.date], ['Particulars', TX.part], ['Debit', TX.total], ['Credit', TX.paid], ['Running Balance', TX.due]]);
    return;
  }
  d.line([['Date', TX.date], ['Particulars', TX.part], ['Total', TX.total], ['Rec/Paid Amt', TX.paid], ['Due', TX.due], ['Running Balance', TX.bal]]);
}

function tx(d: Doc, date: string, part: string, total: string) {
  d.line([[date, TX.date], [part, TX.part], [`Tk. ${total}`, TX.total], [`Tk. ${total}`, TX.paid], ['Tk. 0', TX.due], ['Tk. 0', TX.bal]]);
}

function itemHeader(d: Doc) {
  d.line([['Items', IT.name], ['Total', IT.total], ['Quantity', IT.qty], ['Rate', IT.rate], ['Discount', IT.disc]]);
}

function item(d: Doc, name: string[], total: string, qty: string, rate: string, disc: string[] = ['--']) {
  const n = Math.max(name.length, disc.length);
  for (let i = 0; i < n; i++) {
    const cells: [string, number][] = [];
    if (name[i]) cells.push([name[i], IT.name]);
    if (i === 0) cells.push([`Tk. ${total}`, IT.total], [qty, IT.qty], [`Tk. ${rate}`, IT.rate]);
    if (disc[i]) cells.push([disc[i], IT.disc]);
    d.line(cells, i === n - 1 ? 14 : 10);
  }
}

/** The layout of the brief: wrapped names, a wrapped discount, PCS, ML,
 *  Delivery Charge, a whole-bill discount, Payment In, a return and a bill
 *  after the cut-off. File total = 5,020 + 6,099 + 15,947 + 5,950 + 1,000 − 500 = 33,516. */
function sampleStatement(): PdfText[] {
  const d = new Doc();
  header(d, '33,516');
  tx(d, '12 Nov 2025', 'Sale #SS0858', '5,020');
  itemHeader(d);
  item(d, ['CeraVe Hydrating Facial Cleanser', '(France)236 ML'], '2,100', '1', '2,750', ['Tk. 650', '(23.63%)']);
  item(d, ['Test Toner 100ml'], '2,790', '1', '2,790');
  item(d, ['Delivery Charge'], '130', '1', '130');
  d.line([['Remarks: Payment Has Been Received. TRX: X1', IT.name]]);
  tx(d, '18 May 2026', 'Sale #SS0877', '6,099');
  itemHeader(d);
  item(d, ['Test Serum A'], '4,000', '2', '2,000');
  item(d, ['Test Serum B'], '3,000', '1', '3,000');
  item(d, ['Test Toner 100ml'], '2,700', '1', '2,700');
  d.newPage();
  tx(d, '08 Jul 2026', 'Sale #SS1013', '15,947');
  itemHeader(d);
  item(d, ['Blackmores Omega Triple Super', 'Strength Fish Oil'], '7,650', '150 PCS', '80', ['Tk. 4,350', '(36.25%)']);
  item(d, ['Test Serum A'], '8,297', '4', '2,074.25');
  tx(d, '11 Jul 2026', 'Payment In #14', '3,000');
  d.line([['Remarks: You have received Tk 3,000.00', IT.name]]);
  tx(d, '25 Sep 2026', 'Sale #1105', '5,950');
  itemHeader(d);
  item(d, ['CeraVe Hydrating Cleanser Eco-', 'Recharge Refill 473ml'], '3,999', '473 ML', '8.50', ['Tk. 21.50', '(0.53%)']);
  item(d, ['Test Serum B'], '1,951', '1', '1,951');
  tx(d, '28 Sep 2026', 'Sales Return #R5', '500');
  itemHeader(d);
  item(d, ['Test Toner 100ml'], '500', '1', '500');
  tx(d, '05 Oct 2026', 'Sale #1200', '1,000');
  itemHeader(d);
  item(d, ['Test Serum B'], '1,000', '1', '1,000');
  return d.items;
}

describe('party statement reader', () => {
  const read = readStatement(sampleStatement());
  const s = read.statement;

  it('reads the header: name, phone, Total Sales', () => {
    expect(read.error).toBeNull();
    expect(s?.partyName).toBe('Test Party One');
    expect(s?.phoneKey).toBe('01700000001');
    expect(s?.headerTotal).toBe(33516);
  });

  it('keeps sales and the return, leaves Payment In out', () => {
    expect(s?.bills.map((b) => `${b.kind}:${b.billNo}:${b.date}`)).toEqual([
      'sale:SS0858:2025-11-12',
      'sale:SS0877:2026-05-18',
      'sale:SS1013:2026-07-08',
      'sale:1105:2026-09-25',
      'return:R5:2026-09-28',
      'sale:1200:2026-10-05',
    ]);
    expect(s?.otherRows).toBe(1);
  });

  it('wrapped names, the wrapped discount and Delivery Charge', () => {
    const b = s?.bills[0];
    expect(b?.lines.map((l) => l.name)).toEqual(['CeraVe Hydrating Facial Cleanser (France)236 ML', 'Test Toner 100ml', 'Delivery Charge']);
    expect(b?.lines[0]).toMatchObject({ quantity: 1, unit: null, rate: 2750, discount: 650, total: 2100, isDelivery: false });
    expect(b?.lines[2].isDelivery).toBe(true);
    expect(b).toMatchObject({ total: 5020, itemsTotal: 4890, delivery: 130, billDiscount: 0 });
  });

  it('a whole-bill discount is the lines minus the bill Total', () => {
    expect(s?.bills[1]).toMatchObject({ itemsTotal: 9700, total: 6099, billDiscount: 3601 });
  });

  it('150 PCS and 473 ML keep their unit; a wrapped name across a page break', () => {
    expect(s?.bills[2].lines[0]).toMatchObject({ name: 'Blackmores Omega Triple Super Strength Fish Oil', quantity: 150, unit: 'pcs', rate: 80, discount: 4350, total: 7650 });
    expect(s?.bills[3].lines[0]).toMatchObject({ quantity: 473, unit: 'ml', rate: 8.5, discount: 21.5, total: 3999 });
    expect(itemKey(s?.bills[3].lines[0].name ?? '')).toBe(itemKey('CeraVe Hydrating Cleanser Eco-Recharge Refill 473ml'));
  });

  it('refuses the old Debit / Credit layout', () => {
    const d = new Doc();
    header(d, '100', 'old');
    expect(readStatement(d.items).error).toBe(OLD_LAYOUT);
  });

  it('refuses a PDF that is not a party statement', () => {
    expect(readStatement([{ str: 'Invoice', x: 1, y: 1, w: 10, h: 8, page: 1 }]).error).toContain('not a Kaarbar party statement');
  });

  it('centred cells: the Total sits between the two lines of a wrapped name', () => {
    const d = new Doc();
    header(d, '300');
    tx(d, '01 Aug 2026', 'Sale #C1', '300');
    itemHeader(d);
    d.line([['First Long Product', IT.name]], 5);
    d.line([['Tk. 200', IT.total], ['1', IT.qty], ['Tk. 200', IT.rate], ['--', IT.disc]], 5);
    d.line([['Name Wrapped', IT.name]], 14);
    d.line([['Second Item', IT.name], ['Tk. 100', IT.total], ['1', IT.qty], ['Tk. 100', IT.rate], ['--', IT.disc]], 14);
    const bill = readStatement(d.items).statement?.bills[0];
    expect(bill?.lines.map((l) => l.name)).toEqual(['First Long Product Name Wrapped', 'Second Item']);
  });
});

describe('amounts and quantities', () => {
  it('reads Tk. amounts', () => {
    expect(tkAmount('Tk. 5,020')).toBe(5020);
    expect(tkAmount('Tk. 8.50')).toBe(8.5);
    expect(tkAmount('--')).toBeNull();
  });

  it('reads quantities with a unit', () => {
    expect(parseQuantity('150 PCS')).toEqual({ quantity: 150, unit: 'pcs' });
    expect(parseQuantity('473 ML')).toEqual({ quantity: 473, unit: 'ml' });
    expect(parseQuantity('1')).toEqual({ quantity: 1, unit: null });
    expect(parseQuantity('abc')).toBeNull();
  });
});

/* ------------------------------------------------------- bills preview */

describe('bills preview', () => {
  const statement = readStatement(sampleStatement()).statement;
  const known = ['CeraVe Hydrating Facial Cleanser (France)236 ML', 'Test Toner 100ml', 'Test Serum A', 'Test Serum B', 'Blackmores Omega Triple Super Strength Fish Oil', 'CeraVe Hydrating Cleanser Eco-Recharge Refill 473ml'];
  const items = new Map<string, SavedItem>(
    known.map((name, i) => [
      itemKey(name),
      { id: `i${i}`, key: itemKey(name), name, kaarbarPrice: 0, productId: `p${i}`, variantId: null, madeProductId: null, how: 'auto', costPerPack: i === 5 ? 3000 : 1000, unitCosts: {}, billLines: 0 },
    ])
  );
  const ctx = { cutoff: '2026-09-30', done: new Set(['sale:SS0858']), items };

  it('header check, cut-off, already added', () => {
    if (!statement) throw new Error('no statement');
    const [p] = previewStatements([{ fileName: 'a.pdf', statement }], ctx);
    expect(p.fileTotal).toBe(33516);
    expect(p.matches).toBe(true);
    expect(p.bills.map((b) => b.status)).toEqual(['already', 'new', 'new', 'new', 'new', 'after']);
    expect(billCounts([p])).toEqual({ toAdd: 4, already: 1, after: 1, unknown: 0, bad: 0 });
  });

  it('a file whose bills do not add up to Total Sales does not match, and is not imported', () => {
    if (!statement) throw new Error('no statement');
    const [p] = previewStatements([{ fileName: 'a.pdf', statement: { ...statement, headerTotal: 40000 } }], ctx);
    expect(p.matches).toBe(false);
    expect(billImportRows([p], items, new Map())).toEqual([]);
  });

  it('an item not in the Step 1 list blocks that bill', () => {
    if (!statement) throw new Error('no statement');
    const fewer = new Map([...items].filter(([k]) => k !== itemKey('Test Serum B')));
    const [p] = previewStatements([{ fileName: 'a.pdf', statement }], { ...ctx, items: fewer });
    expect(p.bills[1]).toMatchObject({ status: 'unknown', unknown: ['Test Serum B'] });
  });

  it('import rows: Delivery Charge is not a line, the return is a return, no cost is sent', () => {
    if (!statement) throw new Error('no statement');
    const previews = previewStatements([{ fileName: 'a.pdf', statement }], ctx);
    const rows = billImportRows(previews, items, new Map([[0, 'ph:01700000001']]));
    expect(rows.map((r) => r.bill_no)).toEqual(['SS0877', 'SS1013', '1105', 'R5']);
    expect(rows[3].kind).toBe('return');
    expect(rows[0]).toMatchObject({ customer_key: 'ph:01700000001', phone_key: '01700000001', items_total: 9700, bill_discount: 3601, bill_total: 6099 });
    expect(JSON.stringify(rows)).not.toContain('cost');
  });

  it('per piece / per ml: worked out from the pack size, never from a bottle price for a capsule', () => {
    if (!statement) throw new Error('no statement');
    const previews = previewStatements([{ fileName: 'a.pdf', statement }], ctx);
    const choices = [
      { ...choice('Fish Oil'), productId: 'p4', packSize: 1, stockUnit: 'pcs' },
      { ...choice('Refill'), productId: 'p5', packSize: 473, stockUnit: 'ml' },
    ];
    const needs = unitNeeds(previews.flatMap((p) => p.bills), items, choices);
    expect(needs.map((n) => [n.unit, n.suggested])).toEqual([
      ['pcs', null],
      ['ml', 6.3425],
    ]);
  });
});

describe('derived unit cost', () => {
  it('cost per pack ÷ pack size in the same unit', () => {
    expect(derivedUnitCost(4730, { stockUnit: 'ml', packSize: 473 }, 'ml', 10)).toBe(10);
    expect(derivedUnitCost(4730, { stockUnit: 'g', packSize: 473 }, 'ml', 10)).toBeNull();
    // A bottle that sells "1 PCS" at ৳2,750 with a ৳2,000 cost: fine.
    expect(derivedUnitCost(2000, { stockUnit: 'pcs', packSize: 1 }, 'pcs', 2750)).toBe(2000);
    // ৳2,400 is not the price of one capsule sold at ৳80.
    expect(derivedUnitCost(2400, { stockUnit: 'pcs', packSize: 1 }, 'pcs', 80)).toBeNull();
  });
});

/* -------------------------------------------- whole-bill discount spread */

describe('bill discount spread', () => {
  it('by line totals, in whole paisa, adding up exactly', () => {
    const parts = spreadDiscount([4000, 3000, 2700], 3601);
    expect(parts.reduce((s, v) => Math.round((s + v) * 100) / 100, 0)).toBe(3601);
    expect(parts).toEqual([1484.95, 1113.71, 1002.34]);
  });

  it('never more than the lines; nothing for no discount', () => {
    expect(spreadDiscount([100, 100], 500)).toEqual([100, 100]);
    expect(spreadDiscount([100, 100], 0)).toEqual([0, 0]);
    expect(spreadDiscount([0], 50)).toEqual([0]);
  });
});

/* ------------------------------------------- correct previous balance */

describe('correct previous balance', () => {
  it('total due becomes the new amount + site orders', () => {
    expect(correctionView(1500, '1200', 300)).toEqual({ value: 1200, error: null, totalDue: 1500, change: -300 });
    expect(correctionView(0, '2,000', 0)).toMatchObject({ value: 2000, change: 2000, totalDue: 2000 });
  });

  it('0 is allowed, negatives and the same amount are not', () => {
    expect(correctionView(800, '0', 100)).toMatchObject({ value: 0, change: -800, totalDue: 100 });
    expect(correctionView(800, '-5', 0).error).toContain('below 0');
    expect(correctionView(800, '800', 0).error).toContain('already');
    expect(correctionView(800, 'abc', 0)).toMatchObject({ value: null, totalDue: 800 });
  });
});
