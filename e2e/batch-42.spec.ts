import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, rpc, select, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 42: the Dashboard, Reports, the monthly stock count and the month
// lock.
//
// The live books are never touched:
//   - every rule with numbers runs in e2e/sql/batch-42-reports.sql, inside
//     ONE database transaction that is always rolled back (one shared set of
//     test data; every report total compared with the Batch 39 / 41
//     functions; the count; the lock against every kind of record);
//   - the screens are checked at 360 px (phone) and 1440 px (computer) with
//     the database answers mocked in the browser, so the screens show known
//     numbers; nothing is locked or counted for real (the lock and the count
//     calls are mocked too).
// Steadfast is mocked by ./fixtures; no real Storage file is downloaded.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-42-screens';

let admin: TestSession;

async function adminAt(page: Page, path: string, width = 360): Promise<void> {
  await page.setViewportSize({ width, height: width >= 1024 ? 900 : 800 });
  await useSessionInPage(page, admin);
  await page.goto(path);
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function shot(page: Page, name: string): Promise<void> {
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true });
}

/** Answers one database function in the browser with a fixed reply. */
async function mockRpc(page: Page, fn: string, reply: unknown | ((args: Record<string, unknown>) => unknown)): Promise<string[]> {
  const calls: string[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push(JSON.stringify(args));
    const body = typeof reply === 'function' ? (reply as (a: Record<string, unknown>) => unknown)(args) : reply;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  return calls;
}

/* --------------------------------------------------------------- fixtures */

const PROFIT = {
  from: '2026-11-01', to: '2026-11-10', orders: 12, uncosted_orders: 0, sales: 48000, cost: 26000, provisional: 0, delivery: 1800,
  courier: 1450, cost_adjustments: 0, expenses: 6200, write_offs: 350, net_profit: 15800, profit_share: 3000, your_profit: 12800,
  withdrawals: 5000, left_in_business: 7800, owner_money_in: 0, not_shop_money: 0, count_differences: 0,
};

function summaryFixture(balanced: boolean) {
  const accounts = [
    { account_id: 'a1', name: 'Cash', kind: 'cash', archived: false, balance: 8200 },
    { account_id: 'a2', name: 'bKash', kind: 'bkash', archived: false, balance: 12650 },
    { account_id: 'a3', name: 'Bank', kind: 'bank', archived: false, balance: 64300 },
    { account_id: 'a4', name: 'With Steadfast', kind: 'steadfast', archived: false, balance: 9120 },
  ];
  return {
    profit: PROFIT,
    expenses_by_category: [],
    position: {
      start_date: '2026-10-01', accounts, accounts_total: 85150, with_steadfast: 9120, steadfast_reported: 9120, steadfast_reported_at: null,
      unplaced_payouts: [], to_receive: 14200, previous_balances: 3070, customer_advances: 0, stock_value: 210000, goods_on_open_orders: 0,
      open_orders_value: 0, sold_without_stock: 0, to_give: 60000, to_give_investors: 50000, to_give_suppliers: 10000, to_give_others: 0,
      have: 321540, owe: 60000, net_worth: 261540,
      opening: { accounts: 90000, previous_balances: 3070, stock: 200000, site_orders: 0, payables: 60000, total: 233070 },
      since_start: PROFIT, outside_orders: 0, outside_fees: 0, outside_unmatched: 0, outside: 0,
      expected: balanced ? 261540 : 261660, difference: balanced ? 0 : -120, balanced, first_wrong: balanced ? null : '2026-11-09',
    },
    roi: { average_money: 247305, begin: 233070, end: 261540, percent: 6.4 },
    last_payout_account_id: null,
    confirmed: true,
    inventory_mode: true,
  };
}

function dashboardFixture(balanced = true) {
  return {
    summary: summaryFixture(balanced),
    previous: { from: '2026-10-01', to: '2026-10-10', your_profit: 10000, net_profit: 12000 },
    attention: {
      expiring: 2, sold_without_stock: 1, dues_over_30: 3, dues_over_30_amount: 4600, no_buy_price: 0, no_weight: 4,
      count_planned: 18, count_done: 5, count_due: true, last_month_locked: false, last_month: '2026-10-01',
    },
  };
}

const PARTS = { ...PROFIT, from: '2026-09-01', to: '2026-10-31', gross_profit: 22000 };
const MONTH = (month: string, f: number) => ({
  ...PROFIT,
  month,
  sales: 48000 * f, cost: 26000 * f, gross_profit: 22000 * f, delivery: 1800 * f, courier: 1450 * f, expenses: 6200 * f,
  write_offs: 350 * f, net_profit: 15800 * f, profit_share: 3000 * f, your_profit: 12800 * f, withdrawals: 5000 * f, left_in_business: 7800 * f,
  expenses_by_category: [{ category_id: 'c1', name: 'Ads', amount: 4000 * f }, { category_id: 'c2', name: 'Packaging', amount: 2200 * f }],
  locked: month === '2026-09-01',
});

function pnlFixture(from: string, to: string) {
  const months = from.slice(0, 7) === to.slice(0, 7) ? [] : [MONTH('2026-09-01', 0.5), MONTH('2026-10-01', 0.5)];
  return {
    from, to,
    parts: PARTS,
    expenses_by_category: [{ category_id: 'c1', name: 'Ads', amount: 4000 }, { category_id: 'c2', name: 'Packaging', amount: 2200 }],
    months,
    locked_months: months.length > 0 ? ['2026-09-01'] : [],
    start_date: '2026-09-01',
  };
}

const SALES = {
  from: '2026-11-01', to: '2026-11-10',
  totals: { entries: 3, returned: 0, total: 4580, received: 2580, unpaid: 2000 },
  by_source: [{ source: 'web', entries: 2, total: 2580 }, { source: 'facebook', entries: 1, total: 2000 }],
  by_day: [],
  orders: [
    { order_id: 'o1', order_number: 'ORD-1101', day: '2026-11-02', status: 'delivered', source: 'web', customer_name: 'Rina', total: 1290, paid: 1290, due: 0 },
    { order_id: 'o2', order_number: 'ORD-1102', day: '2026-11-04', status: 'delivered', source: 'web', customer_name: 'Mitu', total: 1290, paid: 1290, due: 0 },
    { order_id: 'o3', order_number: 'NM-1103', day: '2026-11-06', status: 'shipped', source: 'facebook', customer_name: 'Sadia', total: 2000, paid: 0, due: 2000 },
  ],
  locked_months: [],
};

const PRODUCTS = {
  from: '2026-11-01', to: '2026-11-10',
  totals: { sales: 6000, cost: 3800, profit: 2200, orders: 3, uncosted_orders: 0 },
  sold: [
    { product_id: 'p1', variant_id: null, label: 'Fish Oil 400', units: 6, stock_unit: 'pcs', pack_size: 1, sales: 4200, cost: 2400, profit: 1800, margin: 42.9 },
    { product_id: 'p2', variant_id: null, label: 'Vitamin C Serum', units: 2, stock_unit: 'pcs', pack_size: 1, sales: 1800, cost: 1600, profit: 200, margin: 11.1 },
  ],
  units: [
    { product_id: 'p1', variant_id: null, label: 'Fish Oil 400', is_active: true, stock_unit: 'pcs', pack_size: 1, units_left: 14, stock_value: 5600, sold_60: 9, last_sold: '2026-11-08', has_cost: true },
    { product_id: 'p3', variant_id: null, label: 'Night Cream', is_active: true, stock_unit: 'pcs', pack_size: 1, units_left: 5, stock_value: 3500, sold_60: 0, last_sold: '2026-07-14', has_cost: true },
  ],
  locked_months: [],
};

const LOTS = [
  {
    lot_id: 'l1', code: 'L-001', kind: 'purchase', lot_date: '2026-10-12', supplier: 'Sydney trip', costs_pending: false, rows: 4,
    units_bought: 60, units_sold: 22, units_on_orders: 2, units_removed: 1, units_found: 0, units_left: 35, buy_value: 30000,
    trip_weight: 4200, trip_other: 800, landed_total: 35000, left_value: 20400, sales: 19800, cost_sold: 12800, locked: false,
  },
];

const STOCK = {
  today: '2026-11-10',
  total_value: 9100,
  rows: [
    { lot_item_id: 'i1', product_id: 'p1', variant_id: null, label: 'Fish Oil 400', stock_unit: 'pcs', pack_size: 1, lot_code: 'L-001', lot_date: '2026-10-12', expiry_date: '2026-12-01', units: 14, unit_cost: 400, value: 5600, per_month: 3, units_before: 0, sells_in_time: false },
    { lot_item_id: 'i2', product_id: 'p3', variant_id: null, label: 'Night Cream', stock_unit: 'pcs', pack_size: 1, lot_code: 'L-000', lot_date: '2026-10-01', expiry_date: '2027-09-01', units: 5, unit_cost: 700, value: 3500, per_month: 0, units_before: 0, sells_in_time: false },
  ],
};

const CUSTOMERS = {
  from: '2026-01-01', to: '2026-11-10', today: '2026-11-10',
  dues: [
    { customer_key: 'k1', name: 'Sadia', phone: '01711000001', order_due: 2000, previous_left: 0, total: 2000, d0: 2000, d31: 0, d61: 0, oldest_days: 4 },
    { customer_key: 'k2', name: 'Lima', phone: '01711000002', order_due: 900, previous_left: 1500, total: 2400, d0: 0, d31: 900, d61: 1500, oldest_days: 70 },
  ],
  top: [{ customer_key: 'k3', name: 'Rina', phone: '01711000003', bought: 12000, profit: 3100, orders: 6 }],
};

const DAYBOOK = {
  from: '2026-11-10', to: '2026-11-10', locked_months: [],
  accounts: [
    { account_id: 'a1', name: 'Cash', kind: 'cash', opening: 8000, money_in: 500, money_out: 300, closing: 8200, lines: [
      { date: '2026-11-10', type: 'customer_payment', amount: 500, balance: 8500, note: null, reference: 'NM-1103', category: null, by: 'naeem', source: 'payment', source_id: 'x1' },
      { date: '2026-11-10', type: 'expense', amount: -300, balance: 8200, note: 'tape', reference: null, category: 'Packaging', by: 'naeem', source: 'movement', source_id: 'x2' },
    ] },
  ],
};

const INVESTORS = [{ id: 'v1', name: 'Rafi', capital_in: 50000, capital_back: 0, owed: 50000, share_all: 6000, in_range: 0, back_range: 0, share_range: 3000 }];

const CHARTS = {
  from: '2025-12-01', to: '2026-11-10',
  months: Array.from({ length: 12 }, (_, i) => {
    const m = i === 0 ? '2025-12-01' : `2026-${String(i).padStart(2, '0')}-01`;
    return { month: m, your_profit: i === 3 ? -1500 : 4000 + i * 900, net_profit: 5000 + i * 900, money_in: 30000 + i * 1500, money_out: 26000 + i * 1200, locked: i < 10 };
  }),
};

async function mockReports(page: Page): Promise<void> {
  await mockRpc(page, 'report_profit_loss', (a) => pnlFixture(String(a.p_from), String(a.p_to)));
  await mockRpc(page, 'report_sales', SALES);
  await mockRpc(page, 'report_products', PRODUCTS);
  await mockRpc(page, 'report_lots', LOTS);
  await mockRpc(page, 'report_stock', STOCK);
  await mockRpc(page, 'report_customers', CUSTOMERS);
  await mockRpc(page, 'report_day_book', DAYBOOK);
  await mockRpc(page, 'report_investors', INVESTORS);
  await mockRpc(page, 'report_charts', CHARTS);
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

/* ------------------------------------------------------------ database */

test('database: reports agree with the Batch 39/41 functions, the count, the month lock (one rolled-back transaction)', async () => {
  test.skip(!supabaseCli(), 'The Supabase command line is not on this computer.');
  test.setTimeout(300_000);
  const script = readFileSync('e2e/sql/batch-42-reports.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(script);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? output.slice(0, 400)).not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  const skipped = (results ?? []).some((r) => r.detail === 'skipped');
  if (!skipped) expect((results ?? []).length).toBeGreaterThanOrEqual(40);
  // Nothing of it stayed.
  const locks = await select<unknown[]>(admin.accessToken, 'money_month_locks?select=month');
  if (!skipped) expect(locks.data).toHaveLength(0);
  const products = await select<unknown[]>(admin.accessToken, 'products?select=id&sku=like.E2E-B42-*');
  expect(products.data).toHaveLength(0);
  const mode = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.inventory_mode');
  expect(mode.data?.[0]?.value).toBe('false');
});

test('permissions: the public and a customer get nothing from the Dashboard, reports, count or lock', async () => {
  const customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  const today = '2026-11-10';
  for (const token of [null, customer.accessToken]) {
    for (const [fn, args] of [
      ['money_dashboard', { p_from: today, p_to: today, p_prev_from: null, p_prev_to: null }],
      ['report_profit_loss', { p_from: today, p_to: today }],
      ['report_sales', { p_from: today, p_to: today }],
      ['report_day_book', { p_from: today, p_to: today }],
      ['report_lots', {}],
      ['report_stock', {}],
      ['report_charts', {}],
      ['stock_count_pick', {}],
      ['money_lock_checklist', { p_month: '2026-10-01' }],
      ['money_lock_month', { p_month: '2026-10-01' }],
      ['money_unlock_month', { p_month: '2026-10-01', p_reason: 'test test' }],
    ] as const) {
      const res = await rpc(token, fn, args);
      expect(res.ok, `${fn} as ${token ? 'customer' : 'public'}`).toBe(false);
    }
    for (const table of ['money_month_locks', 'stock_counts', 'stock_count_plans']) {
      const res = await select<unknown[]>(token, `${table}?select=*&limit=5`);
      expect(res.data ?? [], `${table} as ${token ? 'customer' : 'public'}`).toHaveLength(0);
    }
  }
});

/* ------------------------------------------------------------ Dashboard */

test('Dashboard (phone): Your profit with ▲ %, You took, Left in the business, return on money, Money now with "Books balance"', async ({ page }) => {
  test.setTimeout(60_000);
  const calls = await mockRpc(page, 'money_dashboard', dashboardFixture(true));
  await adminAt(page, '/admin');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('dash-your-profit')).toHaveText('৳12,800');
  await expect(page.getByTestId('dash-change')).toContainText('▲ 28%');
  await expect(page.getByTestId('dash-took')).toHaveText('You took ৳5,000');
  await expect(page.getByTestId('dash-left')).toHaveText('Left in the business ৳7,800');
  await expect(page.getByTestId('dash-roi-value')).toHaveText('6.4%');
  await expect(page.getByTestId('dash-receive')).toHaveText('৳17,270');
  await expect(page.getByTestId('dash-give')).toHaveText('৳60,000');
  await expect(page.getByTestId('dash-stock')).toHaveText('৳2,10,000');
  await expect(page.getByTestId('dash-steadfast')).toHaveText('৳9,120');
  await expect(page.getByTestId('dash-money')).toContainText('bKash');
  await expect(page.getByTestId('dash-balance-ok')).toHaveText('Books balance');
  // Needs attention: the new lines (each taps to its screen).
  await expect(page.getByText('products expiring before they sell')).toBeVisible();
  await expect(page.getByText('sold without stock (still open)')).toBeVisible();
  await expect(page.getByText('customers owing for over 30 days (৳4,600)')).toBeVisible();
  await expect(page.getByText('products with no weight')).toBeVisible();
  await expect(page.getByText('Monthly stock count: 5 of 18 counted')).toBeVisible();
  // The month is compared with the same days of last month.
  expect(JSON.parse(calls[0])).toMatchObject({ p_prev_from: expect.stringMatching(/-01$/) });
  await shot(page, '01-dashboard-phone.png');

  await page.getByRole('button', { name: 'Today', exact: true }).first().click();
  await expect.poll(() => calls.length).toBeGreaterThan(1);
  const today = JSON.parse(calls[calls.length - 1]) as { p_from: string; p_to: string; p_prev_from: string };
  expect(today.p_from).toBe(today.p_to);

  await page.getByText('products expiring before they sell').click();
  await expect(page).toHaveURL(/tab=reports&r=stock/);
});

test('Dashboard (computer, 1440 px): left menu, cards side by side; red badge when the books are off', async ({ page }) => {
  test.setTimeout(60_000);
  await mockRpc(page, 'money_dashboard', dashboardFixture(false));
  await adminAt(page, '/admin', 1440);
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.adm-sidebar')).toBeVisible();
  await expect(page.getByTestId('dash-balance-off')).toHaveText('Off by −৳120');
  const profit = await page.getByTestId('dash-profit').boundingBox();
  const roi = await page.getByTestId('dash-roi').boundingBox();
  const money = await page.getByTestId('dash-money').boundingBox();
  expect(profit && roi && money).toBeTruthy();
  // Three columns: the cards sit next to each other.
  expect(Math.abs((profit?.y ?? 0) - (roi?.y ?? 1))).toBeLessThan(4);
  expect((roi?.x ?? 0) > (profit?.x ?? 0) && (money?.x ?? 0) > (roi?.x ?? 0)).toBe(true);
  const width = await page.evaluate(() => document.querySelector('.adm-home')?.getBoundingClientRect().width ?? 0);
  expect(width).toBeLessThanOrEqual(1240);
  await shot(page, '02-dashboard-computer.png');
});

test('Dashboard numbers are the Money page numbers (the same call underneath)', async ({ page }) => {
  test.setTimeout(60_000);
  await mockRpc(page, 'money_dashboard', dashboardFixture(true));
  await mockRpc(page, 'money_summary', summaryFixture(true));
  await adminAt(page, '/admin');
  await expect(page.getByTestId('dash-your-profit')).toHaveText('৳12,800', { timeout: 20_000 });
  const dash = {
    profit: await page.getByTestId('dash-your-profit').innerText(),
    receive: await page.getByTestId('dash-receive').innerText(),
    left: (await page.getByTestId('dash-left').innerText()).replace('Left in the business ', ''),
  };
  await page.goto('/admin?tab=money');
  await expect(page.getByTestId('money-your-profit')).toBeVisible({ timeout: 20_000 });
  expect(await page.getByTestId('money-your-profit').innerText()).toBe(dash.profit);
  expect(await page.getByTestId('money-to-receive').innerText()).toContain(dash.receive);
  expect(await page.getByTestId('money-left').innerText()).toContain(dash.left);
});

/* -------------------------------------------------------------- Reports */

test('Reports menu: 10 reports and the monthly routine; Profit & loss with month columns and a lock mark', async ({ page }) => {
  test.setTimeout(90_000);
  await mockReports(page);
  await adminAt(page, '/admin?tab=reports');
  for (const id of ['pnl', 'sales', 'products', 'lots', 'stock', 'expenses', 'customers', 'daybook', 'investors', 'charts']) {
    await expect(page.getByTestId(`report-row-${id}`)).toBeVisible({ timeout: 20_000 });
  }
  await shot(page, '03-reports-menu.png');
  await page.getByTestId('report-row-pnl').click();
  await expect(page.getByTestId('pnl-table')).toBeVisible({ timeout: 20_000 });
  for (const label of ['Today', 'Yesterday', 'This week', 'This month', 'Last month', 'This year', 'All time', 'Custom']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('pnl-net')).toHaveText('৳15,800');
  await expect(page.getByTestId('pnl-table')).toContainText('Gross profit');
  await expect(page.getByTestId('pnl-table')).toContainText('Investor profit share');
  await expect(page.getByTestId('pnl-table')).toContainText('Left in the business');
  await expect(page.locator('.adm-btn--primary:visible')).toHaveCount(1);
  await shot(page, '04-report-pnl-month-phone.png');
  await page.getByRole('button', { name: 'This year', exact: true }).click();
  await expect(page.getByTestId('pnl-table')).toContainText('Sep 2026 (locked)');
  await expect(page.getByTestId('report-locked')).toContainText('Locked: Sep 2026');
  await shot(page, '05-report-pnl-year-phone.png');
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, '06-report-pnl-year-computer.png');
});

test('Excel: Profit & loss downloads with real numbers and the totals equal the screen', async ({ page }) => {
  test.setTimeout(90_000);
  await mockReports(page);
  await adminAt(page, '/admin?tab=reports&r=pnl&rp=year');
  await expect(page.getByTestId('pnl-table')).toBeVisible({ timeout: 20_000 });
  const screenNet = (await page.getByTestId('pnl-table').locator('tr', { hasText: 'Net profit' }).locator('td').last().innerText()).trim();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('report-excel').click()]);
  expect(download.suggestedFilename()).toMatch(/^naeem-profit-loss-\d{4}-01-01-to-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const path = await download.path();
  const sheets = (await readXlsxFile(path)) as unknown as { sheet: string; data: unknown[][] }[];
  const pnl = sheets.find((s) => s.sheet === 'Profit & loss');
  expect(pnl).toBeTruthy();
  const net = pnl?.data.find((r) => String(r[0]).trim() === 'Net profit');
  const total = net?.[net.length - 1];
  expect(typeof total).toBe('number');
  expect(total).toBe(15800);
  expect(screenNet).toBe('৳15,800');
  // The month columns add up to the total in the file too.
  expect(Number(net?.[1]) + Number(net?.[2])).toBe(15800);
});

test('Excel: Sales has one sheet per table and its totals equal the screen', async ({ page }) => {
  test.setTimeout(90_000);
  await mockReports(page);
  await adminAt(page, '/admin?tab=reports&r=sales');
  await expect(page.getByTestId('sales-total')).toHaveText('৳4,580', { timeout: 20_000 });
  await expect(page.getByTestId('sales-received')).toHaveText('৳2,580');
  await expect(page.getByTestId('sales-unpaid')).toHaveText('৳2,000');
  await expect(page.getByTestId('sales-sources')).toContainText('Website');
  await expect(page.getByTestId('sales-sources')).toContainText('Manual — Facebook');
  await shot(page, '07-report-sales.png');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('report-excel').click()]);
  const sheets = (await readXlsxFile(await download.path())) as unknown as { sheet: string; data: unknown[][] }[];
  expect(sheets.map((s) => s.sheet)).toEqual(['Summary', 'By source', 'Orders']);
  const orders = sheets[2].data;
  const totalRow = orders[orders.length - 1];
  expect(totalRow.slice(5)).toEqual([4580, 2580, 2000]);
});

test('Products, Lots, Stock (expiring), Expenses, Customers, Day book, Investors, Charts', async ({ page }) => {
  test.setTimeout(120_000);
  await mockReports(page);
  await adminAt(page, '/admin?tab=reports&r=products');
  await expect(page.getByTestId('products-best')).toContainText('Fish Oil 400', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Low margin (under 15%)' }).click();
  await expect(page.getByTestId('products-low_margin')).toContainText('Vitamin C Serum');
  await page.getByRole('button', { name: 'Slow (no sale in 60 days)' }).click();
  await expect(page.getByTestId('products-slow')).toContainText('Night Cream');
  await page.getByRole('button', { name: 'Not moving, stock left' }).click();
  await expect(page.getByTestId('products-not_moving')).toContainText('Night Cream');
  await shot(page, '08-report-products.png');

  await page.goto('/admin?tab=reports&r=lots');
  await expect(page.getByTestId('lots-table')).toContainText('L-001', { timeout: 20_000 });
  await expect(page.getByTestId('lots-table')).toContainText('৳7,000');
  await shot(page, '09-report-lots.png');

  await page.goto('/admin?tab=reports&r=stock');
  await expect(page.getByTestId('stock-value')).toHaveText('৳9,100', { timeout: 20_000 });
  await page.getByRole('button', { name: /Expiring \(90 days\)/ }).click();
  await expect(page.getByTestId('stock-expiring')).toContainText('sells 3 a month → will NOT sell in time');
  await shot(page, '10-report-stock-expiring.png');

  await page.goto('/admin?tab=reports&r=expenses');
  await expect(page.getByTestId('expenses-total')).toHaveText('৳6,200', { timeout: 20_000 });
  await expect(page.getByTestId('expenses-categories')).toContainText('65%');
  await shot(page, '11-report-expenses.png');

  await page.goto('/admin?tab=reports&r=customers');
  await expect(page.getByTestId('cust-due-total')).toHaveText('৳4,400', { timeout: 20_000 });
  await expect(page.getByTestId('cust-d61')).toHaveText('৳1,500');
  await shot(page, '12-report-customers.png');

  await page.goto('/admin?tab=reports&r=daybook');
  await expect(page.getByTestId('daybook-account')).toContainText('Balance before', { timeout: 20_000 });
  await expect(page.getByTestId('daybook-account')).toContainText('৳8,200');
  await shot(page, '13-report-daybook.png');

  await page.goto('/admin?tab=reports&r=investors');
  await expect(page.getByTestId('investors-table')).toContainText('Rafi', { timeout: 20_000 });
  await expect(page.getByTestId('inv-owed')).toHaveText('৳50,000');

  await page.goto('/admin?tab=reports&r=charts');
  await expect(page.getByTestId('chart-profit')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('chart-money')).toContainText('Money out');
  // Labels on the bars, nothing animates.
  await expect(page.getByTestId('chart-profit').locator('.rep-chart__value')).toHaveCount(12);
  const animated = await page.evaluate(() =>
    [...document.querySelectorAll('.rep-chart *')].some((el) => getComputedStyle(el).animationName !== 'none' || getComputedStyle(el).transitionDuration !== '0s')
  );
  expect(animated).toBe(false);
  await shot(page, '14-report-charts.png');
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, '15-report-charts-computer.png');
});

test('Print / PDF: the menus and buttons are hidden on paper', async ({ page }) => {
  test.setTimeout(60_000);
  await mockReports(page);
  await adminAt(page, '/admin?tab=reports&r=pnl', 1440);
  await expect(page.getByTestId('pnl-table')).toBeVisible({ timeout: 20_000 });
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.adm-sidebar')).toBeHidden();
  await expect(page.getByTestId('report-excel')).toBeHidden();
  await expect(page.locator('.rep-print-head')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
});

/* ------------------------------------------------- count and month lock */

const PLAN = {
  month: '2026-11-01',
  inventory_mode: true,
  rows: [
    { plan_id: 'pl1', product_id: '00000000-0000-0000-0000-0000000000a1', variant_id: null, label: 'Fish Oil 400', why: 'fast', stock_unit: 'pcs', pack_size: 1, system_units: 14, last_count: null, counted: false, counted_units: null, difference: null, counted_date: null },
    { plan_id: 'pl2', product_id: '00000000-0000-0000-0000-0000000000a2', variant_id: null, label: 'Night Cream', why: 'never', stock_unit: 'pcs', pack_size: 1, system_units: 5, last_count: null, counted: false, counted_units: null, difference: null, counted_date: null },
    { plan_id: 'pl3', product_id: '00000000-0000-0000-0000-0000000000a3', variant_id: null, label: 'Fish oil bulk', why: 'value', stock_unit: 'ml', pack_size: 400, system_units: 1350, last_count: '2026-06-02', counted: false, counted_units: null, difference: null, counted_date: null },
  ],
};

test('Monthly count: the list, "system says N", a test count of 2 products (saved through a mocked call)', async ({ page }) => {
  test.setTimeout(60_000);
  await mockRpc(page, 'stock_count_pick', PLAN);
  await mockRpc(page, 'stock_count_history', []);
  const saved = await mockRpc(page, 'stock_count_save', [
    { count_id: 'c1', product_id: PLAN.rows[0].product_id, variant_id: null, label: 'Fish Oil 400', system_units: 14, counted_units: 13, difference: -1, write_off_id: 'w1' },
    { count_id: 'c2', product_id: PLAN.rows[1].product_id, variant_id: null, label: 'Night Cream', system_units: 5, counted_units: 6, difference: 1, write_off_id: 'w2' },
  ]);
  await adminAt(page, '/admin?tab=money&m=stock-count');
  await expect(page.getByTestId('count-row')).toHaveCount(3, { timeout: 20_000 });
  await expect(page.getByTestId('count-system').first()).toHaveText('14');
  await expect(page.getByTestId('count-row').nth(2)).toContainText('3 packs + 150 ml');
  await page.getByTestId(`count-input-${PLAN.rows[0].product_id}:`).fill('13');
  await page.getByTestId(`count-input-${PLAN.rows[1].product_id}:`).fill('6');
  await expect(page.getByTestId('count-preview').first()).toHaveText('1 pcs fewer → written off (Count difference)');
  await expect(page.getByTestId('count-preview').nth(1)).toHaveText('1 pcs more → added back to the newest lot');
  await expect(page.locator('.adm-btn--primary:visible')).toHaveCount(1);
  await shot(page, '16-count.png');
  await page.getByTestId('count-save').click();
  await expect.poll(() => saved.length).toBe(1);
  expect(JSON.parse(saved[0])).toEqual({
    p_rows: [
      { product_id: PLAN.rows[0].product_id, variant_id: null, counted: 13, note: null },
      { product_id: PLAN.rows[1].product_id, variant_id: null, counted: 6, note: null },
    ],
  });
  await expect(page.getByText('Saved 2 counts · 2 differences recorded')).toBeVisible();
});

const CHECK_NOT_READY = {
  month: '2026-10-01', label: 'October 2026', ready: false, locked: false, locked_at: null, locked_by: null, unlocked_at: null, unlocked_by: null, unlock_reason: null,
  items: [
    { key: 'over', ok: true, title: 'The month is over', detail: 'October 2026 has ended.' },
    { key: 'balance', ok: true, title: 'Books balance', detail: 'The balance check is green.' },
    { key: 'orders', ok: false, title: 'No orders still processing', detail: '2 orders are still To confirm, Confirmed or In transit.', orders: ['ORD-1094', 'NM-1095'] },
    { key: 'payouts', ok: true, title: 'Steadfast payouts recorded', detail: 'Every payout of that month is placed in an account.' },
    { key: 'count', ok: false, title: 'Stock count done', detail: '12 of 18 products counted (Money → Monthly stock count).' },
  ],
};

test('Lock a month: the checklist (without locking); the button stays off until every line is ticked', async ({ page }) => {
  test.setTimeout(60_000);
  const locks = await mockRpc(page, 'money_lock_month', {});
  await mockRpc(page, 'money_lock_checklist', CHECK_NOT_READY);
  await mockRpc(page, 'money_locked_months', []);
  await adminAt(page, '/admin?tab=money&m=lock');
  await expect(page.getByTestId('lock-checklist')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('lock-item-orders')).toContainText('ORD-1094');
  await expect(page.getByTestId('lock-item-count')).toContainText('12 of 18');
  await expect(page.getByTestId('lock-button')).toBeDisabled();
  await expect(page.getByTestId('lock-button')).toHaveText('Lock October 2026…');
  await shot(page, '17-lock-checklist.png');
  expect(locks).toHaveLength(0);
});

test('Lock a month: with every line ticked — Careful actions + password; then it shows locked (lock call mocked)', async ({ page }) => {
  test.setTimeout(60_000);
  const ready = { ...CHECK_NOT_READY, ready: true, items: CHECK_NOT_READY.items.map((i) => ({ ...i, ok: true })) };
  let locked = false;
  await mockRpc(page, 'money_lock_checklist', () => (locked ? { ...ready, locked: true, locked_at: '2026-11-10T10:00:00Z', locked_by: 'naeem' } : ready));
  await mockRpc(page, 'money_locked_months', () => (locked ? [{ month: '2026-10-01', label: 'October 2026', locked: true, locked_at: '2026-11-10T10:00:00Z', locked_by: 'naeem', unlocked_at: null, unlocked_by: null, unlock_reason: null }] : []));
  const calls = await mockRpc(page, 'money_lock_month', () => {
    locked = true;
    return { ...ready, locked: true };
  });
  await adminAt(page, '/admin?tab=money&m=lock');
  await expect(page.getByTestId('lock-button')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('lock-button').click();
  await page.getByTestId('lock-password').fill('wrong-password-for-test');
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByTestId('lock-error')).toHaveText('Password is incorrect.', { timeout: 15_000 });
  expect(calls).toHaveLength(0);
  await page.getByTestId('lock-password').fill(E2E_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByTestId('lock-status')).toContainText('October 2026 is locked', { timeout: 15_000 });
  expect(calls).toHaveLength(1);
  await expect(page.getByTestId('unlock-button')).toBeVisible();
  await shot(page, '18-lock-locked.png');
});

/* ------------------------------------------------- live (no mocks, read only) */

test('live: the Dashboard and every report open with the real database (nothing is changed)', async ({ page }) => {
  test.setTimeout(120_000);
  await adminAt(page, '/admin');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('dash-your-profit')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('dash-error')).toHaveCount(0);
  for (const id of ['pnl', 'sales', 'products', 'lots', 'stock', 'expenses', 'customers', 'daybook', 'investors', 'charts']) {
    await page.goto(`/admin?tab=reports&r=${id}`);
    await expect(page.getByTestId('report-excel')).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByText('Could not load')).toHaveCount(0);
  }
  await page.goto('/admin?tab=money&m=lock');
  await expect(page.getByTestId('lock-checklist')).toBeVisible({ timeout: 30_000 });
  await page.goto('/admin?tab=money&m=stock-count');
  await expect(page.getByTestId('count-progress')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('count-mode-off')).toBeVisible();
});
