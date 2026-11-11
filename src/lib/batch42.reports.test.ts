import { describe, expect, it } from 'vitest';
import {
  addDays,
  ageBucket,
  changePercent,
  changeText,
  dashboardRanges,
  lockableMonths,
  monthsOf,
  presetRange,
  weekStart,
} from './reports/periods';
import { countedUnits, countTarget, differenceText } from './reports/count';
import { cellFor, excelFileName, MONEY_FORMAT, sheetData, sheetName } from './reports/excel';
import {
  bestSellers,
  customerSheets,
  dayBookSheets,
  expensesSheets,
  expiringRows,
  lotProfit,
  lotsSheet,
  lowMargin,
  notMoving,
  pnlLines,
  pnlSheet,
  productSheets,
  salesSheets,
  slowProducts,
  stockSheets,
  sum,
} from './reports/sheets';
import type { CustomersReport, DayBookReport, LotRow, PnlParts, ProductsReport, ProfitLossReport, SalesReport, StockReport } from './reports/types';

const custom = { from: '2026-10-05', to: '2026-10-20' };

describe('Batch 42 — date presets', () => {
  it('Today / Yesterday / This week (from Saturday) / This month / Last month / This year / All time / Custom', () => {
    const today = '2026-11-10'; // a Tuesday
    expect(presetRange('today', today, custom)).toEqual({ from: today, to: today });
    expect(presetRange('yesterday', today, custom)).toEqual({ from: '2026-11-09', to: '2026-11-09' });
    expect(presetRange('week', today, custom)).toEqual({ from: '2026-11-07', to: today });
    expect(presetRange('month', today, custom)).toEqual({ from: '2026-11-01', to: today });
    expect(presetRange('last_month', today, custom)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('year', today, custom)).toEqual({ from: '2026-01-01', to: today });
    expect(presetRange('all', today, custom).to).toBe(today);
    expect(presetRange('custom', today, custom)).toEqual(custom);
  });

  it('Last month in January is December of last year; February has 28 or 29 days', () => {
    expect(presetRange('last_month', '2027-01-15', custom)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(presetRange('last_month', '2028-03-02', custom)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('the week starts on Saturday', () => {
    expect(weekStart('2026-11-07')).toBe('2026-11-07'); // Saturday
    expect(weekStart('2026-11-13')).toBe('2026-11-07'); // Friday
    expect(weekStart('2026-11-08')).toBe('2026-11-07'); // Sunday
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('the Dashboard compares with the same length before: yesterday, the same days of last month / last year', () => {
    expect(dashboardRanges('today', '2026-11-10')).toEqual({
      current: { from: '2026-11-10', to: '2026-11-10' },
      previous: { from: '2026-11-09', to: '2026-11-09' },
    });
    expect(dashboardRanges('month', '2026-03-31').previous).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(dashboardRanges('month', '2026-01-10').previous).toEqual({ from: '2025-12-01', to: '2025-12-10' });
    expect(dashboardRanges('year', '2026-11-10').previous).toEqual({ from: '2025-01-01', to: '2025-11-10' });
  });

  it('▲ / ▼ % change; nothing to compare with → —', () => {
    expect(changePercent(1200, 1000)).toBe(20);
    expect(changePercent(800, 1000)).toBe(-20);
    expect(changePercent(500, -1000)).toBe(150);
    expect(changePercent(500, 0)).toBeNull();
    expect(changePercent(500, null)).toBeNull();
    expect(changeText(20)).toBe('▲ 20%');
    expect(changeText(-12.5)).toBe('▼ 12.5%');
    expect(changeText(null)).toBe('—');
  });

  it('months of a range; lockable months are the ones that are over', () => {
    expect(monthsOf({ from: '2026-11-15', to: '2027-02-01' })).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(lockableMonths('2026-11-10', 3)).toEqual(['2026-10-01', '2026-09-01', '2026-08-01']);
    expect(lockableMonths('2026-01-05', 2)).toEqual(['2025-12-01', '2025-11-01']);
  });

  it('due age buckets: 0–30, 31–60, over 60 days', () => {
    expect(ageBucket(0)).toBe('0-30');
    expect(ageBucket(30)).toBe('0-30');
    expect(ageBucket(31)).toBe('31-60');
    expect(ageBucket(60)).toBe('31-60');
    expect(ageBucket(61)).toBe('60+');
  });
});

describe('Batch 42 — stock count', () => {
  it('reads packs + loose units (Bangla digits too); empty or not a whole number → nothing', () => {
    expect(countedUnits('7', '', 1)).toBe(7);
    expect(countedUnits('3', '150', 400)).toBe(1350);
    expect(countedUnits('০', '৫', 1)).toBe(5);
    expect(countedUnits('', '', 1)).toBeNull();
    expect(countedUnits('2.5', '', 1)).toBeNull();
    expect(countedUnits('-1', '', 1)).toBeNull();
    expect(countedUnits('0', '', 1)).toBe(0);
  });

  it('the difference in plain words', () => {
    expect(differenceText(0, 'pcs')).toBe('the same as the system');
    expect(differenceText(-2, 'pcs')).toBe('2 pcs fewer → written off (Count difference)');
    expect(differenceText(3, 'ml')).toBe('3 ml more → added back to the newest lot');
  });

  it('15–20 a month so every product is counted in about 6 months', () => {
    expect(countTarget(150)).toEqual({ target: 20, rotation: 20 });
    expect(countTarget(113)).toEqual({ target: 19, rotation: 19 });
    expect(countTarget(60)).toEqual({ target: 15, rotation: 10 });
    expect(countTarget(4)).toEqual({ target: 4, rotation: 1 });
    expect(countTarget(0)).toEqual({ target: 0, rotation: 0 });
  });
});

describe('Batch 42 — Excel', () => {
  it('money is a real number with a ৳ format, never text; dates are real dates', () => {
    expect(cellFor('money', 1234.567)).toEqual({ value: 1234.57, type: Number, format: MONEY_FORMAT });
    expect(cellFor('number', 3)).toMatchObject({ value: 3, type: Number });
    expect(cellFor('date', '2026-10-11')).toMatchObject({ type: Date, value: new Date(Date.UTC(2026, 9, 11)) });
    expect(cellFor('text', 'Ads')).toEqual({ value: 'Ads', type: String });
    expect(cellFor('money', null)).toBeNull();
  });

  it("sheet names follow Excel's rules and never repeat", () => {
    expect(sheetName('Profit & loss')).toBe('Profit & loss');
    expect(sheetName('a/b:c*?[d]')).toBe('a b c d');
    expect(sheetName('x'.repeat(40))).toHaveLength(31);
    expect(sheetName('Cash', ['Cash'])).toBe('Cash (2)');
    expect(excelFileName('Profit & loss', '2026-10-01', '2026-10-31')).toBe('naeem-profit-loss-2026-10-01-to-2026-10-31.xlsx');
  });

  it('the grid has the header, every row and the bold total row', () => {
    const grid = sheetData({ name: 'T', columns: [{ header: 'A', kind: 'text' }, { header: 'B', kind: 'money' }], rows: [['x', 1], ['y', 2]], total: ['Total', 3] });
    expect(grid).toHaveLength(4);
    expect(grid[3][1]).toMatchObject({ value: 3, fontWeight: 'bold', format: MONEY_FORMAT });
  });
});

const parts = (over: Partial<PnlParts> = {}): PnlParts => ({
  from: '2026-10-01', to: '2026-10-31', orders: 3, uncosted_orders: 0,
  sales: 10000, cost: 6000, provisional: 0, delivery: 400, courier: 300, cost_adjustments: 50,
  expenses: 900, write_offs: 150, net_profit: 3000, profit_share: 500, your_profit: 2500,
  withdrawals: 1000, left_in_business: 1500, owner_money_in: 0, not_shop_money: 0, count_differences: 0,
  gross_profit: 4000, ...over,
});

describe('Batch 42 — the report tables (the screen and the Excel file are the same rows)', () => {
  const pnl: ProfitLossReport = {
    from: '2026-09-01', to: '2026-10-31',
    parts: parts(),
    expenses_by_category: [{ category_id: 'a', name: 'Ads', amount: 600 }, { category_id: 'f', name: 'Food', amount: 300 }],
    months: [
      { ...parts({ sales: 4000, cost: 2500, gross_profit: 1500, expenses: 400, net_profit: 1000 }), month: '2026-09-01', locked: true,
        expenses_by_category: [{ category_id: 'a', name: 'Ads', amount: 400 }] },
      { ...parts({ sales: 6000, cost: 3500, gross_profit: 2500, expenses: 500, net_profit: 2000 }), month: '2026-10-01', locked: false,
        expenses_by_category: [{ category_id: 'a', name: 'Ads', amount: 200 }, { category_id: 'f', name: 'Food', amount: 300 }] },
    ],
    locked_months: ['2026-09-01'], start_date: '2026-09-01',
  };

  it('P&L: every step in order, categories under Expenses, signed so the plain lines add up to Net profit', () => {
    const lines = pnlLines(pnl).map((l) => l.label.trim());
    expect(lines).toEqual([
      'Sales (after discounts)', 'Cost of goods', 'Gross profit', 'Delivery collected', 'Courier & COD fee', 'Expenses', 'Ads', 'Food',
      'Stock removed (write-offs)', 'Cost adjustments', 'Net profit', 'Investor profit share', 'Your profit', 'Your withdrawals', 'Left in the business',
    ]);
    const sheet = pnlSheet(pnl);
    expect(sheet.columns.map((c) => c.header)).toEqual(['', 'Sep 2026 (locked)', 'Oct 2026', 'Total']);
    const total = (label: string) => sheet.rows.find((r) => String(r[0]).trim() === label)?.[3];
    expect(total('Cost of goods')).toBe(-6000);
    expect(total('Ads')).toBe(-600);
    expect(total('Net profit')).toBe(3000);
    // Sales − cost + delivery − courier − expenses − write-offs − adjustments = net profit.
    const plain = ['Sales (after discounts)', 'Cost of goods', 'Delivery collected', 'Courier & COD fee', 'Expenses', 'Stock removed (write-offs)', 'Cost adjustments'];
    expect(sum(plain.map((l) => Number(total(l))))).toBe(3000);
  });

  it('Expenses: share % adds to 100; the months row adds to the total', () => {
    const [cats, months] = expensesSheets(pnl);
    expect(cats.rows.map((r) => r[2])).toEqual([67, 33]);
    expect(cats.total).toEqual(['Total', 900, 100]);
    expect(months.total).toEqual(['Total', 400, 500, 900]);
  });

  it('Sales: totals of the orders sheet equal the summary', () => {
    const sales: SalesReport = {
      from: '2026-10-01', to: '2026-10-31',
      totals: { entries: 2, returned: 0, total: 1500, received: 1000, unpaid: 500 },
      by_source: [{ source: 'web', entries: 1, total: 1000 }, { source: 'facebook', entries: 1, total: 500 }],
      by_day: [],
      orders: [
        { order_id: '1', order_number: 'NM-1', day: '2026-10-02', status: 'delivered', source: 'web', customer_name: 'A', total: 1000, paid: 1000, due: 0 },
        { order_id: '2', order_number: 'NM-2', day: '2026-10-03', status: 'shipped', source: 'facebook', customer_name: 'B', total: 500, paid: 0, due: 500 },
      ],
      locked_months: [],
    };
    const [summary, sources, orders] = salesSheets(sales);
    expect(summary.rows[0]).toEqual([2, 1500, 1000, 500, 0]);
    expect(sources.rows.map((r) => r[0])).toEqual(['Website', 'Manual — Facebook']);
    expect(orders.total?.slice(5)).toEqual([1500, 1000, 500]);
  });

  it('Products: best sellers, low margin under 15%, slow (no sale in 60 days), not moving with stock left', () => {
    const report: ProductsReport = {
      from: '2026-10-01', to: '2026-10-31',
      totals: { sales: 0, cost: 0, profit: 0, orders: 0, uncosted_orders: 0 },
      sold: [
        { product_id: 'a', variant_id: null, label: 'A', units: 2, stock_unit: 'pcs', pack_size: 1, sales: 1000, cost: 900, profit: 100, margin: 10 },
        { product_id: 'b', variant_id: null, label: 'B', units: 5, stock_unit: 'pcs', pack_size: 1, sales: 2000, cost: 1000, profit: 1000, margin: 50 },
      ],
      units: [
        { product_id: 'a', variant_id: null, label: 'A', is_active: true, stock_unit: 'pcs', pack_size: 1, units_left: 3, stock_value: 300, sold_60: 2, last_sold: '2026-10-20', has_cost: true },
        { product_id: 'c', variant_id: null, label: 'C', is_active: true, stock_unit: 'pcs', pack_size: 1, units_left: 4, stock_value: 800, sold_60: 0, last_sold: '2026-07-01', has_cost: true },
        { product_id: 'd', variant_id: null, label: 'D', is_active: false, stock_unit: 'pcs', pack_size: 1, units_left: 0, stock_value: 0, sold_60: 0, last_sold: null, has_cost: false },
      ],
      locked_months: [],
    };
    expect(bestSellers(report).map((p) => p.label)).toEqual(['B', 'A']);
    expect(lowMargin(report).map((p) => p.label)).toEqual(['A']);
    expect(slowProducts(report).map((p) => p.label)).toEqual(['C']);
    expect(notMoving(report).map((p) => p.label)).toEqual(['C']);
    const sheets = productSheets(report);
    expect(sheets.best.total?.[3]).toBe(3000);
    expect(sheets.best.total?.[6]).toBe(36.7);
  });

  it('Lots: profit so far = sales − cost of sold units; totals add up', () => {
    const lot = (code: string, sales: number, cost: number): LotRow => ({
      lot_id: code, code, kind: 'purchase', lot_date: '2026-10-01', supplier: '', costs_pending: false, rows: 1,
      units_bought: 10, units_sold: 4, units_on_orders: 1, units_removed: 1, units_found: 0, units_left: 4,
      buy_value: 1000, trip_weight: 100, trip_other: 50, landed_total: 1150, left_value: 460, sales, cost_sold: cost, locked: false,
    });
    const rows = [lot('L-001', 2000, 460), lot('L-002', 1000.1, 700.05)];
    expect(lotProfit(rows[1])).toBe(300.05);
    const sheet = lotsSheet(rows);
    expect(sheet.total?.[14]).toBe(1840.05);
    expect(sheet.total?.[3]).toBe(20);
  });

  it('Stock: the expiring tab is the next 90 days, soonest first; the value adds up', () => {
    const row = (id: string, expiry: string | null, value: number) => ({
      lot_item_id: id, product_id: id, variant_id: null, label: id, stock_unit: 'pcs', pack_size: 1, lot_code: 'L-001', lot_date: '2026-01-01',
      expiry_date: expiry, units: 1, unit_cost: value, value, per_month: 1, units_before: 0, sells_in_time: expiry ? false : null,
    });
    const report: StockReport = { today: '2026-11-10', total_value: 600, rows: [row('a', '2027-03-01', 100), row('b', '2026-12-01', 200), row('c', '2027-06-01', 300)] };
    expect(expiringRows(report).map((r) => r.label)).toEqual(['b']);
    expect(stockSheets(report).all.total?.[6]).toBe(600);
  });

  it('Customers: the age columns add up to the total', () => {
    const report: CustomersReport = {
      from: '2026-01-01', to: '2026-11-10', today: '2026-11-10',
      dues: [
        { customer_key: 'a', name: 'A', phone: '1', order_due: 500, previous_left: 0, total: 500, d0: 200, d31: 300, d61: 0, oldest_days: 40 },
        { customer_key: 'b', name: 'B', phone: '2', order_due: 0, previous_left: 700, total: 700, d0: 0, d31: 0, d61: 700, oldest_days: 90 },
      ],
      top: [{ customer_key: 'a', name: 'A', phone: '1', bought: 5000, profit: 900, orders: 3 }],
    };
    const [dues] = customerSheets(report);
    expect(dues.total).toEqual(['Total', null, 200, 300, 700, 1200, null]);
  });

  it('Day book: one sheet per account, the balance before, every line, the closing balance', () => {
    const report: DayBookReport = {
      from: '2026-11-10', to: '2026-11-10', locked_months: [],
      accounts: [{ account_id: 'c', name: 'Cash', kind: 'cash', opening: 1000, money_in: 500, money_out: 200, closing: 1300, lines: [
        { date: '2026-11-10', type: 'customer_payment', amount: 500, balance: 1500, note: null, reference: 'NM-1', category: null, by: 'naeem', source: 'payment', source_id: '1' },
        { date: '2026-11-10', type: 'expense', amount: -200, balance: 1300, note: 'tea', reference: null, category: 'Food', by: 'naeem', source: 'movement', source_id: '2' },
      ] }],
    };
    const [cash] = dayBookSheets(report);
    expect(cash.name).toBe('Cash');
    expect(cash.rows[0]).toEqual(['2026-11-10', 'Balance before', null, null, null, 1000]);
    expect(cash.rows[2]).toEqual(['2026-11-10', 'Expense — Food', 'tea', null, 200, 1300]);
    expect(cash.total).toEqual(['Total', null, null, 500, 200, 1300]);
  });
});
