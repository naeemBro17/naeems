import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_MOD_PASSWORD, E2E_PASSWORD } from './helpers/env';
import {
  callFunction,
  passwordSession,
  pickStockedProduct,
  placeTestOrder,
  rpc,
  select,
  useSessionInPage,
  type TestSession,
} from './helpers/api';
import { mockSteadfast } from './helpers/steadfastMock';

// Batch 32 (reports/batch-32.txt). Steadfast is always mocked (e2e/
// fixtures.ts) — no parcel is ever booked; "booked" / "delivered" below are
// database calls with made-up consignment ids. Test orders, the test
// customer added by hand, the test staff login and its role are created
// here and deleted in afterAll. The parts that need the Batch 32 database
// update (migration-035) are skipped with that reason until it is run.

test.skip(
  !E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_MOD_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD,
  'Needs the test accounts in .env.e2e.'
);
test.describe.configure({ mode: 'serial' });

const NEEDS_035 = 'Needs migration-035 (Batch 32 database update) — not applied yet.';
const STAFF_USERNAME = 'e2e.role32';
const ROLE_NAME = 'E2E Batch32 role';
const PAY_LATER_PHONE = '01799990032';
const ADDED_PHONE = '01799990034';
const ADDED_NAME = 'E2E B32 Added Customer';

let admin: TestSession;
let customer: TestSession;
let product: { id: string; name: string; stock: number };
let ready = false;
let staffId = '';
let roleId = '';
let payLaterOrderId = '';
const createdOrderIds: string[] = [];

const taka = (n: number) => `৳ ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const takaBd = (n: number) => `৳${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

async function freshAdmin(): Promise<TestSession> {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  return admin;
}

async function orderRow(orderId: string): Promise<Record<string, unknown>> {
  const res = await select<Record<string, unknown>[]>(admin.accessToken, `orders?select=*&id=eq.${orderId}`);
  return res.data![0];
}

async function historyNotes(orderId: string): Promise<string[]> {
  const res = await select<{ note: string | null }[]>(admin.accessToken, `order_history_private?select=note&order_id=eq.${orderId}`);
  return (res.data ?? []).map((r) => r.note ?? '');
}

async function pickDhakaDhaka(page: Page, prefix: string): Promise<void> {
  await page.locator(`#${prefix}-division`).click();
  await page.getByPlaceholder('Search division...').fill('Dhaka');
  await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
  await page.locator(`#${prefix}-district`).click();
  await page.getByPlaceholder('Search district...').fill('Dhaka');
  await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
}

async function addItem(page: Page): Promise<void> {
  await page.getByPlaceholder('Search product name...').fill(product.name.slice(0, 18));
  await page.locator('.picker-sheet__row').filter({ hasText: product.name }).first().click();
}

async function deleteStaffAndRole(): Promise<void> {
  const team = await rpc<{ id: string; username: string }[]>(admin.accessToken, 'admin_team_list');
  for (const member of team.data ?? []) {
    if (member.username === STAFF_USERNAME) await callFunction(admin.accessToken, 'admin-team', { action: 'delete', userId: member.id });
  }
  const roles = await rpc<{ id: string; name: string }[]>(admin.accessToken, 'admin_role_list');
  for (const role of roles.data ?? []) {
    if (role.name === ROLE_NAME) await rpc(admin.accessToken, 'admin_role_delete', { p_id: role.id });
  }
}

/** A test staff login whose role has exactly these switches. */
async function staffWith(permissions: string[]): Promise<TestSession> {
  const role = await rpc<string>(admin.accessToken, 'admin_role_save', { p_id: roleId || null, p_name: ROLE_NAME, p_permissions: permissions });
  expect(role.ok, role.error ?? '').toBe(true);
  roleId = role.data!;
  if (!staffId) {
    const created = await callFunction<{ ok: boolean; userId?: string; error?: string }>(admin.accessToken, 'admin-team', {
      action: 'create',
      username: STAFF_USERNAME,
      fullName: 'E2E Batch32 Staff',
      phone: '01700000032',
      password: E2E_MOD_PASSWORD,
    });
    expect(created.ok, created.error).toBe(true);
    staffId = created.userId!;
    const set = await rpc(admin.accessToken, 'admin_team_set_role', { p_user_id: staffId, p_role_id: roleId });
    expect(set.ok, set.error ?? '').toBe(true);
  }
  return passwordSession(`${STAFF_USERNAME}@staff.naeems.internal`, E2E_MOD_PASSWORD);
}

async function removeAddedCustomer(): Promise<void> {
  if (!ready) return;
  await rpc(admin.accessToken, 'admin_delete_customer', { p_customer_key: `ph:${ADDED_PHONE}` });
  // A hide / unhide row for the pay-later test customer (flags only).
  await rpc(admin.accessToken, 'admin_set_customer_hidden', { p_customer_key: `ph:${PAY_LATER_PHONE}`, p_hidden: false });
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  await freshAdmin();
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(8);
  // collect_mode answers 400 (no such column) until migration-035 is run.
  const probe = await select<unknown[]>(admin.accessToken, 'orders?select=collect_mode&limit=1');
  ready = probe.ok;
  if (ready) {
    await deleteStaffAndRole();
    await removeAddedCustomer();
  }
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await freshAdmin();
  if (createdOrderIds.length > 0) {
    await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
    await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: createdOrderIds });
    await rpc(admin.accessToken, 'admin_close_delete_lock');
  }
  if (ready) {
    await deleteStaffAndRole();
    await removeAddedCustomer();
  }
});

/* ---------------------------------------------------------------- Part 1 */

test('Part 1: payment section — summary, Full amount, method chips, inline error when paid > total', async ({ page }) => {
  test.setTimeout(60_000);
  await useSessionInPage(page, admin);
  await page.goto('/admin/orders/new');
  await expect(page.getByTestId('new-order-page')).toBeVisible({ timeout: 20_000 });
  // The old four payment chips are gone.
  for (const old of ['Cash on Delivery', 'Cash paid', 'Due (pay later)']) {
    await expect(page.getByRole('button', { name: old, exact: true })).toHaveCount(0);
  }
  await addItem(page);
  const section = page.getByTestId('payment-section');
  const summary = page.getByTestId('payment-summary');
  const totalText = await page.locator('.checkout-summary-card__row--total span').last().innerText();
  const total = Number(totalText.replace(/[^0-9.]/g, ''));
  expect(total).toBeGreaterThan(0);

  // Nothing paid: the courier collects everything.
  await expect(summary.getByTestId('summary-paid-now')).toHaveText(taka(0));
  await expect(summary.getByTestId('summary-courier')).toHaveText(taka(total));
  await expect(summary.getByTestId('summary-due')).toHaveText(taka(0));
  await expect(section.getByRole('button', { name: 'bKash' })).toHaveCount(0);

  // More than the total: inline error, Create order stays off.
  await page.getByTestId('paid-now-input').fill(String(total + 1));
  await expect(page.getByTestId('paid-now-error')).toHaveText(`Paid now can be at most ${taka(total)}.`);
  await expect(page.getByRole('button', { name: 'Create order' })).toBeDisabled();

  // An advance: method chips, summary follows, remaining with two choices.
  await page.getByTestId('paid-now-input').fill('100');
  await expect(page.getByTestId('paid-now-error')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'bKash' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Nagad' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Bank' })).toBeVisible();
  await expect(summary.getByTestId('summary-paid-now')).toHaveText(taka(100));
  await expect(summary.getByTestId('summary-courier')).toHaveText(taka(total - 100));
  await expect(section.getByText(`Remaining ${taka(total - 100)}`)).toBeVisible();
  await expect(section.getByRole('radio', { name: 'Collect on delivery' })).toHaveAttribute('aria-checked', 'true');

  // Full amount: nothing remains, the courier collects ৳0.
  await section.getByRole('button', { name: 'Full amount' }).click();
  await expect(page.getByTestId('paid-now-input')).toHaveValue(String(total));
  await expect(summary.getByTestId('summary-courier')).toHaveText(taka(0));
  await expect(section.getByRole('radiogroup')).toHaveCount(0);

  await page.getByTestId('paid-now-input').fill('100');
  if (ready) {
    await section.getByRole('radio', { name: 'Customer pays later' }).click();
    await expect(summary.getByTestId('summary-courier')).toHaveText(taka(0));
    await expect(summary.getByTestId('summary-due')).toHaveText(taka(total - 100));
  } else {
    await expect(page.getByTestId('pay-later-unavailable')).toBeVisible();
  }
});

test('Part 1: pay later + bKash advance — one step, a real payment row, ৳0 to the courier, list tag', async ({ page }) => {
  test.skip(!ready, NEEDS_035);
  test.setTimeout(120_000);
  await mockSteadfast(page, { policeStations: null });
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/new$/);
  const form = page.getByTestId('new-order-page');
  await form.getByRole('button', { name: 'Phone call', exact: true }).click();
  await page.locator('#manual-order-name').fill('E2E B32 Pay Later');
  await page.locator('#manual-order-phone').fill(PAY_LATER_PHONE);
  await pickDhakaDhaka(page, 'manual-order');
  await page.locator('#manual-order-address').fill('House 32, Road 2 (e2e)');
  await addItem(page);
  await page.getByTestId('paid-now-input').fill('100');
  await form.getByRole('button', { name: 'bKash' }).click();
  await page.getByLabel('TrxID (optional)').fill('E2EB32TRX');
  await form.getByRole('radio', { name: 'Customer pays later' }).click();
  await form.getByRole('button', { name: 'Create order' }).click();
  await expect(page.getByText(/Order .* saved/)).toBeVisible({ timeout: 15_000 });
  // Lands on the new order's own page (Batch 35: /admin/orders/NM-…).
  await expect(page).toHaveURL(/\/admin\/orders\/[^/]+$/, { timeout: 15_000 });
  const newNumber = decodeURIComponent(new URL(page.url()).pathname.split('/admin/orders/')[1]);
  const found = await select<{ id: string }[]>(admin.accessToken, `orders?select=id&order_number=eq.${encodeURIComponent(newNumber)}`);
  payLaterOrderId = found.data![0].id;
  createdOrderIds.push(payLaterOrderId);

  const row = await orderRow(payLaterOrderId);
  expect(row.collect_mode).toBe('pay_later');
  expect(row.payment_method).toBe('due');
  const total = Number(row.total);
  const pays = await select<{ amount: number; method: string; trx_id: string; created_by_username: string; source: string }[]>(
    admin.accessToken,
    `order_payments?select=amount,method,trx_id,created_by_username,source&order_id=eq.${payLaterOrderId}`
  );
  expect(pays.data).toEqual([{ amount: 100, method: 'bkash', trx_id: 'E2EB32TRX', created_by_username: 'e2e.admin', source: 'manual' }]);
  expect((await historyNotes(payLaterOrderId)).some((n) => n.startsWith('Customer pays later'))).toBe(true);

  // The booking confirmation says the courier collects ৳0.
  const dialog = page.getByTestId('admin-order-page');
  await expect(dialog.getByTestId('payment-collect-mode')).toHaveText(`Customer pays later · courier collects ${taka(0)}`, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Book with Steadfast' }).click();
  const confirm = page.getByRole('dialog', { name: 'Book with Steadfast?' });
  await expect(confirm).toContainText(`COD amount: ${taka(0)}`);
  await expect(confirm).toContainText(`Courier will collect ${taka(0)} — customer pays later`);
  await confirm.getByRole('button', { name: 'Cancel' }).click();

  // The list's money pill (Batch 35: one small pill, only when owed).
  await page.goto('/admin?tab=orders');
  const listRow = page.getByTestId('order-row').filter({ hasText: String(row.order_number) });
  await expect(listRow.getByTestId('order-money-pill')).toHaveText('Due, pays later', { timeout: 15_000 });
  expect(total).toBeGreaterThan(100);
});

test('Part 1: pay-later order delivered by Steadfast records no COD payment and stays due', async ({ page }) => {
  test.skip(!ready || !payLaterOrderId, NEEDS_035);
  test.setTimeout(60_000);
  const booked = await rpc(admin.accessToken, 'admin_record_steadfast_shipment', {
    p_order_id: payLaterOrderId,
    p_consignment_id: `E2E-B32-${Date.now()}`,
    p_tracking_code: 'E2EB32',
    p_tracking_link: '',
    p_courier_status: 'in_review',
  });
  expect(booked.ok, booked.error ?? '').toBe(true);
  await rpc(admin.accessToken, 'admin_set_steadfast_cod', { p_order_id: payLaterOrderId, p_amount: 0 });
  const delivered = await rpc(admin.accessToken, 'admin_update_steadfast_status', {
    p_order_id: payLaterOrderId,
    p_courier_status: 'delivered',
    p_mark_delivered: true,
  });
  expect(delivered.ok, delivered.error ?? '').toBe(true);
  const row = await orderRow(payLaterOrderId);
  expect(row.status).toBe('delivered');
  expect(row.payment_status).toBe('unpaid');
  const cod = await select<unknown[]>(admin.accessToken, `order_payments?select=id&order_id=eq.${payLaterOrderId}&source=eq.steadfast_cod`);
  expect(cod.data ?? []).toHaveLength(0);

  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=orders&ostatus=due');
  await expect(page.getByTestId('order-row').filter({ hasText: String(row.order_number) })).toBeVisible({ timeout: 15_000 });
});

test('Part 1: existing and website orders stay "collect on delivery"; Edit order switches the mode (History + Activity Log)', async ({ page }) => {
  test.skip(!ready, NEEDS_035);
  test.setTimeout(90_000);
  // Batch 33: real orders may now be "pays later" (Naeem uses it), so only
  // the test customer's website orders are checked — none may be anything
  // but 'cod'. The admin-made pay-later test order is the one exception.
  const all = await select<{ id: string }[]>(
    admin.accessToken,
    `orders?select=id&collect_mode=neq.cod&customer_id=eq.${customer.userId}${payLaterOrderId ? `&id=neq.${payLaterOrderId}` : ''}`
  );
  expect(all.data ?? []).toHaveLength(0);

  const web = await placeTestOrder(customer.accessToken, product.id, 1);
  createdOrderIds.push(web.id);
  expect((await orderRow(web.id)).collect_mode).toBe('cod');

  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=orders&order=${web.id}`);
  await page.getByTestId('edit-order').click();
  await expect(page).toHaveURL(new RegExp(`/admin/orders/${web.orderNumber}/edit$`));
  const edit = page.getByTestId('edit-order-page');
  await edit.getByRole('radio', { name: 'Customer pays later' }).click();
  await expect(edit.getByTestId('summary-courier')).toHaveText(taka(0));
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Order updated')).toBeVisible({ timeout: 15_000 });
  // Back on the same order.
  await expect(page).toHaveURL(new RegExp(`order=${web.id}`));
  expect((await orderRow(web.id)).collect_mode).toBe('pay_later');
  expect((await historyNotes(web.id)).some((n) => n.startsWith('Remaining money: Collect on delivery → Customer pays later'))).toBe(true);
  const log = await select<{ action: string }[]>(admin.accessToken, `activity_log?select=action&entity_id=eq.${web.id}&action=eq.order.collect_mode`);
  expect(log.data ?? []).toHaveLength(1);
});

test('Part 1: the database refuses paid > total and staff without the switches', async () => {
  test.skip(!ready, NEEDS_035);
  test.setTimeout(90_000);
  const base = {
    p_source: 'phone',
    p_items: [{ product_id: product.id, variant_id: null, quantity: 1 }],
    p_full_name: 'E2E B32 Refused',
    p_phone: PAY_LATER_PHONE,
    p_division: 'Dhaka',
    p_district: 'Dhaka',
    p_thana: 'Gulshan',
    p_address_line: 'Road 1 (e2e)',
    p_delivery_zone: 'inside_dhaka',
    p_delivery_fee: 70,
    p_allow_negative_stock: true,
  };
  const over = await rpc(admin.accessToken, 'admin_create_order_v2', { ...base, p_paid_amount: 99999999, p_paid_method: 'cash' });
  expect(over.ok).toBe(false);
  expect(over.error).toContain('cannot be more than the order total');

  const staff = await staffWith(['view_orders']);
  const create = await rpc(staff.accessToken, 'admin_create_order_v2', base);
  expect(create.error).toContain('Not authorized');
  const web = await placeTestOrder(customer.accessToken, product.id, 1);
  createdOrderIds.push(web.id);
  const mode = await rpc(staff.accessToken, 'admin_set_order_collect_mode', { p_order_id: web.id, p_mode: 'pay_later' });
  expect(mode.error).toContain('Not authorized');
  expect((await orderRow(web.id)).collect_mode).toBe('cod');
});

/* ---------------------------------------------------------------- Part 2 */

test('Part 2: Settings shows Version 1.32.0 and the build, no date', async ({ page }) => {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
  // Batch 33: each batch N sets 1.N.0, so this follows package.json. A fix
  // between batches sets 1.N.1 (rich-text editor fix: 1.37.1).
  expect(version).toMatch(/^1\.\d+\.\d+$/);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=settings');
  await expect(page.getByTestId('app-version')).toHaveText(`Version ${version}`, { timeout: 15_000 });
  await expect(page.getByTestId('app-build')).toHaveText(/^Build ([0-9a-f]{7}|local)$/);
  await expect(page.locator('.adm-app-version')).not.toContainText(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{2}:\d{2}/);
});

/* ---------------------------------------------------------------- Part 3 */

test('Part 3: every page opens by its link (after a refresh too) and needs the admin sign-in', async ({ page }) => {
  test.setTimeout(90_000);
  // Signed out: to the hidden admin sign-in, with the way back.
  await page.goto('/admin/orders/new');
  await expect(page).toHaveURL(/\/admin-access\?next=%2Fadmin%2Forders%2Fnew$/, { timeout: 15_000 });

  const order = await placeTestOrder(customer.accessToken, product.id, 1);
  createdOrderIds.push(order.id);
  const customers = await rpc<{ customer_key: string; profile_id: string | null }[]>(admin.accessToken, 'admin_customers_v2');
  const me = (customers.data ?? []).find((c) => c.profile_id === customer.userId)!;
  const pages: [string, string, string][] = [
    ['/admin/orders/new', 'new-order-page', 'New order'],
    [`/admin/orders/${order.orderNumber}/edit`, 'edit-order-page', `Edit ${order.orderNumber}`],
    ['/admin/products/new', 'product-page', 'Add product'],
    [`/admin/products/${product.id}/edit`, 'product-page', 'Edit product'],
    [`/admin/customers/${encodeURIComponent(me.customer_key)}`, 'customer-page', ''],
  ];
  await useSessionInPage(page, admin);
  for (const [url, testId, title] of pages) {
    await page.goto(url);
    await expect(page.getByTestId(testId)).toBeVisible({ timeout: 20_000 });
    if (title) await expect(page.locator('.adm-fpage__title')).toHaveText(title);
    await page.reload();
    await expect(page.getByTestId(testId)).toBeVisible({ timeout: 20_000 });
  }
  // Not a page: back to the admin.
  await page.goto('/admin/whatever/1');
  await expect(page).toHaveURL(/\/admin$/);
});

test('Part 3: Back keeps the list filters; typing then Back / phone Back asks "Discard changes?", Keep editing keeps the text', async ({ page }) => {
  test.setTimeout(90_000);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=orders&ostatus=delivered');
  await page.getByRole('button', { name: 'New order' }).click();
  await expect(page.getByTestId('new-order-page')).toBeVisible({ timeout: 15_000 });

  // Nothing typed: Back goes straight back, filter kept.
  await page.getByRole('button', { name: 'Back to orders' }).click();
  await expect(page).toHaveURL(/tab=orders&ostatus=delivered/);
  await expect(page.getByRole('dialog', { name: 'Discard changes?' })).toHaveCount(0);

  await page.getByRole('button', { name: 'New order' }).click();
  await page.locator('#manual-order-name').fill('E2E typed name');
  // The page's Back.
  await page.getByRole('button', { name: 'Back to orders' }).click();
  const ask = page.getByRole('dialog', { name: 'Discard changes?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.locator('#manual-order-name')).toHaveValue('E2E typed name');
  await expect(page).toHaveURL(/\/admin\/orders\/new$/);
  // The phone's Back.
  await page.goBack();
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('#manual-order-name')).toHaveValue('E2E typed name');
  // A sheet on the page (division picker) closes with Back without asking.
  await page.locator('#manual-order-division').click();
  await expect(page.getByPlaceholder('Search division...')).toBeVisible();
  await page.goBack();
  await expect(page.getByPlaceholder('Search division...')).toHaveCount(0);
  await expect(ask).toHaveCount(0);
  await expect(page.locator('#manual-order-name')).toHaveValue('E2E typed name');
  // The bottom bar steps aside for the docked Create order button.
  await expect(page.locator('.adm-tabbar')).toBeHidden();
  // Discard: back to the list with its filter.
  await page.goBack();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(/tab=orders&ostatus=delivered/, { timeout: 10_000 });
});

test('Part 3: on a computer, another sidebar item asks first; products and customers return to their filtered lists', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${product.id}/edit`);
  await expect(page.getByTestId('product-page')).toBeVisible({ timeout: 20_000 });
  await page.locator('#pf-name').first().fill(`${product.name} (typed)`);
  await page.getByRole('navigation', { name: 'Admin sections' }).first().getByRole('button', { name: 'Customers' }).click();
  const ask = page.getByRole('dialog', { name: 'Discard changes?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('#pf-name').first()).toHaveValue(`${product.name} (typed)`);
  await page.getByRole('navigation', { name: 'Admin sections' }).first().getByRole('button', { name: 'Customers' }).click();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(/tab=customers/, { timeout: 10_000 });
  // Nothing was saved.
  const saved = await select<{ name: string }[]>(admin.accessToken, `products?select=name&id=eq.${product.id}`);
  expect(saved.data![0].name).toBe(product.name);

  // Products list → product page → Back: the search is kept.
  const term = product.name.slice(0, 10);
  await page.goto(`/admin?tab=products&pq=${encodeURIComponent(term)}`);
  await page.getByTestId('product-row').first().locator('.adm-lrow__name').click();
  await expect(page.getByTestId('product-page')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Back to products' }).click();
  await expect(page).toHaveURL(new RegExp(`pq=${encodeURIComponent(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // Customers list → customer page → Back: the search is kept.
  await page.goto(`/admin?tab=customers&cq=${encodeURIComponent(E2E_EMAIL)}`);
  await page.locator('[data-testid="customer-row"] .adm-lrow__open').first().click({ timeout: 15_000 });
  await expect(page.getByTestId('customer-page')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/customers\//);
  await page.getByRole('button', { name: 'Back to customers' }).click();
  await expect(page).toHaveURL(/cq=/);
});

/* ---------------------------------------------------------------- Part 4 */

test('Part 4: add a customer (a known phone opens them), delete one with no orders', async ({ page }) => {
  test.skip(!ready, NEEDS_035);
  test.setTimeout(90_000);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByTestId('new-customer-page')).toBeVisible({ timeout: 15_000 });
  await page.locator('#new-customer-name').fill(ADDED_NAME);
  await page.locator('#new-customer-phone').fill('+880 1799-990034');
  await page.locator('#new-customer-alt-phone').fill('01899990034');
  await page.locator('#new-customer-address').fill('Road 34 (e2e)');
  await page.locator('#new-customer-note').fill('E2E: added by the test');
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByText('Customer added')).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/admin/customers/ph%3A${ADDED_PHONE}$`));
  await expect(page.getByTestId('customer-added-note')).toHaveText('E2E: added by the test');
  const log = await select<{ action: string }[]>(admin.accessToken, `activity_log?select=action&entity_id=eq.ph:${ADDED_PHONE}&action=eq.customer.added`);
  expect((log.data ?? []).length).toBeGreaterThan(0);

  // The same phone typed another way opens the existing customer.
  await page.goto('/admin/customers/new');
  await page.locator('#new-customer-name').fill('Someone else');
  await page.locator('#new-customer-phone').fill(`880${ADDED_PHONE.slice(1)}`);
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByText(/already belongs to a customer/)).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`ph%3A${ADDED_PHONE}$`));
  await expect(page.locator('.adm-fpage__title')).toHaveText(ADDED_NAME);

  // New order finds them (no orders yet).
  const found = await rpc<{ customer_key: string }[]>(admin.accessToken, 'admin_find_customers_v2', { p_query: ADDED_PHONE });
  expect((found.data ?? []).map((r) => r.customer_key)).toContain(`ph:${ADDED_PHONE}`);

  // No orders → Delete is offered; confirmed; gone.
  await page.getByTestId('customer-delete').click();
  await page.getByRole('dialog', { name: 'Delete this customer?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Customer deleted')).toBeVisible({ timeout: 15_000 });
  const after = await rpc<{ customer_key: string }[]>(admin.accessToken, 'admin_customers_v3');
  expect((after.data ?? []).some((r) => r.customer_key === `ph:${ADDED_PHONE}`)).toBe(false);
});

test('Part 4: hide / unhide a customer with orders; delete refused; staff need "Manage customers" (checked in the database)', async ({ page }) => {
  test.skip(!ready, NEEDS_035);
  test.setTimeout(120_000);
  // A customer with an order (phone-only).
  const manual = await rpc<{ order_id: string }[]>(admin.accessToken, 'admin_create_order_v2', {
    p_source: 'phone',
    p_items: [{ product_id: product.id, variant_id: null, quantity: 1 }],
    p_full_name: 'E2E B32 Hidden Customer',
    p_phone: PAY_LATER_PHONE,
    p_division: 'Dhaka',
    p_district: 'Dhaka',
    p_thana: 'Gulshan',
    p_address_line: 'Road 32 (e2e)',
    p_delivery_zone: 'inside_dhaka',
    p_delivery_fee: 70,
    p_allow_negative_stock: true,
  });
  expect(manual.ok, manual.error ?? '').toBe(true);
  createdOrderIds.push(manual.data![0].order_id);
  const key = `ph:${PAY_LATER_PHONE}`;

  await useSessionInPage(page, admin);
  await page.goto(`/admin/customers/${encodeURIComponent(key)}`);
  await expect(page.getByTestId('customer-page')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('customer-delete')).toHaveCount(0);
  await page.getByTestId('customer-hide').click();
  await expect(page.getByTestId('customer-hidden-banner')).toBeVisible({ timeout: 15_000 });

  // Gone from the list and the New order search; back with the Hidden filter.
  await page.goto(`/admin?tab=customers&cq=${PAY_LATER_PHONE}`);
  await expect(page.getByTestId('customer-row')).toHaveCount(0, { timeout: 15_000 });
  await page.goto(`/admin?tab=customers&cq=${PAY_LATER_PHONE}&cshow=hidden`);
  await expect(page.getByTestId('customer-row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('customer-hidden-tag').first()).toBeVisible();
  const search = await rpc<{ customer_key: string }[]>(admin.accessToken, 'admin_find_customers_v2', { p_query: PAY_LATER_PHONE });
  expect((search.data ?? []).some((r) => r.customer_key === key)).toBe(false);
  // Orders and dues untouched.
  const orders = await rpc<{ id: string }[]>(admin.accessToken, 'admin_customer_orders_v2', { p_customer_key: key });
  expect((orders.data ?? []).length).toBeGreaterThan(0);

  const refused = await rpc(admin.accessToken, 'admin_delete_customer', { p_customer_key: key });
  expect(refused.ok).toBe(false);

  // Unhide.
  await page.goto(`/admin/customers/${encodeURIComponent(key)}`);
  await page.getByTestId('customer-hide').click();
  await expect(page.getByTestId('customer-hidden-banner')).toHaveCount(0, { timeout: 15_000 });
  const back = await rpc<{ customer_key: string }[]>(admin.accessToken, 'admin_find_customers_v2', { p_query: PAY_LATER_PHONE });
  expect((back.data ?? []).some((r) => r.customer_key === key)).toBe(true);
  const logs = await select<{ action: string }[]>(admin.accessToken, `activity_log?select=action&entity_id=eq.${key}&action=like.customer.*`);
  expect((logs.data ?? []).map((l) => l.action)).toEqual(expect.arrayContaining(['customer.hidden', 'customer.unhidden']));

  // Staff: refused without the switch, allowed with it.
  const viewer = await staffWith(['view_customers']);
  expect((await rpc(viewer.accessToken, 'admin_set_customer_hidden', { p_customer_key: key, p_hidden: true })).error).toContain('Not authorized');
  expect((await rpc(viewer.accessToken, 'admin_delete_customer', { p_customer_key: key })).error).toContain('Not authorized');
  const added = await rpc(viewer.accessToken, 'admin_add_customer', { p_full_name: ADDED_NAME, p_phone: ADDED_PHONE });
  expect(added.error).toContain('Not authorized');
  const manager = await staffWith(['view_customers', 'manage_customers']);
  const ok = await rpc(manager.accessToken, 'admin_set_customer_hidden', { p_customer_key: key, p_hidden: false });
  expect(ok.ok, ok.error ?? '').toBe(true);
});

/* ---------------------------------------------------------------- Part 5 */

async function expectedDue(): Promise<{ total: number; customers: number }> {
  const v3 = await rpc<{ total_due: number | null }[]>(admin.accessToken, 'admin_customers_v3');
  const rows = v3.ok ? v3.data! : (await rpc<{ total_due: number | null }[]>(admin.accessToken, 'admin_customers_v2')).data!;
  let total = 0;
  let customers = 0;
  for (const r of rows) {
    const due = Number(r.total_due ?? 0);
    if (due > 0) {
      total += due;
      customers += 1;
    }
  }
  return { total, customers };
}

for (const width of [390, 1280]) {
  test(`Part 5: Admin Home at ${width} px — four cards, section titles, the due row with the right total`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    await useSessionInPage(page, admin);
    await page.goto('/admin');
    const cards = ['kpi-today', 'kpi-confirm', 'kpi-way', 'kpi-month'].map((id) => page.getByTestId(id));
    for (const card of cards) await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('kpi-today')).toContainText('Today');
    await expect(page.getByTestId('kpi-way')).toContainText('With courier');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^(Good (morning|afternoon|evening)|Hello), \S+/);
    await expect(page.locator('.adm-page-header__subtitle')).toHaveText(/^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+$/);
    await expect(page.locator('.adm-home__section-title').filter({ hasText: 'Needs attention' })).toBeVisible();
    await expect(page.locator('.adm-home__section-title').filter({ hasText: 'Sales · last 7 days' })).toBeVisible();

    const boxes = await Promise.all(cards.map((c) => c.boundingBox()));
    if (width === 390) {
      expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
      expect(Math.abs(boxes[0]!.x - boxes[2]!.x)).toBeLessThan(2);
      expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height);
      const gap = boxes[1]!.x - (boxes[0]!.x + boxes[0]!.width);
      expect(gap).toBeGreaterThanOrEqual(12);
      expect(gap).toBeLessThanOrEqual(16);
    } else {
      for (const b of boxes) expect(Math.abs(b!.y - boxes[0]!.y)).toBeLessThan(2);
      const gap = boxes[1]!.x - (boxes[0]!.x + boxes[0]!.width);
      expect(gap).toBeGreaterThanOrEqual(12);
      expect(gap).toBeLessThanOrEqual(16);
    }

    const due = await expectedDue();
    if (due.customers > 0) {
      await expect(page.getByTestId('home-due-row')).toHaveText(
        `${takaBd(due.total)} due from ${due.customers} customer${due.customers === 1 ? '' : 's'}`
      );
      await page.getByTestId('home-due-row').click();
      await expect(page).toHaveURL(/tab=customers.*cshow=due|cshow=due.*tab=customers/);
    } else {
      await expect(page.getByTestId('home-due-row')).toHaveCount(0);
    }
  });
}

test('Part 5: rows at 0 are hidden; all at 0 → "Nothing needs attention"; To confirm 0 → "all clear"', async ({ page }) => {
  test.setTimeout(60_000);
  await page.route(/\/rest\/v1\/rpc\/admin_dashboard/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        can_see_sales: true,
        low_stock_threshold: 5,
        today_orders: 0,
        today_total: 0,
        to_confirm: 0,
        on_the_way: 0,
        month_orders: 0,
        month_total: 0,
        low_stock: 0,
        reviews_pending: 0,
        wholesalers_pending: 0,
      }),
    })
  );
  await page.route(/\/rest\/v1\/rpc\/admin_customers_v[23]/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await useSessionInPage(page, admin);
  await page.goto('/admin');
  await expect(page.getByTestId('home-nothing')).toHaveText('Nothing needs attention', { timeout: 15_000 });
  await expect(page.locator('.adm-home .adm-row')).toHaveCount(0);
  await expect(page.getByTestId('kpi-confirm-clear')).toHaveText('all clear');
  await expect(page.getByTestId('kpi-confirm')).not.toHaveClass(/adm-kpi--attn/);
});

/* ---------------------------------------------------------------- Part 6 */

test('Part 6: manifest — NAEEM\'S, white, a transparent round "any" icon for the splash, a full-bleed maskable one', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = (await (await page.request.get(href!)).json()) as {
    name: string;
    background_color: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };
  expect(manifest.name).toBe("NAEEM'S");
  expect(manifest.background_color).toBe('#FFFFFF');
  const anyIcon = manifest.icons.find((i) => i.purpose === 'any' && i.sizes === '512x512')!;
  const maskable = manifest.icons.find((i) => i.purpose === 'maskable' && i.sizes === '512x512')!;
  expect(anyIcon.src).toBe('/icons/icon-splash-512.png');
  const read = async (src: string) => PNG.sync.read(Buffer.from(await (await page.request.get(src)).body()));
  const any = await read(anyIcon.src);
  const alpha = (png: PNG, x: number, y: number) => png.data[(y * png.width + x) * 4 + 3];
  expect(any.width).toBe(512);
  for (const [x, y] of [[0, 0], [511, 0], [0, 511], [511, 511], [60, 60], [256, 40]]) expect(alpha(any, x, y)).toBe(0);
  expect(alpha(any, 256, 256)).toBe(255);
  // No dark pixel anywhere (no black square or ring).
  let dark = 0;
  for (let i = 0; i < any.data.length; i += 4) {
    if (any.data[i + 3] > 0 && any.data[i] < 60 && any.data[i + 1] < 60 && any.data[i + 2] < 60) dark += 1;
  }
  expect(dark).toBe(0);
  const mask = await read(maskable.src);
  expect(alpha(mask, 0, 0)).toBe(255);
});
