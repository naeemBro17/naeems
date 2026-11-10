import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import writeExcelFile from 'write-excel-file/node';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_MOD_PASSWORD, E2E_PASSWORD } from './helpers/env';
import { callFunction, passwordSession, rpc, select, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';
import { startDevServer } from './helpers/devServer';

// Batch 41: money — accounts, expenses, investors, owner, dues, opening
// balances, write-offs, the Money page.
//
// The live books are never touched:
//   - every rule with numbers runs in e2e/sql/batch-41-money.sql, inside ONE
//     database transaction that is always rolled back (opening balances,
//     entries, a lot, orders, a mocked Steadfast payout, write-offs);
//   - the screens are checked at phone width (360 px); where a screen needs
//     numbers that only exist after the opening balances are confirmed, the
//     database answer is mocked in the browser;
//   - the only real entries are a ৳1 test expense (added and deleted again)
//     and a throwaway staff member with "Add money entries" (removed).
// Steadfast is mocked by ./fixtures; no real Storage file is downloaded.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-41-screens';
const NOTE = 'E2E B41';
const STAFF_USERNAME = 'e2e.b41.money';
const ROLE_NAME = 'E2E B41 money role';

let admin: TestSession;

async function adminAt(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 360, height: 800 });
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
async function mockRpc(page: Page, fn: string, reply: unknown | ((args: Record<string, unknown>) => unknown)): Promise<void> {
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const body = typeof reply === 'function' ? (reply as (a: Record<string, unknown>) => unknown)(args) : reply;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
}

/** The ৳1 test expenses (and anything else noted "E2E B41") are deleted. */
async function cleanUp(): Promise<void> {
  const rows = await select<{ id: string; amount: number; transfer_id: string | null }[]>(
    admin.accessToken,
    `money_movements?select=id,amount,transfer_id&note=like.${encodeURIComponent(NOTE)}*`
  );
  const done = new Set<string>();
  for (const r of rows.data ?? []) {
    if (r.transfer_id && done.has(r.transfer_id)) continue;
    if (r.transfer_id) done.add(r.transfer_id);
    await rpc(admin.accessToken, 'money_delete_entry', { p_id: r.id, p_confirm_amount: Math.round(Math.abs(Number(r.amount))) });
  }
  const team = await rpc<{ id: string; username: string }[]>(admin.accessToken, 'admin_team_list');
  for (const member of team.data ?? []) {
    if (member.username === STAFF_USERNAME) await callFunction(admin.accessToken, 'admin-team', { action: 'delete', userId: member.id });
  }
  const roles = await rpc<{ id: string; name: string }[]>(admin.accessToken, 'admin_role_list');
  for (const role of roles.data ?? []) {
    if (role.name === ROLE_NAME) await rpc(admin.accessToken, 'admin_role_delete', { p_id: role.id });
  }
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await cleanUp();
});

test.afterAll(async () => {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await cleanUp();
});

/* ------------------------------------------------------------ database */

test('database: every money rule, in one transaction that is rolled back', async () => {
  test.skip(!supabaseCli(), 'The Supabase command line is not on this computer.');
  test.setTimeout(240_000);
  const script = readFileSync('e2e/sql/batch-41-money.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(script);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? output.slice(0, 400)).not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  const skipped = (results ?? []).some((r) => r.detail === 'skipped');
  if (!skipped) expect((results ?? []).length).toBeGreaterThanOrEqual(60);
  // Nothing of it stayed in the live books.
  const books = await select<{ confirmed_at: string | null }[]>(admin.accessToken, 'money_books?select=confirmed_at');
  if (!skipped) expect(books.data?.[0]?.confirmed_at ?? null).toBeNull();
  const products = await select<unknown[]>(admin.accessToken, 'products?select=id&sku=like.E2E-B41-*');
  expect(products.data).toHaveLength(0);
  const mode = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.inventory_mode');
  expect(mode.data?.[0]?.value).toBe('false');
});

test('permissions: the public and a customer can read nothing about money', async () => {
  const customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  for (const token of [null, customer.accessToken]) {
    for (const table of ['money_movements', 'money_accounts', 'money_books', 'customer_opening_dues', 'stock_write_offs', 'money_ledger']) {
      const res = await select<unknown[]>(token, `${table}?select=*&limit=5`);
      expect(res.data ?? [], `${table} as ${token ? 'customer' : 'public'}`).toHaveLength(0);
    }
    const summary = await rpc(token, 'money_summary', { p_from: '2026-01-01', p_to: '2026-12-31' });
    expect(summary.ok).toBe(false);
    const add = await rpc(token, 'money_add_entry', { p_type: 'expense', p_amount: 1, p_account: '00000000-0000-0000-0000-000000000000', p_date: '2026-10-11' });
    expect(add.ok).toBe(false);
  }
});

/* -------------------------------------------------------------- screens */

test('Add money: an expense in a few taps on a phone (saved, then deleted)', async ({ page }) => {
  test.setTimeout(90_000);
  await adminAt(page, '/admin?tab=money&m=add');
  const form = page.getByTestId('money-add-form');
  await expect(form).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('money-amount')).toBeFocused();
  for (const label of ['Expense', 'Move money', 'Investor', 'Me', 'Not shop money', 'Pay what I owe']) {
    await expect(form.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await page.getByTestId('money-amount').fill('1');
  await page.getByTestId('money-note').fill(`${NOTE} test expense`);
  await shot(page, '01-add-expense.png');
  await page.getByTestId('money-save').click();
  await expect(page.getByText('Saved: Expense ৳1')).toBeVisible({ timeout: 15_000 });
  // Ready for the next one: the amount is empty again and focused.
  await expect(page.getByTestId('money-amount')).toHaveValue('');
  const saved = await select<{ amount: number; type: string }[]>(
    admin.accessToken,
    `money_movements?select=amount,type&note=eq.${encodeURIComponent(`${NOTE} test expense`)}`
  );
  expect(saved.data).toEqual([{ amount: -1, type: 'expense' }]);

  await page.getByTestId('money-kind-transfer').click();
  await expect(page.getByLabel('From account')).toBeVisible();
  await expect(page.getByLabel('To account')).toBeVisible();
  await shot(page, '02-add-move-money.png');
  await page.getByTestId('money-kind-investor').click();
  await expect(page.getByRole('button', { name: 'Profit share paid' })).toBeVisible();
  await shot(page, '03-add-investor.png');
  await cleanUp();
});

function summaryFixture(balanced: boolean) {
  const profit = {
    from: '2026-10-01', to: '2026-10-11', orders: 12, uncosted_orders: 0, sales: 48000, cost: 26000, provisional: 0, delivery: 1800,
    courier: 1450, cost_adjustments: 0, expenses: 6200, write_offs: 350, net_profit: 15800, profit_share: 3000, your_profit: 12800,
    withdrawals: 5000, left_in_business: 7800, owner_money_in: 0, not_shop_money: 0, count_differences: 0,
  };
  const accounts = [
    { account_id: 'a1', name: 'Cash', kind: 'cash', archived: false, balance: 8200 },
    { account_id: 'a2', name: 'bKash', kind: 'bkash', archived: false, balance: 12650 },
    { account_id: 'a3', name: 'Bank', kind: 'bank', archived: false, balance: 64300 },
    { account_id: 'a4', name: 'With Steadfast', kind: 'steadfast', archived: false, balance: 9120 },
  ];
  return {
    profit,
    expenses_by_category: [],
    position: {
      start_date: '2026-10-01', accounts, accounts_total: 85150, with_steadfast: 9120, steadfast_reported: 9120, steadfast_reported_at: null,
      unplaced_payouts: [], to_receive: 14200, previous_balances: 3070, customer_advances: 0, stock_value: 210000, goods_on_open_orders: 0,
      open_orders_value: 0, sold_without_stock: 0, to_give: 60000, to_give_investors: 50000, to_give_suppliers: 10000, to_give_others: 0,
      have: 321540, owe: 60000, net_worth: 261540,
      opening: { accounts: 90000, previous_balances: 3070, stock: 200000, site_orders: 0, payables: 60000, total: 233070 },
      since_start: profit, outside_orders: 0, outside_fees: 0, outside_unmatched: 0, outside: 0,
      expected: balanced ? 261540 : 261660, difference: balanced ? 0 : -120, balanced, first_wrong: balanced ? null : '2026-10-09',
    },
    roi: { average_money: 247305, begin: 233070, end: 261540, percent: 6.4 },
    last_payout_account_id: null,
    confirmed: true,
    inventory_mode: true,
  };
}

test('Money page: every profit line, Money now, "Books balance" (numbers mocked)', async ({ page }) => {
  test.setTimeout(60_000);
  await mockRpc(page, 'money_summary', summaryFixture(true));
  await adminAt(page, '/admin?tab=money');
  await expect(page.getByTestId('money-profit')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('money-your-profit')).toHaveText('৳12,800');
  await expect(page.getByTestId('money-net-profit')).toContainText('৳15,800');
  await expect(page.getByTestId('money-left')).toContainText('৳7,800');
  await expect(page.getByTestId('money-roi')).toContainText('6.4%');
  await expect(page.getByTestId('money-roi')).toContainText('stock at landed cost + Cash + bKash + Bank + With Steadfast + customer dues − To give');
  await expect(page.getByTestId('money-to-receive')).toContainText('৳17,270');
  await expect(page.getByTestId('money-books-balance')).toHaveText('Books balance');
  // One orange button on the page: Add money.
  await expect(page.locator('.adm-btn--primary:visible')).toHaveCount(1);
  await shot(page, '04-money-page-books-balance.png');
});

test('Money page: a red line with the difference and the first day it went wrong (mocked)', async ({ page }) => {
  test.setTimeout(60_000);
  await mockRpc(page, 'money_summary', summaryFixture(false));
  await adminAt(page, '/admin?tab=money');
  await expect(page.getByTestId('money-books-off')).toHaveText('Books are off by −৳120 — first seen 9 Oct 2026', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Show the sums' }).click();
  await expect(page.getByTestId('money-check-sums')).toContainText('Opening net worth');
  await shot(page, '05-money-page-books-off.png');
});

test('Money page (live): before the opening balances it says so, and opens', async ({ page }) => {
  test.setTimeout(60_000);
  await adminAt(page, '/admin?tab=money');
  await expect(page.getByTestId('money-profit')).toBeVisible({ timeout: 20_000 });
  const books = await select<{ confirmed_at: string | null }[]>(admin.accessToken, 'money_books?select=confirmed_at');
  if (!books.data?.[0]?.confirmed_at) await expect(page.getByTestId('money-not-started')).toBeVisible();
  await expect(page.getByTestId('money-check')).toBeVisible();
});

test('Opening balances: a 3-row Kaarbar file is previewed, nothing is saved', async ({ page }) => {
  test.setTimeout(90_000);
  await adminAt(page, '/admin?tab=money&m=opening');
  await expect(page.getByTestId('opening-dues')).toBeVisible({ timeout: 20_000 });
  const before = await select<unknown[]>(admin.accessToken, 'customer_opening_dues?select=id');
  const file = await writeExcelFile([
    [
      { value: 'phone', fontWeight: 'bold' },
      { value: 'name', fontWeight: 'bold' },
      { value: 'due_amount', fontWeight: 'bold' },
    ],
    [{ value: '+880 1799-941051', type: String }, { value: 'E2E B41 Preview One', type: String }, { value: 1500, type: Number }],
    [{ value: '1799941052', type: String }, { value: 'E2E B41 Preview Two', type: String }, { value: 2000, type: Number }],
    [{ value: '12345', type: String }, { value: 'Bad phone', type: String }, { value: 100, type: Number }],
  ]).toBuffer();
  await page.getByTestId('opening-file').setInputFiles({
    name: 'opening-dues-test.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: file,
  });
  await expect(page.getByTestId('opening-preview')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('opening-file-total')).toHaveText('৳3,500');
  await expect(page.getByTestId('opening-problems')).toContainText('Phone number not valid');
  await expect(page.getByTestId('opening-new')).toContainText('01799941051');
  await expect(page.getByTestId('opening-new')).toContainText('01799941052');
  await shot(page, '06-opening-preview.png');
  // Nothing saved: no dues, books not confirmed.
  const after = await select<unknown[]>(admin.accessToken, 'customer_opening_dues?select=id');
  expect(after.data?.length).toBe(before.data?.length);
});

const FAKE_KEY = 'ph:01799941061';
const FAKE_ORDER = '6c2f2b8e-2f0c-4d8d-9b1a-41e2e41e2e41';

function fakeCustomer(due: number) {
  return {
    customer_key: FAKE_KEY, profile_id: null, full_name: 'E2E B41 Rahima', email: '', phone: '01799941061', order_count: 2,
    total_spent: 5200, total_due: due, last_order_at: '2026-10-09T08:00:00Z', joined_at: null, all_orders: 2, hidden: false,
    note: null, alt_phone: null, added_by_hand: false, added_at: null,
  };
}

async function mockCustomer(page: Page, orderDue: number, previous: number, reminders: { at: string; amount: number; how: string; by: string }[]): Promise<{ recorded: Record<string, unknown>[] }> {
  const recorded: Record<string, unknown>[] = [];
  await mockRpc(page, 'admin_customers_v3', [fakeCustomer(orderDue)]);
  await mockRpc(page, 'admin_customer_orders_v2', []);
  await mockRpc(page, 'money_customer_dues', [
    {
      customer_key: FAKE_KEY, phone_key: '01799941061', order_due: orderDue, previous_left: previous,
      latest_unpaid_order_id: orderDue > 0 ? FAKE_ORDER : null, latest_unpaid_order_number: orderDue > 0 ? 'NM-9041' : null,
      last_reminder_at: null, last_reminder_amount: null, reminders: reminders.length,
    },
  ]);
  await mockRpc(page, 'money_customer_history', () => ({
    phone_key: '01799941061',
    previous: previous > 0 ? [{ id: 'd1', amount: previous, at: '2026-10-01T00:00:00Z', choice: 'kaarbar', kaarbar_amount: previous, site_due_then: 0 }] : [],
    previous_left: previous,
    payments: [],
    reminders: recorded.length > 0 ? [{ at: '2026-10-11T06:00:00Z', amount: orderDue + previous, how: 'whatsapp', by: 'naeem' }, ...reminders] : reminders,
  }));
  await mockRpc(page, 'money_record_reminder', (args) => {
    recorded.push(args);
    return 'r1';
  });
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  return { recorded };
}

test('Customer: due + previous balance, "Send due reminder" opens WhatsApp with our own link, the history line is written', async ({ page }) => {
  test.setTimeout(60_000);
  const { recorded } = await mockCustomer(page, 2070, 1000, []);
  await adminAt(page, `/admin/customers/${encodeURIComponent(FAKE_KEY)}`);
  const card = page.getByTestId('customer-due-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('customer-previous-balance')).toHaveText('৳1,000');
  await expect(page.getByTestId('customer-total-due')).toHaveText('৳3,070');
  const origin = new URL(page.url()).origin;
  await expect(page.getByTestId('customer-reminder-text')).toContainText('You have Tk. 3,070 left to pay as on');
  await expect(page.getByTestId('customer-reminder-text')).toContainText(`View your orders: ${origin}/orders/${FAKE_ORDER}`);
  await shot(page, '07-customer-due-reminder.png');
  await page.getByTestId('customer-send-reminder').click();
  await expect.poll(() => recorded.length).toBe(1);
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/^https:\/\/wa\.me\/8801799941061\?text=/);
  const text = decodeURIComponent(opened[0].split('?text=')[1]);
  expect(text.startsWith('Hello E2E B41 Rahima,\nYou have Tk. 3,070 left to pay as on ')).toBe(true);
  expect(text).toContain(`${origin}/orders/${FAKE_ORDER}`);
  expect(recorded[0]).toMatchObject({ p_customer_key: FAKE_KEY, p_amount: 3070, p_order_id: FAKE_ORDER, p_how: 'whatsapp' });
  await expect(page.getByTestId('customer-reminders')).toContainText('Due reminder sent, ৳3,070, 11 Oct 2026');
});

test('Customer: only a previous balance → the message has no "View your orders" line', async ({ page }) => {
  test.setTimeout(60_000);
  await mockCustomer(page, 0, 1000, []);
  await adminAt(page, `/admin/customers/${encodeURIComponent(FAKE_KEY)}`);
  await expect(page.getByTestId('customer-reminder-text')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('customer-reminder-text')).toContainText('Tk. 1,000');
  await expect(page.getByTestId('customer-reminder-text')).not.toContainText('View your orders');
});

test('Customers: "To receive" — largest due first, the total at the top', async ({ page }) => {
  test.setTimeout(60_000);
  const rows = [
    { ...fakeCustomer(500), customer_key: 'ph:01799941071', full_name: 'E2E B41 Small', phone: '01799941071' },
    { ...fakeCustomer(0), customer_key: 'ph:01799941072', full_name: 'E2E B41 Previous only', phone: '01799941072' },
    { ...fakeCustomer(2500), customer_key: 'ph:01799941073', full_name: 'E2E B41 Big', phone: '01799941073' },
  ];
  await mockRpc(page, 'admin_customers_v3', rows);
  await mockRpc(page, 'money_customer_dues', [
    { customer_key: 'ph:01799941072', phone_key: '01799941072', order_due: 0, previous_left: 1200, latest_unpaid_order_id: null, latest_unpaid_order_number: null, last_reminder_at: null, last_reminder_amount: null, reminders: 0 },
  ]);
  await adminAt(page, '/admin?tab=customers&cshow=due');
  await expect(page.getByTestId('customers-to-receive-total')).toContainText('৳4,200', { timeout: 20_000 });
  const names = await page.locator('.adm-orow2__name').allInnerTexts();
  expect(names.map((n) => n.trim()).slice(0, 3)).toEqual(['E2E B41 Big', 'E2E B41 Previous only', 'E2E B41 Small']);
  await shot(page, '08-customers-to-receive.png');
});

test('Settings: the due reminder message can be changed (with a live example)', async ({ page }) => {
  test.setTimeout(60_000);
  await adminAt(page, '/admin?tab=settings&sset=due-reminder');
  await expect(page.getByTestId('due-reminder-template')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.money-message')).toContainText('Hello Rahima,');
  await shot(page, '09-settings-due-reminder.png');
});

test('Lot form: "Paid for this lot" rows (account + amount + date)', async ({ page }) => {
  test.setTimeout(60_000);
  await adminAt(page, '/admin?tab=inventory&inv=new');
  const paid = page.getByTestId('inv-lot-paid');
  await expect(paid).toBeVisible({ timeout: 20_000 });
  await paid.getByTestId('lot-pay-add').click();
  await expect(paid.getByLabel('Paid from account')).toBeVisible();
  await paid.getByLabel('Amount paid').fill('2000');
  await shot(page, '10-lot-paid-for-this-lot.png');
});

test('Remove stock: while Inventory mode is Off it explains why', async ({ page }) => {
  test.setTimeout(60_000);
  const product = await select<{ id: string }[]>(admin.accessToken, 'products?select=id&is_active=eq.true&limit=1');
  await adminAt(page, `/admin/products/${product.data?.[0]?.id}/edit`);
  await expect(page.getByTestId('remove-stock-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('remove-stock-off')).toContainText('Works only while Inventory mode is On');
  await page.getByTestId('remove-stock-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/11-remove-stock-mode-off.png` });
});

test('Mark returned: each item gets "Damaged — do not put back in stock" (Inventory mode shown as On, nothing confirmed)', async ({ page }) => {
  test.setTimeout(90_000);
  const order = await select<{ order_number: string }[]>(admin.accessToken, 'orders?select=order_number&status=eq.delivered&order=created_at.desc&limit=1');
  test.skip(!order.data?.length, 'No delivered order to open.');
  // Only the browser is told Inventory mode is On; the live switch stays Off.
  await page.route(/\/rest\/v1\/app_settings\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const rows = (await response.json()) as { key: string; value: string }[];
    await route.fulfill({ response, json: rows.map((r) => (r.key === 'inventory_mode' ? { ...r, value: 'true' } : r)) });
  });
  await adminAt(page, `/admin/orders/${encodeURIComponent(order.data![0].order_number)}`);
  await page.getByTestId('careful-return').click({ timeout: 30_000 });
  await expect(page.getByTestId('return-damaged')).toBeVisible();
  await page.getByTestId('return-damaged-tick').first().check();
  await shot(page, '12-mark-returned-damaged.png');
  // Not confirmed: the confirm button stays off until the order number is typed.
  await expect(page.getByTestId('confirm-sheet-confirm')).toBeDisabled();
});

test('"Add money entries" only: the Add money form (Expense, Move money), no profit anywhere — also in the database', async ({ page }) => {
  test.setTimeout(120_000);
  const role = await rpc<string>(admin.accessToken, 'admin_role_save', { p_id: null, p_name: ROLE_NAME, p_permissions: ['add_money_entries'] });
  expect(role.ok, role.error ?? '').toBe(true);
  const created = await callFunction<{ ok: boolean; userId?: string; error?: string }>(admin.accessToken, 'admin-team', {
    action: 'create',
    username: STAFF_USERNAME,
    fullName: 'E2E Batch41 Money',
    phone: '01700000041',
    password: E2E_MOD_PASSWORD,
  });
  expect(created.ok, created.error).toBe(true);
  const set = await rpc(admin.accessToken, 'admin_team_set_role', { p_user_id: created.userId, p_role_id: role.data });
  expect(set.ok, set.error ?? '').toBe(true);
  const staff = await passwordSession(`${STAFF_USERNAME}@staff.naeems.internal`, E2E_MOD_PASSWORD);

  // Database: can add an expense, can't read profit, balances or lists.
  const accounts = await select<{ id: string; kind: string }[]>(staff.accessToken, 'money_accounts?select=id,kind');
  expect((accounts.data ?? []).length).toBeGreaterThanOrEqual(4);
  const cash = (accounts.data ?? []).find((a) => a.kind === 'cash')!;
  const cats = await select<{ id: string }[]>(staff.accessToken, 'money_categories?select=id&limit=1');
  const today = new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
  const add = await rpc(staff.accessToken, 'money_add_entry', {
    p_type: 'expense', p_amount: 1, p_account: cash.id, p_date: today, p_note: `${NOTE} staff expense`, p_category: cats.data?.[0]?.id,
  });
  expect(add.ok, add.error ?? '').toBe(true);
  const summary = await rpc(staff.accessToken, 'money_summary', { p_from: today, p_to: today });
  expect(summary.ok).toBe(false);
  const balances = await rpc(staff.accessToken, 'money_account_balances');
  expect(balances.ok).toBe(false);
  for (const table of ['money_movements', 'money_ledger', 'money_books', 'stock_write_offs', 'parties_payable']) {
    const res = await select<unknown[]>(staff.accessToken, `${table}?select=*&limit=5`);
    expect(res.data ?? [], table).toHaveLength(0);
  }
  const withdraw = await rpc(staff.accessToken, 'money_add_entry', { p_type: 'owner_withdrawal', p_amount: 1, p_account: cash.id, p_date: today });
  expect(withdraw.ok).toBe(false);

  // Screen: Money opens the Add money form only.
  await page.setViewportSize({ width: 360, height: 800 });
  await useSessionInPage(page, staff);
  await page.goto('/admin?tab=money');
  await expect(page.getByTestId('money-add-form')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('money-kind-expense')).toBeVisible();
  await expect(page.getByTestId('money-kind-transfer')).toBeVisible();
  await expect(page.getByTestId('money-kind-investor')).toHaveCount(0);
  await expect(page.getByTestId('money-kind-me')).toHaveCount(0);
  await expect(page.getByTestId('money-profit')).toHaveCount(0);
  await shot(page, '13-staff-add-money-only.png');
  await cleanUp();
});

test('Customer: My Orders shows one line "Previous balance" and nothing behind it (mocked)', async ({ page }) => {
  test.setTimeout(60_000);
  const customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  await mockRpc(page, 'customer_previous_balance', 1000);
  await page.setViewportSize({ width: 360, height: 800 });
  await useSessionInPage(page, customer);
  await page.goto('/orders');
  await expect(page.getByTestId('previous-balance')).toContainText('Previous balance', { timeout: 20_000 });
  await expect(page.getByTestId('previous-balance')).toContainText('1,000');
  await shot(page, '14-customer-previous-balance.png');
});

/* ---------------------------------------------------- bill photos (Part 2.3) */

test.describe('bill photos: the shop\'s own code, in the browser', () => {
  let dev: { url: string; close: () => Promise<void> };
  test.beforeAll(async () => {
    dev = await startDevServer();
  });
  test.afterAll(async () => {
    await dev?.close();
  });

  test('a big phone photo of a bill becomes WebP under 150 KB', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${dev.url}offline.html`);
    const size = await page.evaluate(async () => (await import('/e2e/harness/money.ts')).billSize());
    expect(size.original).toBeGreaterThan(1024 * 1024);
    expect(size.type).toBe('image/webp');
    expect(size.small).toBeLessThanOrEqual(150 * 1024);
    expect(size.width).toBeLessThanOrEqual(1200);
  });

  test('each bill gets a new name and the one-year cache (Storage answered by the test)', async ({ page }) => {
    test.setTimeout(60_000);
    const uploads: { path: string; body: string }[] = [];
    await page.route(/\/storage\/v1\/object\/money-bills\//, async (route: Route) => {
      const request = route.request();
      if (request.method() !== 'POST' && request.method() !== 'PUT') return route.fallback();
      uploads.push({ path: new URL(request.url()).pathname, body: request.postDataBuffer()?.toString('latin1') ?? '' });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ Key: 'mock', Id: 'mock' }) });
    });
    await page.goto(`${dev.url}offline.html`);
    const paths = await page.evaluate(async () => (await import('/e2e/harness/money.ts')).billUploadTwice());
    expect(paths[0]).toMatch(/^bills\/2026-10\/[\w-]+\.webp$/);
    expect(paths[1]).not.toBe(paths[0]);
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.body).toContain('31536000');
    }
  });
});
