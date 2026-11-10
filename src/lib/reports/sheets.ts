import { categoryShares, dayText, typeLabel } from '../money/format';
import type { LedgerType } from '../money/types';
import type { ReportColumn, ReportSheet, ReportValue } from './excel';
import { shortMonth } from './periods';
import type {
  ChartsReport,
  CustomersReport,
  DayBookReport,
  InvestorRow,
  LotRow,
  PnlParts,
  ProductUnit,
  ProductsReport,
  ProfitLossReport,
  SalesReport,
  SoldProduct,
  StockReport,
  StockRow,
} from './types';

/* Batch 42: every report table is built here ONCE; the screen shows these
   rows and the Excel file is made from the very same rows, so the file's
   totals always equal the screen. */

const money = (header: string, width?: number): ReportColumn => ({ header, kind: 'money', width });
const text = (header: string, width?: number): ReportColumn => ({ header, kind: 'text', width });
const num = (header: string, width?: number): ReportColumn => ({ header, kind: 'number', width });
const pct = (header: string): ReportColumn => ({ header, kind: 'percent', width: 10 });
const date = (header: string): ReportColumn => ({ header, kind: 'date', width: 13 });

function paisa(n: number): number {
  return Math.round(n * 100);
}

/** Sum in whole paisa (no floating-point dust). */
export function sum(values: readonly number[]): number {
  return values.reduce((s, v) => s + paisa(v), 0) / 100;
}

export function margin(profit: number, sales: number): number | null {
  return paisa(sales) > 0 ? Math.round((profit / sales) * 1000) / 10 : null;
}

function rangeTitle(name: string, from: string, to: string): string[] {
  return [`Naeem's Price Hub — ${name}`, from === to ? dayText(from) : `${dayText(from)} – ${dayText(to)}`];
}

/* ------------------------------------------------------ Profit & loss */

export interface PnlLine {
  key: string;
  label: string;
  /** Signed: costs are below 0, so the plain lines add up to Net profit. */
  value: (p: PnlParts, cats: Map<string, number>) => number;
  kind?: 'total' | 'sub';
}

/** The steps, in the order of the brief. Expense categories are added
 *  under "Expenses" by pnlLines(). */
const PNL_HEAD: readonly PnlLine[] = [
  { key: 'sales', label: 'Sales (after discounts)', value: (p) => p.sales },
  { key: 'cost', label: 'Cost of goods', value: (p) => -p.cost },
  { key: 'gross', label: 'Gross profit', value: (p) => p.gross_profit, kind: 'total' },
  { key: 'delivery', label: 'Delivery collected', value: (p) => p.delivery },
  { key: 'courier', label: 'Courier & COD fee', value: (p) => -p.courier },
];

const PNL_TAIL: readonly PnlLine[] = [
  { key: 'write_offs', label: 'Stock removed (write-offs)', value: (p) => -p.write_offs },
  { key: 'cost_adjustments', label: 'Cost adjustments', value: (p) => -p.cost_adjustments },
  { key: 'net', label: 'Net profit', value: (p) => p.net_profit, kind: 'total' },
  { key: 'share', label: 'Investor profit share', value: (p) => -p.profit_share },
  { key: 'your', label: 'Your profit', value: (p) => p.your_profit, kind: 'total' },
  { key: 'withdrawals', label: 'Your withdrawals', value: (p) => -p.withdrawals },
  { key: 'left', label: 'Left in the business', value: (p) => p.left_in_business, kind: 'total' },
];

export function pnlLines(report: ProfitLossReport): PnlLine[] {
  const names = new Map<string, string>();
  for (const c of report.expenses_by_category) names.set(c.category_id, c.name);
  for (const m of report.months) for (const c of m.expenses_by_category) names.set(c.category_id, c.name);
  const cats: PnlLine[] = [...names.entries()].map(([id, name]) => ({
    key: `cat:${id}`,
    label: `  ${name}`,
    value: (_p, map) => -(map.get(id) ?? 0),
    kind: 'sub',
  }));
  return [
    ...PNL_HEAD,
    { key: 'expenses', label: 'Expenses', value: (p) => -p.expenses },
    ...cats,
    ...PNL_TAIL,
  ];
}

function catMap(rows: readonly { category_id: string; amount: number }[]): Map<string, number> {
  return new Map(rows.map((c) => [c.category_id, c.amount]));
}

export function pnlSheet(report: ProfitLossReport): ReportSheet {
  const lines = pnlLines(report);
  const whole = catMap(report.expenses_by_category);
  const months = report.months;
  const columns: ReportColumn[] = [
    text('', 30),
    ...months.map((m) => money(`${shortMonth(m.month)}${m.locked ? ' (locked)' : ''}`, 13)),
    money(months.length > 0 ? 'Total' : 'Amount', 15),
  ];
  const rows = lines.map((line) => [
    line.label,
    ...months.map((m) => line.value(m, catMap(m.expenses_by_category))),
    line.value(report.parts, whole),
  ]);
  return { name: 'Profit & loss', title: rangeTitle('Profit & loss', report.from, report.to), columns, rows };
}

/* -------------------------------------------------------------- Sales */

const SOURCE_LABELS: Record<string, string> = {
  web: 'Website',
  facebook: 'Manual — Facebook',
  whatsapp: 'Manual — WhatsApp',
  phone: 'Manual — Phone',
  shop: 'Manual — Shop',
  family: 'Manual — Family',
  other: 'Manual — Other',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'To confirm',
  confirmed: 'Confirmed',
  shipped: 'In transit',
  delivered: 'Delivered',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function salesSheets(report: SalesReport): ReportSheet[] {
  const t = report.totals;
  return [
    {
      name: 'Summary',
      title: rangeTitle('Sales (orders placed)', report.from, report.to),
      columns: [num('Entries (orders)', 16), money('Total', 16), money('Received', 16), money('Unpaid', 16), num('Returned', 10)],
      rows: [[t.entries, t.total, t.received, t.unpaid, t.returned]],
    },
    {
      name: 'By source',
      columns: [text('Source', 26), num('Entries', 10), money('Total', 16)],
      rows: report.by_source.map((s) => [sourceLabel(s.source), s.entries, s.total]),
      total: ['Total', sum(report.by_source.map((s) => s.entries)), sum(report.by_source.map((s) => s.total))],
    },
    {
      name: 'Orders',
      columns: [text('Order', 12), date('Date'), text('Customer', 24), text('Status', 12), text('Source', 20), money('Total'), money('Received'), money('Unpaid')],
      rows: report.orders.map((o) => [o.order_number, o.day, o.customer_name, statusLabel(o.status), sourceLabel(o.source), o.total, o.paid, o.due]),
      total: ['Total', null, null, null, null, sum(report.orders.map((o) => o.total)), sum(report.orders.map((o) => o.paid)), sum(report.orders.map((o) => o.due))],
    },
  ];
}

/* ----------------------------------------------------------- Products */

export type ProductsTab = 'best' | 'slow' | 'low_margin' | 'not_moving';

export const PRODUCT_TABS: readonly { id: ProductsTab; label: string }[] = [
  { id: 'best', label: 'Best sellers' },
  { id: 'slow', label: 'Slow (no sale in 60 days)' },
  { id: 'low_margin', label: 'Low margin (under 15%)' },
  { id: 'not_moving', label: 'Not moving, stock left' },
];

export const LOW_MARGIN = 15;
export const SLOW_DAYS = 60;

const unitKey = (p: { product_id: string; variant_id: string | null }) => `${p.product_id}:${p.variant_id ?? ''}`;

export function bestSellers(report: ProductsReport): SoldProduct[] {
  return [...report.sold].sort((a, b) => b.units - a.units || b.sales - a.sales || a.label.localeCompare(b.label));
}

export function lowMargin(report: ProductsReport): SoldProduct[] {
  return report.sold.filter((p) => p.margin !== null && p.margin < LOW_MARGIN).sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0));
}

/** No sale in the last 60 days, and either still in the shop or with stock. */
export function slowProducts(report: ProductsReport): ProductUnit[] {
  return report.units
    .filter((u) => u.sold_60 === 0 && (u.units_left > 0 || u.is_active))
    .sort((a, b) => b.stock_value - a.stock_value || a.label.localeCompare(b.label));
}

/** Stock left in lots but not one sold in the chosen dates. */
export function notMoving(report: ProductsReport): ProductUnit[] {
  const sold = new Set(report.sold.filter((p) => p.units > 0).map(unitKey));
  return report.units
    .filter((u) => u.units_left > 0 && !sold.has(unitKey(u)))
    .sort((a, b) => b.stock_value - a.stock_value || a.label.localeCompare(b.label));
}

function soldSheet(name: string, rows: readonly SoldProduct[]): ReportSheet {
  return {
    name,
    columns: [text('Product', 34), num('Units sold'), text('Unit', 6), money('Sales'), money('Cost'), money('Profit'), pct('Margin %')],
    rows: rows.map((p) => [p.label, p.units, p.stock_unit, p.sales, p.cost, p.profit, p.margin]),
    total: ['Total', null, null, sum(rows.map((p) => p.sales)), sum(rows.map((p) => p.cost)), sum(rows.map((p) => p.profit)), margin(sum(rows.map((p) => p.profit)), sum(rows.map((p) => p.sales)))],
  };
}

function unitSheet(name: string, rows: readonly ProductUnit[]): ReportSheet {
  return {
    name,
    columns: [text('Product', 34), num('Units left'), text('Unit', 6), money('Stock value'), date('Last sold'), text('In the shop', 10)],
    rows: rows.map((u) => [u.label, u.units_left, u.stock_unit, u.stock_value, u.last_sold, u.is_active ? 'Yes' : 'Hidden']),
    total: ['Total', null, null, sum(rows.map((u) => u.stock_value)), null, null],
  };
}

export function productSheets(report: ProductsReport): Record<ProductsTab, ReportSheet> {
  return {
    best: soldSheet('Best sellers', bestSellers(report)),
    slow: unitSheet('Slow (no sale in 60 days)', slowProducts(report)),
    low_margin: soldSheet('Low margin', lowMargin(report)),
    not_moving: unitSheet('Not moving, stock left', notMoving(report)),
  };
}

/* --------------------------------------------------------------- Lots */

export function lotProfit(l: LotRow): number {
  return sum([l.sales, -l.cost_sold]);
}

export function lotsSheet(rows: readonly LotRow[]): ReportSheet {
  return {
    name: 'Lots',
    title: ["Naeem's Price Hub — Lots (all time)"],
    columns: [
      text('Lot', 8), date('Date'), text('Supplier', 18), num('Bought'), num('Sold'), num('On orders'), num('Removed'), num('Left'),
      money('Buy price'), money('Trip: weight'), money('Trip: other'), money('Landed cost'), money('Sales'), money('Cost of sold'),
      money('Profit so far'), pct('Margin %'), money('Stock left value'),
    ],
    rows: rows.map((l) => [
      `${l.code}${l.locked ? ' (locked)' : ''}`, l.lot_date, l.supplier, l.units_bought, l.units_sold, l.units_on_orders,
      l.units_removed - l.units_found, l.units_left, l.buy_value, l.trip_weight, l.trip_other, l.landed_total, l.sales,
      l.cost_sold, lotProfit(l), margin(lotProfit(l), l.sales), l.left_value,
    ]),
    total: [
      'Total', null, null, sum(rows.map((l) => l.units_bought)), sum(rows.map((l) => l.units_sold)), sum(rows.map((l) => l.units_on_orders)),
      sum(rows.map((l) => l.units_removed - l.units_found)), sum(rows.map((l) => l.units_left)), sum(rows.map((l) => l.buy_value)),
      sum(rows.map((l) => l.trip_weight)), sum(rows.map((l) => l.trip_other)), sum(rows.map((l) => l.landed_total)),
      sum(rows.map((l) => l.sales)), sum(rows.map((l) => l.cost_sold)), sum(rows.map(lotProfit)),
      margin(sum(rows.map(lotProfit)), sum(rows.map((l) => l.sales))), sum(rows.map((l) => l.left_value)),
    ],
  };
}

/* -------------------------------------------------------------- Stock */

export const EXPIRING_DAYS = 90;

export function expiringRows(report: StockReport): StockRow[] {
  const [y, m, d] = report.today.split('-').map(Number);
  const limit = new Date(Date.UTC(y, m - 1, d + EXPIRING_DAYS)).toISOString().slice(0, 10);
  return report.rows
    .filter((r) => r.expiry_date !== null && r.expiry_date <= limit)
    .sort((a, b) => (a.expiry_date ?? '').localeCompare(b.expiry_date ?? '') || a.label.localeCompare(b.label));
}

export function sellsText(r: StockRow): string {
  if (r.sells_in_time === null) return '';
  const speed = r.per_month > 0 ? `sells ${r.per_month} a month` : 'no sale in 90 days';
  return `${speed} → ${r.sells_in_time ? 'will sell in time' : 'will NOT sell in time'}`;
}

export function stockSheets(report: StockReport): { all: ReportSheet; expiring: ReportSheet } {
  const exp = expiringRows(report);
  return {
    all: {
      name: 'Stock',
      title: ["Naeem's Price Hub — Stock at landed cost", `On ${dayText(report.today)}`],
      columns: [text('Product', 34), text('Lot', 8), date('Expiry'), num('Units'), text('Unit', 6), money('Landed cost / unit'), money('Value')],
      rows: report.rows.map((r) => [r.label, r.lot_code, r.expiry_date, r.units, r.stock_unit, r.unit_cost, r.value]),
      total: ['Total', null, null, null, null, null, sum(report.rows.map((r) => r.value))],
    },
    expiring: {
      name: 'Expiring (90 days)',
      columns: [text('Product', 34), text('Lot', 8), date('Expiry'), num('Units'), text('Unit', 6), num('Sells a month'), text('Will it sell in time?', 22), money('Value')],
      rows: exp.map((r) => [r.label, r.lot_code, r.expiry_date, r.units, r.stock_unit, r.per_month, r.sells_in_time === null ? '' : r.sells_in_time ? 'Yes' : 'No', r.value]),
      total: ['Total', null, null, null, null, null, null, sum(exp.map((r) => r.value))],
    },
  };
}

/* ----------------------------------------------------------- Expenses */

export function expensesSheets(report: ProfitLossReport): ReportSheet[] {
  const shares = categoryShares(report.expenses_by_category);
  const sheets: ReportSheet[] = [
    {
      name: 'By category',
      title: rangeTitle('Expenses', report.from, report.to),
      columns: [text('Category', 26), money('Amount', 16), pct('Share %')],
      rows: shares.map((c) => [c.name, c.amount, c.percent]),
      total: ['Total', sum(shares.map((c) => c.amount)), shares.length > 0 ? 100 : null],
    },
  ];
  if (report.months.length > 0) {
    const cats = [...new Map(report.months.flatMap((m) => m.expenses_by_category.map((c) => [c.category_id, c.name] as const))).entries()];
    sheets.push({
      name: 'By month',
      columns: [text('Category', 26), ...report.months.map((m) => money(shortMonth(m.month), 12)), money('Total', 14)],
      rows: cats.map(([id, name]) => [
        name,
        ...report.months.map((m) => m.expenses_by_category.find((c) => c.category_id === id)?.amount ?? 0),
        report.expenses_by_category.find((c) => c.category_id === id)?.amount ?? 0,
      ]),
      total: ['Total', ...report.months.map((m) => m.expenses), report.parts.expenses],
    });
  }
  return sheets;
}

/* ---------------------------------------------------------- Customers */

export function customerSheets(report: CustomersReport): ReportSheet[] {
  const byProfit = [...report.top].sort((a, b) => b.profit - a.profit);
  return [
    {
      name: 'To receive (by age)',
      title: [`Naeem's Price Hub — Customers owe (To receive) on ${dayText(report.today)}`],
      columns: [text('Customer', 24), text('Phone', 14), money('0–30 days'), money('31–60 days'), money('Over 60 days'), money('Total'), num('Oldest (days)')],
      rows: report.dues.map((d) => [d.name, d.phone, d.d0, d.d31, d.d61, d.total, d.oldest_days]),
      total: ['Total', null, sum(report.dues.map((d) => d.d0)), sum(report.dues.map((d) => d.d31)), sum(report.dues.map((d) => d.d61)), sum(report.dues.map((d) => d.total)), null],
    },
    {
      name: 'Top by bought',
      title: rangeTitle('Top customers', report.from, report.to),
      columns: [text('Customer', 24), text('Phone', 14), num('Orders'), money('Bought'), money('Profit')],
      rows: report.top.map((c) => [c.name, c.phone, c.orders, c.bought, c.profit]),
      total: ['Total', null, sum(report.top.map((c) => c.orders)), sum(report.top.map((c) => c.bought)), sum(report.top.map((c) => c.profit))],
    },
    {
      name: 'Top by profit',
      columns: [text('Customer', 24), text('Phone', 14), num('Orders'), money('Bought'), money('Profit')],
      rows: byProfit.map((c) => [c.name, c.phone, c.orders, c.bought, c.profit]),
      total: ['Total', null, sum(byProfit.map((c) => c.orders)), sum(byProfit.map((c) => c.bought)), sum(byProfit.map((c) => c.profit))],
    },
  ];
}


/* ----------------------------------------------------------- Day book */

export function ledgerLabel(type: string): string {
  return typeLabel(type as LedgerType);
}

export function dayBookSheets(report: DayBookReport): ReportSheet[] {
  return report.accounts.map((a) => ({
    name: a.name,
    title: [`Naeem's Price Hub — Day book: ${a.name}`, report.from === report.to ? dayText(report.from) : `${dayText(report.from)} – ${dayText(report.to)}`],
    columns: [date('Date'), text('What', 26), text('Note', 26), money('In'), money('Out'), money('Balance', 15)],
    rows: [
      [report.from, 'Balance before', null, null, null, a.opening] as ReportValue[],
      ...a.lines.map((l) => [
        l.date,
        `${ledgerLabel(l.type)}${l.category ? ` — ${l.category}` : ''}`,
        [l.reference, l.note].filter(Boolean).join(' · ') || null,
        l.amount > 0 ? l.amount : null,
        l.amount < 0 ? -l.amount : null,
        l.balance,
      ]),
    ],
    total: ['Total', null, null, a.money_in, a.money_out, a.closing],
  }));
}

/* ---------------------------------------------------------- Investors */

export function investorsSheet(rows: readonly InvestorRow[], from: string, to: string): ReportSheet {
  return {
    name: 'Investors',
    title: rangeTitle('Investors', from, to),
    columns: [
      text('Investor', 24), money('Capital in (all)'), money('Returned (all)'), money('Still owed'), money('Profit share paid (all)'),
      money('In (dates)'), money('Returned (dates)'), money('Profit share (dates)'),
    ],
    rows: rows.map((r) => [r.name, r.capital_in, r.capital_back, r.owed, r.share_all, r.in_range, r.back_range, r.share_range]),
    total: [
      'Total', sum(rows.map((r) => r.capital_in)), sum(rows.map((r) => r.capital_back)), sum(rows.map((r) => r.owed)),
      sum(rows.map((r) => r.share_all)), sum(rows.map((r) => r.in_range)), sum(rows.map((r) => r.back_range)), sum(rows.map((r) => r.share_range)),
    ],
  };
}

/* ------------------------------------------------------------- Charts */

export function chartsSheet(report: ChartsReport): ReportSheet {
  return {
    name: 'By month',
    title: ["Naeem's Price Hub — the last 12 months"],
    columns: [text('Month', 14), money('Your profit'), money('Net profit'), money('Money in'), money('Money out')],
    rows: report.months.map((m) => [`${shortMonth(m.month)}${m.locked ? ' (locked)' : ''}`, m.your_profit, m.net_profit, m.money_in, m.money_out]),
    total: [
      'Total', sum(report.months.map((m) => m.your_profit)), sum(report.months.map((m) => m.net_profit)),
      sum(report.months.map((m) => m.money_in)), sum(report.months.map((m) => m.money_out)),
    ],
  };
}

