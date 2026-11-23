import { mkdirSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './helpers/env';
import { passwordSession, select, useSessionInPage, type TestSession } from './helpers/api';

// Batch 58: the three screen changes of the accounts fix, at phone width
// (390 px), with the database answers mocked in the browser so the screens
// show known numbers. Nothing is saved for real: "Record payment" is
// answered in the browser too. The money rules themselves are tested in
// e2e/sql/audit/batch-57-month.sql (rolled back).
// Steadfast is mocked by ./fixtures; no real Storage file is downloaded.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the admin test account in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-58-screens';

let admin: TestSession;

test.beforeAll(async () => {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  mkdirSync(SHOTS, { recursive: true });
});

async function adminAt(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto(path);
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
}

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) };
}

/** Answers one database function in the browser with a fixed reply. */
async function mockRpc(page: Page, fn: string, reply: unknown | ((args: Record<string, unknown>) => unknown)): Promise<Record<string, unknown>[]> {
  const calls: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push(args);
    const body = typeof reply === 'function' ? (reply as (a: Record<string, unknown>) => unknown)(args) : reply;
    await route.fulfill(json(body));
  });
  return calls;
}

/* ---------------------------------------------------- 1. Home → Money now */

const PROFIT = {
  from: '2026-11-13', to: '2026-11-23', orders: 12, uncosted_orders: 0, items_missing_cost: 0, sales: 48000, cost: 26000, provisional: 0,
  delivery: 1800, courier: 1450, cost_adjustments: 0, locked_adjustments: 0, expenses: 6200, write_offs: 350, net_profit: 15800,
  profit_share: 3000, your_profit: 12800, withdrawals: 5000, left_in_business: 7800, owner_money_in: 0, not_shop_money: 0, count_differences: 0,
};

function dashboardFixture() {
  const accounts = [
    { account_id: 'a1', name: 'Cash', kind: 'cash', archived: false, balance: 13084 },
    { account_id: 'a2', name: 'bKash', kind: 'bkash', archived: false, balance: 27600 },
    { account_id: 'a3', name: 'Bank', kind: 'bank', archived: false, balance: 13300 },
    { account_id: 'a4', name: 'With Steadfast', kind: 'steadfast', archived: false, balance: 164 },
  ];
  return {
    summary: {
      profit: PROFIT,
      expenses_by_category: [],
      position: {
        start_date: '2026-11-13', accounts, accounts_total: 53984, with_steadfast: 164, steadfast_reported: 0, steadfast_reported_at: null,
        unplaced_payouts: [], to_receive: 35973, previous_balances: 18640, customer_advances: 0, stock_value: 113799, goods_on_open_orders: 10680,
        open_orders_value: 25116, sold_without_stock: 0, to_give: 251259, to_give_investors: 222260, to_give_suppliers: 28736, to_give_others: 0,
        to_give_courier: 263, have: 233240, owe: 276375, net_worth: -43135,
        opening: { accounts: 46400, previous_balances: 19440, stock: 110358, site_orders: 9437, payables: 222260, total: -36625 },
        since_start: PROFIT, outside_orders: 0, outside_fees: 0, outside_unmatched: 0, outside: 0,
        expected: -43135, difference: 0, balanced: true, first_wrong: null,
      },
      roi: { average_money: null, begin: null, end: null, percent: null },
      last_payout_account_id: null,
      confirmed: true,
      inventory_mode: true,
    },
    previous: { from: '2026-10-13', to: '2026-10-23', your_profit: 10000, net_profit: 12000 },
    attention: {
      expiring: 0, sold_without_stock: 0, dues_over_30: 0, dues_over_30_amount: 0, no_buy_price: 0, no_weight: 0,
      count_planned: 0, count_done: 0, count_due: false, last_month_locked: false, last_month: '2026-10-01',
    },
  };
}

test('Home → Money now: To give without the investors, "Investors\' money" on its own line, "All figures match"', async ({ page }) => {
  test.setTimeout(60_000);
  await mockRpc(page, 'money_dashboard', dashboardFixture());
  await adminAt(page, '/admin');
  const card = page.getByTestId('dash-money');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('dash-balance-ok')).toHaveText('All figures match');
  // ৳2,51,259 − ৳2,22,260 = ৳28,999 (suppliers + courier not paid yet).
  await expect(page.getByTestId('dash-give')).toHaveText('৳28,999');
  await expect(page.getByTestId('dash-investors')).toHaveText('৳2,22,260');
  await expect(card).toContainText('Money your investors have put in. Shown apart from what you owe.');
  await expect(card.locator('.dash-divider')).toHaveCount(1);
  // The investors' line comes after Stock value.
  const stock = await page.getByTestId('dash-stock').boundingBox();
  const investors = await page.getByTestId('dash-investors').boundingBox();
  expect((investors?.y ?? 0) > (stock?.y ?? 0)).toBe(true);
  // No new orange: the card has no primary button.
  await expect(card.locator('.adm-btn--primary')).toHaveCount(0);
  await noSideScroll(page);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${SHOTS}/01-home-money-now-390.png` });
});

test('Home → Money now: a mismatch reads "Mismatch −৳X"; no investors means no extra line', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = dashboardFixture();
  Object.assign(fixture.summary.position, { balanced: false, difference: -120, to_give: 28999, to_give_investors: 0 });
  await mockRpc(page, 'money_dashboard', fixture);
  await adminAt(page, '/admin');
  await expect(page.getByTestId('dash-balance-off')).toHaveText('Mismatch −৳120', { timeout: 20_000 });
  await expect(page.getByTestId('dash-give')).toHaveText('৳28,999');
  await expect(page.getByTestId('dash-investors')).toHaveCount(0);
});

/* ------------------------------------------------- 2. Customer → credit */

const FAKE_KEY = 'ph:01799958061';

async function mockCustomer(page: Page, credit: number): Promise<void> {
  await mockRpc(page, 'admin_customers_v3', [
    {
      customer_key: FAKE_KEY, profile_id: null, full_name: 'E2E B58 Karima', email: '', phone: '01799958061', order_count: 1,
      total_spent: 1200, total_due: 0, last_order_at: '2026-11-20T08:00:00Z', joined_at: null, all_orders: 1, hidden: false,
      note: null, alt_phone: null, added_by_hand: false, added_at: null,
    },
  ]);
  await mockRpc(page, 'admin_customer_orders_v2', []);
  await mockRpc(page, 'money_customer_dues', [
    {
      customer_key: FAKE_KEY, phone_key: '01799958061', order_due: 0, previous_left: 0, latest_unpaid_order_id: null,
      latest_unpaid_order_number: null, last_reminder_at: null, last_reminder_amount: null, reminders: 0, credit,
    },
  ]);
  await mockRpc(page, 'money_customer_history', {
    phone_key: '01799958061', previous: [], previous_left: 0, corrections: [], payments: [], reminders: [],
  });
}

// Batch 60 (changed on purpose): money paid above an order now goes into the
// customer's wallet (the WALLET card above TO RECEIVE), so Batch 58's
// separate "Credit" line is gone even when the database still sends credit.
test('Customer page → To receive: no separate "Credit" line any more (Batch 60: it is the wallet)', async ({ page }) => {
  test.setTimeout(60_000);
  await mockCustomer(page, 200);
  await adminAt(page, `/admin/customers/${encodeURIComponent(FAKE_KEY)}`);
  const card = page.getByTestId('customer-due-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('customer-total-due')).toHaveText('৳0');
  await expect(page.getByTestId('customer-credit')).toHaveCount(0);
  await expect(card).not.toContainText('paid more than owed');
  await noSideScroll(page);
});

test('Customer page: no credit line when nothing was paid too much', async ({ page }) => {
  test.setTimeout(60_000);
  await mockCustomer(page, 0);
  await adminAt(page, `/admin/customers/${encodeURIComponent(FAKE_KEY)}`);
  await expect(page.getByTestId('customer-due-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('customer-credit')).toHaveCount(0);
});

/* ------------------------------- 3. Order → Steadfast bill paid outside */

test('Order page: a Steadfast bill paid outside the payout — "Record payment" sheet, then "paid from …"', async ({ page }) => {
  test.setTimeout(90_000);
  const recent = await select<{ id: string; order_number: string }[]>(
    admin.accessToken,
    'orders?select=id,order_number&status=eq.delivered&steadfast_consignment_id=not.is.null&order=created_at.desc&limit=1',
  );
  const order = recent.data?.[0];
  test.skip(!order, 'No delivered order to open.');
  await page.route(/\/rest\/v1\/order_courier_costs\?/, (route) =>
    route.fulfill(
      json({ net_received: 0, total_kept: 65, bill_paid_separately: 65, paid_at: '2026-11-18T20:36:37Z', payout_id: 'p-b58', steadfast_payouts: { steadfast_payment_id: 'SFC-B58' } }),
    ),
  );
  let recorded = false;
  await mockRpc(page, 'money_courier_bill_status', () =>
    recorded
      ? { bill: 65, counts: true, recorded: 65, owed: 0, payments: [{ id: 'mv-b58', account: 'bKash', date: '2026-11-21', amount: 65 }] }
      : { bill: 65, counts: true, recorded: 0, owed: 65, payments: [] },
  );
  const saves = await mockRpc(page, 'money_record_courier_bill', () => {
    recorded = true;
    return 'mv-b58';
  });

  await adminAt(page, `/admin/orders/${order?.order_number ?? ''}`);
  const paid = page.getByTestId('order-steadfast-paid');
  await expect(paid).toBeVisible({ timeout: 20_000 });
  await expect(paid).toContainText('delivery bill ৳65 paid outside this payout');
  const owed = page.getByTestId('order-bill-owed');
  await expect(owed).toContainText('Not taken from any account yet');
  await paid.scrollIntoViewIfNeeded();
  await noSideScroll(page);
  await paid.screenshot({ path: `${SHOTS}/03-order-bill-owed-390.png` });

  await page.getByTestId('order-bill-record').click();
  const sheet = page.getByTestId('order-bill-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Steadfast bill paid outside the payout' })).toBeVisible();
  await expect(page.getByTestId('order-bill-amount')).toHaveValue('৳65');
  await expect(page.getByTestId('order-bill-amount')).toHaveAttribute('readonly', '');
  const options = await page.getByTestId('order-bill-account').locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(0);
  expect(options).not.toContain('With Steadfast');
  // The sheet's one orange element is Save.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/04-order-bill-sheet-390.png` });

  await page.getByTestId('order-bill-save').click();
  await expect(page.getByText('Bill payment recorded')).toBeVisible();
  expect(saves[0]).toMatchObject({ p_order_id: order?.id });
  expect(typeof saves[0].p_account).toBe('string');
  expect(saves[0].p_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByTestId('order-bill-owed')).toHaveCount(0);
  await expect(page.getByTestId('order-bill-paid')).toHaveText(' · paid from bKash on 21 Nov');
  await paid.scrollIntoViewIfNeeded();
  await paid.screenshot({ path: `${SHOTS}/05-order-bill-paid-390.png` });
});
