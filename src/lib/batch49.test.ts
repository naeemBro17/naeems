import { describe, expect, it } from 'vitest';
import type { SheetCell } from './inventory/opening';
import type { MoneyAccount, Party } from './money/types';
import {
  accountDecreases,
  classifyExpenses,
  classifyParties,
  cleanPhone,
  customerImportRows,
  defaultProfitShareWho,
  dueDifferences,
  expenseImportRows,
  findHeader,
  isCashName,
  isProfitShare,
  matchAccount,
  newestFirst,
  parseAmountCell,
  parseDateCell,
  readExpenses,
  readParties,
  toggleTick,
  totalsByCategory,
  totalsByMonth,
  type SiteMatch,
} from './kaarbar/parse';

/* Batch 49 — Kaarbar import. Made-up data only, shaped like Kaarbar's
   "All Party Report" and "Expense Report". */

const PARTY_SHEET: SheetCell[][] = [
  [null, null, null, null],
  ['', '', '', ''],
  ['Party Name', 'Contact', 'Receivable', 'Payable'],
  ['Test Rahim', '01711-000001', 1500, 0],
  ['Test Karim', '+880 1711 000002', 0, 0],
  ['Test Karim Two', '8801711000002', 200, 0],
  ['Test No Phone', null, 0, 0],
  ['Test Supplier Co', '01811000003', 0, 52000],
  ['Cash', '', 0, 0],
  ['Walk-in', '', 0, 0],
  ['Test Old Customer', '01911000004', '1,250', 0],
  [null, null, null, null],
  ['Total', '', 2950, 52000],
];

const DHAKA_DAY = (y: number, m: number, d: number, h = 10) => new Date(Date.UTC(y, m - 1, d, h, 30));

const EXPENSE_SHEET: SheetCell[][] = [
  [],
  ['Date', 'Bill No', 'Type', 'Category', 'Payment Mode', 'Total Amount', 'Notes/Remarks'],
  [DHAKA_DAY(2026, 11, 15), '97', 'Expense', 'Mobile Recharge', 'bKash', 300, 'রিচার্জ\nsecond line'],
  [DHAKA_DAY(2026, 10, 2), '12', 'Expense', 'Shipping Cost', 'Cash', 1200, ''],
  [DHAKA_DAY(2026, 9, 20), 5, 'Expense', ' subscriptions ', 'Cash', 2000, null],
  [DHAKA_DAY(2026, 11, 14), '101', 'Expense', 'PROFIT SHARE', 'Cash', 10000, 'Test Investor share'],
  [DHAKA_DAY(2026, 11, 16), '102', 'Payment In', 'Food', 'Cash', 500, ''],
  [DHAKA_DAY(2026, 11, 13), '103', 'Expense', 'Food', 'Card', 400, ''],
  [DHAKA_DAY(2026, 8, 5), '104', 'Expense', 'Gifts', 'Cash', 700, ''],
  [DHAKA_DAY(2026, 11, 17), '105', 'Expense', 'Utilities', 'Cash', 800, ''],
  [null, null, null, null, null, 17900, null],
];

const ACCOUNTS: MoneyAccount[] = [
  { id: 'acc-cash', name: 'Cash', kind: 'cash', payment_method: 'cash', sort_order: 1, archived: false },
  { id: 'acc-bkash', name: 'bKash', kind: 'bkash', payment_method: 'bkash', sort_order: 2, archived: false },
  { id: 'acc-sf', name: 'With Steadfast', kind: 'steadfast', payment_method: 'cod_steadfast', sort_order: 9, archived: false },
];

describe('Batch 49: reading the files', () => {
  it('finds the header by name under empty rows; skips empty and Total rows', () => {
    const { rows, error } = readParties(PARTY_SHEET);
    expect(error).toBeNull();
    expect(rows.map((r) => r.name)).toEqual([
      'Test Rahim', 'Test Karim', 'Test Karim Two', 'Test No Phone', 'Test Supplier Co', 'Cash', 'Walk-in', 'Test Old Customer',
    ]);
    expect(rows[0].n).toBe(4);
    expect(rows[7].receivable).toBe(1250);
  });

  it('finds columns in any order and passes over a title row', () => {
    const cells: SheetCell[][] = [['My Shop — All Party Report'], ['Payable', 'Receivable', 'Contact', 'Party Name'], [0, 10, '01711000009', 'Test X']];
    const { rows } = readParties(cells);
    expect(rows).toEqual([{ n: 3, name: 'Test X', contact: '01711000009', phoneKey: '01711000009', receivable: 10, payable: 0 }]);
  });

  it('names the missing columns when it is the wrong report', () => {
    const { header, error } = findHeader([['Date', 'Amount']], [{ key: 'name', label: 'Party Name', names: ['partyname'], required: true }], 'All Party Report');
    expect(header).toBeNull();
    expect(error).toContain('"Party Name"');
    expect(readParties([]).error).toBe('The file is empty.');
  });

  it('cleans phones: +880 / 880 / spaces / dashes all become 01XXXXXXXXX', () => {
    expect(cleanPhone('+880 1711-000001')).toBe('01711000001');
    expect(cleanPhone('8801711000001')).toBe('01711000001');
    expect(cleanPhone('01711 000 001')).toBe('01711000001');
    expect(cleanPhone('017-1100-0001')).toBe('01711000001');
    expect(cleanPhone('1711000001')).toBe('01711000001');
    expect(cleanPhone('')).toBeNull();
    expect(cleanPhone('029000000')).toBeNull();
  });

  it('reads amounts and dates in the shapes Kaarbar may give', () => {
    expect(parseAmountCell('৳1,250.50')).toBe(1250.5);
    expect(parseAmountCell('')).toBeNull();
    expect(parseAmountCell('(300)')).toBe(-300);
    expect(parseDateCell(DHAKA_DAY(2026, 11, 15, 23))).toBe('2026-11-15');
    expect(parseDateCell('15/11/2026 10:30 AM')).toBe('2026-11-15');
    expect(parseDateCell('2026-11-15 22:10')).toBe('2026-11-15');
    expect(parseDateCell('15 Nov 2026')).toBe('2026-11-15');
    expect(parseDateCell('Nov 15, 2026')).toBe('2026-11-15');
    expect(parseDateCell(46341)).toBe('2026-11-15');
    expect(parseDateCell('soon')).toBeNull();
  });

  it('reads expenses: Bill No as text, notes kept exactly (Bengali, line breaks)', () => {
    const { rows, error } = readExpenses(EXPENSE_SHEET);
    expect(error).toBeNull();
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ date: '2026-11-15', billNo: '97', category: 'Mobile Recharge', mode: 'bKash', amount: 300, note: 'রিচার্জ\nsecond line' });
    expect(rows[2].billNo).toBe('5');
    expect(rows[2].category).toBe('subscriptions');
  });
});

describe('Batch 49: customers preview', () => {
  const parties = readParties(PARTY_SHEET).rows;
  const matches = new Map<number, SiteMatch>([[parties[7].n, { siteKey: 'p:abc', siteName: 'Old Customer On Site', siteDue: 1000 }]]);
  const rows = classifyParties(parties, matches);
  const group = (name: string) => rows.find((r) => r.name === name)?.group;

  it('sorts every party into its group', () => {
    expect(group('Test Rahim')).toBe('new');
    expect(group('Test Karim')).toBe('samePhone');
    expect(group('Test Karim Two')).toBe('samePhone');
    expect(group('Test No Phone')).toBe('noPhone');
    expect(group('Test Supplier Co')).toBe('supplier');
    expect(group('Cash')).toBe('cashName');
    expect(group('Walk-in')).toBe('cashName');
    expect(group('Test Old Customer')).toBe('existing');
  });

  it('ticks New and No phone; leaves pairs, suppliers and cash names unticked; existing cannot be ticked', () => {
    const ticked = rows.filter((r) => r.tickedByDefault).map((r) => r.name);
    expect(ticked).toEqual(['Test Rahim', 'Test No Phone']);
    expect(rows.find((r) => r.group === 'existing')?.tickable).toBe(false);
    expect(isCashName('Cash Sale')).toBe(true);
    expect(isCashName('Walk in customer')).toBe(true);
    expect(isCashName('Cashew Shop')).toBe(false);
  });

  it('a same-phone pair: ticking one unticks the other (one customer per phone)', () => {
    const [a, b] = rows.filter((r) => r.group === 'samePhone');
    let ticked = toggleTick(rows, new Set(), a.n);
    expect(ticked.has(a.n)).toBe(true);
    ticked = toggleTick(rows, ticked, b.n);
    expect(ticked.has(a.n)).toBe(false);
    expect(ticked.has(b.n)).toBe(true);
    // An existing customer can't be ticked at all.
    expect(toggleTick(rows, ticked, parties[7].n).has(parties[7].n)).toBe(false);
  });

  it('import rows: only ticked, never an existing customer, no phone sends no phone key', () => {
    const all = new Set(rows.map((r) => r.n));
    const out = customerImportRows(rows, all);
    expect(out.map((r) => r.name)).not.toContain('Test Old Customer');
    expect(out.filter((r) => r.phone_key === '01711000002')).toHaveLength(1);
    expect(out.find((r) => r.name === 'Test No Phone')).toEqual({ name: 'Test No Phone', phone_key: null, contact: null });
  });

  it('dues are only listed (Kaarbar vs site), never changed', () => {
    const diffs = dueDifferences(rows);
    expect(diffs.find((d) => d.name === 'Test Old Customer')).toMatchObject({ kaarbar: 1250, site: 1000 });
    expect(diffs.find((d) => d.name === 'Test Rahim')).toMatchObject({ kaarbar: 1500, site: 0 });
    expect(diffs.find((d) => d.name === 'Test Karim')).toBeUndefined();
    // Import rows carry no due at all.
    expect(Object.keys(customerImportRows(rows, new Set(rows.map((r) => r.n)))[0])).toEqual(['name', 'phone_key', 'contact']);
  });
});

describe('Batch 49: expenses preview', () => {
  const read = readExpenses(EXPENSE_SHEET).rows;
  const ctx = {
    startDate: '2026-11-13',
    today: '2026-11-18',
    lockedMonths: new Set(['2026-08']),
    billNos: new Set(['105']),
    accounts: ACCOUNTS,
  };
  const rows = classifyExpenses(read, ctx);
  const st = (bill: string) => rows.find((r) => r.billNo === bill);

  it('sorts every row', () => {
    expect(st('97')?.status).toBe('new');
    expect(st('97')?.history).toBe(false);
    expect(st('12')).toMatchObject({ status: 'new', history: true });
    expect(st('101')?.status).toBe('profitShare');
    expect(st('102')?.status).toBe('notExpense');
    expect(st('103')?.status).toBe('noAccount');
    expect(st('104')).toMatchObject({ status: 'locked', reason: 'month is locked' });
    expect(st('105')?.status).toBe('already');
  });

  it('Bill No twice in one file, a future date and no amount are refused', () => {
    const extra = classifyExpenses(
      [
        { ...read[0], billNo: '200' },
        { ...read[0], billNo: '200' },
        { ...read[0], billNo: '201', date: '2026-12-01' },
        { ...read[0], billNo: '202', amount: null },
      ],
      ctx
    );
    expect(extra.map((r) => r.status)).toEqual(['bad', 'bad', 'bad', 'bad']);
  });

  it('PROFIT SHARE is never an expense', () => {
    expect(isProfitShare('PROFIT  SHARE')).toBe(true);
    expect(isProfitShare('Profit share')).toBe(true);
    const out = expenseImportRows(rows, new Map());
    expect(out.find((r) => r.bill_no === '101')).toBeUndefined();
    const withInvestor = expenseImportRows(rows, new Map([['101', 'party:inv-1']]));
    expect(withInvestor.find((r) => r.bill_no === '101')).toMatchObject({ kind: 'investor_profit_share', party_id: 'inv-1', category: null });
    const asOwner = expenseImportRows(rows, new Map([['101', 'owner']]));
    expect(asOwner.find((r) => r.bill_no === '101')).toMatchObject({ kind: 'owner_withdrawal', party_id: null });
    expect(totalsByCategory(rows).map((t) => t.label)).not.toContain('PROFIT SHARE');
  });

  it('guesses the investor from the note, or the only investor', () => {
    const investors: Party[] = [
      { id: 'inv-1', name: 'Test Investor', phone: null, kind: 'investor', note: null },
      { id: 'inv-2', name: 'Other Person', phone: null, kind: 'investor', note: null },
    ];
    expect(defaultProfitShareWho('Test Investor share', investors)).toBe('party:inv-1');
    expect(defaultProfitShareWho('share', investors)).toBe('');
    expect(defaultProfitShareWho('share', [investors[1]])).toBe('party:inv-2');
  });

  it('second upload: a Bill No already on the site is skipped', () => {
    const imported = new Set(expenseImportRows(rows, new Map()).map((r) => r.bill_no));
    const again = classifyExpenses(read, { ...ctx, billNos: new Set([...ctx.billNos, ...imported]) });
    expect(expenseImportRows(again, new Map())).toEqual([]);
    expect(again.filter((r) => r.status === 'already').map((r) => r.billNo).sort()).toEqual(['105', '12', '5', '97']);
  });

  it('money rule: only rows on or after the start date take money out of an account', () => {
    const out = expenseImportRows(rows, new Map([['101', 'party:inv-1']]));
    const down = accountDecreases(out, ctx.startDate, ACCOUNTS);
    expect(down).toEqual([
      { key: 'acc-cash', label: 'Cash', amount: 10000, count: 1 },
      { key: 'acc-bkash', label: 'bKash', amount: 300, count: 1 },
    ]);
  });

  it('locked month rows are left out of the import', () => {
    expect(expenseImportRows(rows, new Map()).map((r) => r.bill_no)).not.toContain('104');
  });

  it('payment modes match accounts by name, never With Steadfast', () => {
    expect(matchAccount('Cash', ACCOUNTS)?.id).toBe('acc-cash');
    expect(matchAccount('BKASH', ACCOUNTS)?.id).toBe('acc-bkash');
    expect(matchAccount('Card', ACCOUNTS)).toBeNull();
    expect(matchAccount('With Steadfast', ACCOUNTS)).toBeNull();
  });

  it('totals by month and category, list newest first', () => {
    expect(totalsByMonth(rows).map((t) => [t.key, t.amount])).toEqual([
      ['2026-11', 300],
      ['2026-10', 1200],
      ['2026-09', 2000],
    ]);
    expect(totalsByCategory(rows)[0]).toMatchObject({ label: 'subscriptions', amount: 2000 });
    expect(newestFirst(rows).map((r) => r.billNo).slice(0, 3)).toEqual(['105', '102', '97']);
  });
});
