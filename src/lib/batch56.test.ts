import { describe, expect, it } from 'vitest';
import type { SheetCell } from './inventory/opening';
import type { MoneyAccount, Party } from './money/types';
import { classifyExpenses, defaultProfitShareWho, expenseImportRows, readExpenses, totalsByCategory, totalsByMonth } from './kaarbar/parse';

/* Batch 56 — Naeem's Kaarbar "Expense Report" read with the site's own
   parser. Made-up rows in the exact shape of that file: Excel date numbers
   with a time, Bill No as text, notes with line breaks and Bengali, a Bill
   No used twice, rows with Payment Mode "bKash", and PROFIT SHARE rows
   naming one investor, another, or neither. */

const HEADER: SheetCell[] = ['Date', 'Bill No', 'Type', 'Category', 'Payment Mode', 'Total Amount', 'Notes/Remarks'];
const SHEET: SheetCell[][] = [
  HEADER,
  [46347.99456018519, '98', 'Expense', 'Salaries', 'Cash', 2400, 'Doctors Fee'],
  [46341.62975694444, '96', 'Expense', 'Mobile Recharge', 'Cash', 300, null],
  [46339.8750462963, '94', 'Expense', 'Materials', 'Cash', 1700, 'Power Cable, Multi Plug'],
  [46336.5, '93', 'Expense', 'Subscriptions (Ai / Services)', 'Cash', 1400, 'Test subscription'],
  [46292.4, '99', 'Expense', 'PROFIT SHARE', 'Cash', 4800, 'Someone Else'],
  [46287.4, '98', 'Expense', 'PROFIT SHARE', 'Cash', 1000, 'Another'],
  [46258.4, '64', 'Expense', 'PROFIT SHARE', 'Cash', 1870, 'KARIM'],
  [46258.2, '65', 'Expense', 'Customers Gifts / Disbursement / Offer', 'bKash', 210, null],
  [46236.4, '62', 'Expense', 'PROFIT SHARE', 'Cash', 3800, 'Lina Test \nTotal Invest Amount - ৳50,000/-'],
  [46229.4, '56', 'Expense', 'Customers Gifts / Disbursement / Offer', 'Cash', 345, 'চকলেট'],
  [45897.25555555556, '15', 'Expense', 'Shipping Cost', 'Cash', 11070, 'Travel Cost'],
];

const CASH: MoneyAccount = { id: 'acc-cash', name: 'Cash', kind: 'cash', payment_method: 'cash', sort_order: 1, archived: false };
const INVESTORS: Party[] = [
  { id: 'inv-k', name: 'KARIM', phone: null, kind: 'investor', note: null },
  { id: 'inv-l', name: 'Lina Test', phone: null, kind: 'investor', note: null },
];
const CTX = { startDate: '2026-11-13', today: '2026-11-22', lockedMonths: new Set<string>(), billNos: new Set<string>(), accounts: [CASH] };

describe('Batch 56: reading the Kaarbar Expense Report', () => {
  const read = readExpenses(SHEET);

  it('reads every row under the header, with Excel dates as days', () => {
    expect(read.error).toBeNull();
    expect(read.rows).toHaveLength(SHEET.length - 1);
    expect(read.rows.map((r) => r.date)).toEqual([
      '2026-11-21', '2026-11-15', '2026-11-13', '2026-11-10', '2026-09-27', '2026-09-22',
      '2026-08-24', '2026-08-24', '2026-08-02', '2026-07-26', '2025-08-28',
    ]);
  });

  it('keeps notes exactly as in Kaarbar (line breaks, Bengali, empty)', () => {
    expect(read.rows.find((r) => r.billNo === '62')?.note).toBe('Lina Test \nTotal Invest Amount - ৳50,000/-');
    expect(read.rows.find((r) => r.billNo === '56')?.note).toBe('চকলেট');
    expect(read.rows.find((r) => r.billNo === '96')?.note).toBe('');
  });

  it('a Bill No used twice: both rows are left out; Payment Mode bKash has no account when only Cash is used', () => {
    const rows = classifyExpenses(read.rows, CTX);
    expect(rows.filter((r) => r.billNo === '98').map((r) => r.status)).toEqual(['bad', 'bad']);
    expect(rows.find((r) => r.billNo === '65')?.status).toBe('noAccount');
  });

  it('with every row paid in Cash: before the start date is history, from the start date on is not', () => {
    const rows = classifyExpenses(read.rows.map((r) => ({ ...r, mode: 'Cash' })), CTX);
    expect(rows.find((r) => r.billNo === '65')?.status).toBe('new');
    expect(rows.find((r) => r.billNo === '94')).toMatchObject({ status: 'new', history: false });
    expect(rows.find((r) => r.billNo === '93')).toMatchObject({ status: 'new', history: true });
    expect(rows.filter((r) => r.status === 'profitShare').map((r) => r.billNo)).toEqual(['99', '64', '62']);
  });

  it('PROFIT SHARE goes to the investor the note names; a note naming neither goes nowhere', () => {
    expect(defaultProfitShareWho('KARIM', INVESTORS)).toBe('party:inv-k');
    expect(defaultProfitShareWho('Lina Test \nTotal Invest Amount - ৳50,000/-', INVESTORS)).toBe('party:inv-l');
    expect(defaultProfitShareWho('Someone Else', INVESTORS)).toBe('');
  });

  it('the rows to import: expenses + named profit share; totals by month and category', () => {
    const rows = classifyExpenses(read.rows.map((r) => ({ ...r, mode: 'Cash' })), CTX);
    const who = new Map(rows.filter((r) => r.status === 'profitShare').map((r) => [r.billNo, defaultProfitShareWho(r.note, INVESTORS)]));
    const out = expenseImportRows(rows, who);
    expect(out.filter((r) => r.kind === 'expense')).toHaveLength(6);
    expect(out.filter((r) => r.kind === 'investor_profit_share').map((r) => [r.bill_no, r.party_id, r.amount])).toEqual([
      ['64', 'inv-k', 1870],
      ['62', 'inv-l', 3800],
    ]);
    expect(out.every((r) => r.account_id === 'acc-cash')).toBe(true);
    expect(out.some((r) => r.bill_no === '99' || r.bill_no === '98')).toBe(false);
    expect(totalsByMonth(rows).find((t) => t.key === '2026-11')).toMatchObject({ amount: 3400, count: 3 });
    expect(totalsByCategory(rows)[0]).toMatchObject({ label: 'Shipping Cost', amount: 11070 });
  });
});
