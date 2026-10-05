import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_MOD_PASSWORD, E2E_PASSWORD } from './helpers/env';
import {
  callFunction,
  passwordSession,
  pickStockedProduct,
  placeTestOrder,
  productStock,
  rpc,
  select,
  useSessionInPage,
  type TestSession,
} from './helpers/api';
import { STEADFAST_FUNCTION, mockSteadfast } from './helpers/steadfastMock';
import { playwrightSummary, runOutput, vitestSummary } from '../scripts/verifyReport.mjs';

// Batch 30: faster test runs (Part 1), edit any order (Part 2), payments
// (Part 3), pick a customer (Part 4), real Steadfast steps (Part 5), all
// thanas (Part 6). Steadfast is ALWAYS mocked (e2e/fixtures.ts + the
// mocks below) — no test reaches the real Steadfast API or books a parcel.
// Orders are test orders (the test customer, or "E2E …" manual orders),
// all deleted in afterAll. The database parts need migration-033; until
// Naeem has run it they are skipped with that reason.

const STAFF_USERNAME = 'e2e.role30';
const ROLE_NAME = 'E2E Batch30 role';
const PHONE_CUSTOMER = '01799990030';

test.describe.configure({ mode: 'serial' });

test.skip(
  !E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_MOD_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD,
  'Needs the test accounts in .env.e2e (see reports/batch-24.txt).'
);

let admin: TestSession;
let customer: TestSession;
let product: { id: string; name: string; stock: number };
let product2: { id: string; name: string };
let migrationReady = false;
let staffId = '';
let roleId = '';
const createdOrderIds: string[] = [];

const taka = (n: number) => `৳ ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

async function freshAdmin(): Promise<TestSession> {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  return admin;
}

async function newWebOrder(quantity = 1): Promise<{ id: string; orderNumber: string }> {
  const order = await placeTestOrder(customer.accessToken, product.id, quantity);
  createdOrderIds.push(order.id);
  return order;
}

async function setStatus(orderId: string, status: string): Promise<void> {
  const res = await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: orderId, p_new_status: status });
  expect(res.ok, res.error ?? '').toBe(true);
}

/** A test order "booked on Steadfast" with a made-up consignment id — the
 *  database call only, Steadfast itself is never contacted. */
async function bookedOrder(courierStatus = 'in_review'): Promise<{ id: string; orderNumber: string }> {
  const order = await newWebOrder();
  await setStatus(order.id, 'confirmed');
  const res = await rpc(admin.accessToken, 'admin_record_steadfast_shipment', {
    p_order_id: order.id,
    p_consignment_id: `E2E-B30-${Date.now()}`,
    p_tracking_code: 'E2EB30',
    p_tracking_link: '',
    p_courier_status: courierStatus,
  });
  expect(res.ok, res.error ?? '').toBe(true);
  return order;
}

async function orderRow(orderId: string): Promise<Record<string, unknown>> {
  const res = await select<Record<string, unknown>[]>(admin.accessToken, `orders?select=*&id=eq.${orderId}`);
  return res.data![0];
}

async function historyNotes(orderId: string): Promise<string[]> {
  const res = await select<{ note: string | null }[]>(admin.accessToken, `order_history_private?select=note&order_id=eq.${orderId}`);
  return (res.data ?? []).map((r) => r.note ?? '');
}

async function openAdminOrder(page: Page, orderId: string): Promise<void> {
  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=orders&order=${orderId}`);
  await expect(page.getByRole('dialog').first()).toBeVisible({ timeout: 15_000 });
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

test.beforeAll(async () => {
  test.setTimeout(60_000);
  await freshAdmin();
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(8);
  const withOptions = await select<{ product_id: string }[]>(null, 'product_variants?select=product_id');
  const optionIds = new Set((withOptions.data ?? []).map((r) => r.product_id));
  const others = await select<{ id: string; name: string }[]>(
    null,
    `products_view?select=id,name&is_active=eq.true&stock_quantity=gte.6&id=neq.${product.id}&order=stock_quantity.desc&limit=20`
  );
  product2 = (others.data ?? []).find((p) => !optionIds.has(p.id)) ?? (others.data ?? [])[0];
  // A function that answers 404 does not exist yet: migration-033 not run.
  const probe = await rpc(admin.accessToken, 'order_payment_summary', { p_order_id: '00000000-0000-0000-0000-000000000000' });
  migrationReady = probe.status !== 404;
  if (migrationReady) await deleteStaffAndRole();
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await freshAdmin();
  if (createdOrderIds.length > 0) {
    await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
    await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: createdOrderIds });
    await rpc(admin.accessToken, 'admin_close_delete_lock');
  }
  if (migrationReady) await deleteStaffAndRole();
});

/* ---------------------------------------------------------------- Part 1 */

test('Part 1: verify prints one summary line when all pass, only failures otherwise', () => {
  const vitestOk = vitestSummary({ numTotalTests: 115, numPassedTests: 115, success: true, testResults: [] }, 15, 0);
  const pass = (title: string) => ({ title, file: 'a.spec.ts', line: 1, tests: [{ status: 'expected', projectName: 'parallel', results: [] }] });
  const e2eOk = playwrightSummary(
    [
      { suites: [{ specs: [pass('one'), pass('two'), { title: 'skip', file: 'a.spec.ts', line: 9, tests: [{ status: 'skipped', projectName: 'serial', results: [] }] }] }] },
    ],
    120
  );
  const out = runOutput('', 'build OK (26s)', vitestOk, e2eOk);
  expect(out).toBe('build OK (26s) · vitest 115/115 (15s) · e2e 2 passed, 1 skipped (120s)');
  expect(out.split('\n')).toHaveLength(1);

  const failing = playwrightSummary(
    [
      {
        suites: [
          {
            specs: [
              pass('fine'),
              {
                title: 'broken thing',
                file: 'b.spec.ts',
                line: 3,
                tests: [
                  {
                    status: 'unexpected',
                    projectName: 'serial',
                    results: [{ status: 'failed', error: { message: 'Expected 1\nReceived 2', location: { file: 'e2e/b.spec.ts', line: 42 } } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    60
  );
  const failOut = runOutput('', 'build OK (26s)', vitestOk, failing);
  expect(failing.ok).toBe(false);
  expect(failOut).toContain('FAIL [serial] broken thing');
  expect(failOut).toContain('e2e/b.spec.ts:42');
  expect(failOut).toContain('Expected 1');
  expect(failOut).not.toContain('fine');
});

/* ---------------------------------------------------------------- Part 5 */

test('Part 5: the customer sees the real steps — Booked, In Transit, Out for Delivery, Delivered — never rider details', async ({ page }) => {
  test.setTimeout(90_000);
  const order = await bookedOrder();
  await useSessionInPage(page, customer);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const show = async (courierStatus: string, events: { text: string; at: string }[]) => {
    await page.unroute(STEADFAST_FUNCTION);
    await mockSteadfast(page, { tracking: { courierStatus, events } });
    await page.goto(`/orders/${order.id}`);
    await page.evaluate(() => window.sessionStorage.clear());
    await page.reload();
  };

  await show('in_review', [{ text: 'Consignment created by Sender(API).', at: '2026-10-01T07:00:00Z' }]);
  await expect(page.getByTestId('delivery-status')).toHaveText('Booked', { timeout: 15_000 });
  await expect(page.locator('.order-steps__step--current')).toHaveAttribute('data-step', 'booked');
  await expect(page.locator('.order-steps__step--done')).toHaveCount(2);

  await show('pending', [
    { text: 'Consignment created by Sender(API).', at: '2026-10-01T07:00:00Z' },
    { text: 'Parcel received at Dhanmondi hub.', at: '2026-10-01T11:00:00Z' },
  ]);
  await expect(page.getByTestId('delivery-status')).toHaveText('In Transit', { timeout: 15_000 });
  await expect(page.getByTestId('order-step-latest')).toContainText('Parcel received at Dhanmondi hub.');

  await show('pending', [
    { text: 'Parcel received at Dhanmondi hub.', at: '2026-10-01T11:00:00Z' },
    { text: 'Assigned to rider Md. Karim (01711111111)', at: '2026-10-02T09:00:00Z' },
  ]);
  await expect(page.getByTestId('delivery-status')).toHaveText('Out for Delivery', { timeout: 15_000 });
  await expect(page.getByTestId('order-step-latest')).toContainText('Assigned to a rider — your parcel is out for delivery.');
  await expect(page.locator('body')).not.toContainText('01711111111');
  await expect(page.locator('body')).not.toContainText('Karim');

  await show('delivered', [{ text: 'Delivered to the customer.', at: '2026-10-02T15:00:00Z' }]);
  await expect(page.getByTestId('delivery-status')).toHaveText('Delivered', { timeout: 15_000 });
  await expect(page.locator('.order-steps__step--done, .order-steps__dot--check')).not.toHaveCount(0);

  // Track on Steadfast stays.
  await expect(page.locator('.order-detail__tracking-link')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Part 5: admin sees the steps and the full Steadfast timeline (rider included)', async ({ page }) => {
  test.setTimeout(60_000);
  const order = await bookedOrder('pending');
  await mockSteadfast(page, {
    tracking: {
      courierStatus: 'pending',
      events: [
        { text: 'Parcel received at Dhanmondi hub.', at: '2026-10-01T11:00:00Z' },
        { text: 'Assigned to rider Md. Karim (01711111111)', at: '2026-10-02T09:00:00Z' },
      ],
    },
  });
  await openAdminOrder(page, order.id);
  const dialog = page.getByRole('dialog').first();
  await expect(dialog.getByTestId('order-step-label')).toHaveText('Out for Delivery', { timeout: 15_000 });
  await expect(dialog.getByTestId('courier-timeline')).toContainText('Assigned to rider Md. Karim (01711111111)');
  await expect(dialog.getByTestId('courier-timeline')).toContainText('Parcel received at Dhanmondi hub.');
});

test('Part 5: without the new function action, the page shows the saved status with no errors', async ({ page }) => {
  test.setTimeout(60_000);
  const order = await bookedOrder('pending');
  await mockSteadfast(page, { tracking: null });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await useSessionInPage(page, customer);
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId('delivery-status')).toHaveText('In Transit', { timeout: 15_000 });
  await expect(page.getByTestId('order-step-latest')).toHaveCount(0);
  expect(errors).toEqual([]);
});

/* ---------------------------------------------------------------- Part 6 */

async function openCheckoutAddress(page: Page): Promise<void> {
  await useSessionInPage(page, customer);
  await page.goto('/');
  await page.waitForSelector('.product-card');
  const addButton = page.getByRole('button', { name: /^Add .* to cart$/ }).first();
  await addButton.click();
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/\/checkout\/delivery/);
}

async function pickDhakaDhaka(page: Page, prefix: string): Promise<void> {
  await page.locator(`#${prefix}-division`).click();
  await page.getByPlaceholder('Search division...').fill('Dhaka');
  await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
  await page.locator(`#${prefix}-district`).click();
  await page.getByPlaceholder('Search district...').fill('Dhaka');
  await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
}

test('Part 6: checkout — thanas grouped by district, searchable, "Other" saves the typed thana; function failing → snapshot', async ({ page }) => {
  test.setTimeout(90_000);
  await mockSteadfast(page, { policeStations: null });
  await page.addInitScript(() => window.localStorage.removeItem('steadfast-thanas-v1'));
  await openCheckoutAddress(page);
  const prefix = (await page.locator('[id$="-division"]').first().getAttribute('id'))!.replace(/-division$/, '');
  await pickDhakaDhaka(page, prefix);

  await page.locator(`#${prefix}-thana`).click();
  const list = page.getByTestId('thana-list');
  await expect(list.locator('.thana-picker__district').first()).toHaveText('Dhaka');
  // The snapshot (the list bundled with the site) is used.
  await expect(list).toContainText('Gulshan');
  const names = await list.locator('.thana-picker__group').first().locator('.picker-sheet__row-label').allTextContents();
  expect(names.length).toBeGreaterThan(20);
  expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);

  // Search reaches other districts' thanas, grouped by district.
  await page.getByLabel('Search thana').fill('kotwali');
  expect(await list.locator('.thana-picker__district').count()).toBeGreaterThan(1);

  // "Other — type your thana".
  await page.getByLabel('Search thana').fill('');
  await list.getByRole('button', { name: 'Other — type your thana' }).click();
  await page.getByLabel('Type your thana').fill('E2E Test Para');
  await page.getByRole('button', { name: 'Use this' }).click();
  await expect(page.locator(`#${prefix}-thana`)).toHaveText('E2E Test Para');
  await expect(page.locator(`#${prefix}-district`)).toHaveText('Dhaka');
});

test("Part 6: Steadfast's list is used once the function answers (and kept for next time)", async ({ page }) => {
  test.setTimeout(90_000);
  const calls = await mockSteadfast(page, {
    policeStations: [
      { name: 'E2E Steadfast Thana', district: 'Dhaka' },
      { name: 'Kotwali', district: 'Chittagong' },
    ],
  });
  await page.addInitScript(() => window.localStorage.removeItem('steadfast-thanas-v1'));
  await openCheckoutAddress(page);
  const prefix = (await page.locator('[id$="-division"]').first().getAttribute('id'))!.replace(/-division$/, '');
  await pickDhakaDhaka(page, prefix);
  await page.locator(`#${prefix}-thana`).click();
  await expect(page.getByTestId('thana-list')).toContainText('E2E Steadfast Thana', { timeout: 15_000 });
  expect(calls.some((c) => c.action === 'police_stations')).toBe(true);
  const cached = await page.evaluate(() => window.localStorage.getItem('steadfast-thanas-v1'));
  expect(cached).toContain('E2E Steadfast Thana');
  // Picking a thana from another district moves the address there.
  await page.getByLabel('Search thana').fill('kotwali');
  await page.getByTestId('thana-list').getByRole('button', { name: 'Kotwali' }).click();
  await expect(page.locator(`#${prefix}-district`)).toHaveText('Chattogram');
  await expect(page.locator(`#${prefix}-thana`)).toHaveText('Kotwali');
});

test('Part 6: the same thana list in admin New order and Edit order', async ({ page }) => {
  test.setTimeout(90_000);
  await mockSteadfast(page, { policeStations: null });
  const order = await bookedOrder();
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await pickDhakaDhaka(page, 'manual-order');
  await page.locator('#manual-order-thana').click();
  await expect(page.getByTestId('thana-list').locator('.thana-picker__district').first()).toHaveText('Dhaka');
  await expect(page.getByTestId('thana-list').getByRole('button', { name: 'Other — type your thana' })).toBeVisible();

  await page.goto(`/admin?tab=orders&order=${order.id}`);
  await page.getByTestId('edit-order').click();
  await page.locator('#edit-order-thana').click();
  await expect(page.getByTestId('thana-list').locator('.thana-picker__district').first()).toHaveText('Dhaka');
  await expect(page.getByTestId('thana-list')).toContainText('Gulshan');
});

/* ---------------------------------------------------------------- Part 2 */

test('Part 2: edit a booked order — name, phone, thana, address, items, delivery fee 0, discount; History, stock, Steadfast banner', async ({ page }) => {
  test.skip(!migrationReady, 'Needs migration-033 (Batch 30 database update) — not applied yet.');
  test.setTimeout(120_000);
  const order = await bookedOrder();
  const before = await orderRow(order.id);
  const stock1 = await productStock(product.id);
  const stock2 = await productStock(product2.id);
  await rpc(admin.accessToken, 'admin_set_steadfast_cod', { p_order_id: order.id, p_amount: Number(before.total) });

  await openAdminOrder(page, order.id);
  await page.getByTestId('edit-order').click();
  const sheet = page.getByTestId('edit-order-sheet');
  await sheet.getByLabel(/Full name/).fill('E2E Edited Name');
  await sheet.getByLabel(/Phone number/).fill('01712345670');
  await sheet.getByLabel('Alternative phone (optional)').fill('01812345678');
  await sheet.getByLabel(/House \/ road \/ landmark/).fill('Road 9 (edited, e2e)');
  await page.locator('#edit-order-thana').click();
  await page.getByLabel('Search thana').fill('Banani');
  await page.getByTestId('thana-list').getByRole('button', { name: 'Banani' }).first().click();
  await sheet.getByRole('button', { name: `Increase quantity of ${product.name}` }).click();
  await sheet.getByLabel('Add a product').fill(product2.name.slice(0, 18));
  await sheet.locator('.edit-order__results .picker-sheet__row').filter({ hasText: product2.name }).first().click();
  await sheet.getByLabel('Delivery fee (৳)').fill('0');
  await sheet.getByLabel('Order discount (৳)').fill('50');
  await sheet.getByLabel('Reason for the discount (optional)').fill('Late delivery');
  await sheet.getByLabel('Note for the courier (optional)').fill('Call first');
  await sheet.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Order updated')).toBeVisible({ timeout: 15_000 });

  const after = await orderRow(order.id);
  expect(after.customer_name).toBe('E2E Edited Name');
  expect(after.thana).toBe('Banani');
  expect(after.alt_phone).toBe('01812345678');
  expect(Number(after.delivery_fee)).toBe(0);
  expect(Number(after.discount)).toBe(50);
  expect(Number(after.total)).toBe(Number(after.subtotal) - 50);
  expect(after.steadfast_outdated).toEqual(['Name', 'Phone', 'Alternative phone', 'Address', 'Note']);
  expect(await productStock(product.id)).toBe(stock1 - 1);
  expect(await productStock(product2.id)).toBe(stock2 - 1);

  const notes = await historyNotes(order.id);
  expect(notes.some((n) => /^Delivery fee ৳\d+ → ৳0$/.test(n))).toBe(true);
  expect(notes).toContain('Name E2E Test Customer → E2E Edited Name');
  expect(notes.some((n) => n.startsWith('Address ') && n.includes('Banani'))).toBe(true);
  expect(notes.some((n) => n.startsWith(`Quantity of ${product.name}`) && n.endsWith('1 → 2'))).toBe(true);
  expect(notes.some((n) => n.startsWith(`Added ${product2.name}`))).toBe(true);
  expect(notes.some((n) => n.startsWith('Discount ৳0 → ৳50'))).toBe(true);
  const activity = await select<{ action: string; actor_username: string }[]>(
    admin.accessToken,
    `activity_log?select=action,actor_username&entity_id=eq.${order.id}&action=eq.order.edited`
  );
  expect(activity.data?.length).toBe(1);

  // History shows who did it; the banner lists what Steadfast still has old.
  const dialog = page.getByRole('dialog').first();
  await expect(dialog.getByText(/Delivery fee ৳\d+ → ৳0/)).toBeVisible();
  const banner = dialog.getByTestId('steadfast-banner');
  await expect(banner).toContainText('Steadfast still has the old details: Name, Phone, Alternative phone, Address, Note');
  await expect(banner.getByRole('link', { name: /Open on Steadfast/ })).toHaveAttribute('target', '_blank');
  await expect(banner.getByTestId('steadfast-banner-cod')).toContainText(`COD on Steadfast should now be ${taka(Number(after.total))}`);
  await banner.getByRole('button', { name: 'Done, I updated Steadfast' }).click();
  await expect(dialog.getByTestId('steadfast-banner')).toHaveCount(0, { timeout: 15_000 });
  expect((await historyNotes(order.id)).some((n) => n.startsWith('Updated on Steadfast by hand'))).toBe(true);

  // Removing a line puts its stock back.
  const items = await select<{ id: string; product_id: string }[]>(admin.accessToken, `order_items?select=id,product_id&order_id=eq.${order.id}`);
  const keep = items.data!.filter((i) => i.product_id === product.id).map((i) => ({ id: i.id, quantity: 2 }));
  const removed = await rpc(admin.accessToken, 'admin_edit_order', { p_order_id: order.id, p_changes: { items: keep } });
  expect(removed.ok, removed.error ?? '').toBe(true);
  expect(await productStock(product2.id)).toBe(stock2);

  // Never below 0.
  const tooMany = await rpc(admin.accessToken, 'admin_edit_order', {
    p_order_id: order.id,
    p_changes: { items: [{ id: keep[0].id, quantity: 2 + (await productStock(product.id)) + 1 }] },
  });
  expect(tooMany.error).toMatch(/Only \d+ in stock/);
});

test('Part 2: a cancelled order can be edited, and no stock moves', async () => {
  test.skip(!migrationReady, 'Needs migration-033 (Batch 30 database update) — not applied yet.');
  const order = await newWebOrder();
  await setStatus(order.id, 'cancelled');
  const stock = await productStock(product.id);
  const items = await select<{ id: string }[]>(admin.accessToken, `order_items?select=id&order_id=eq.${order.id}`);
  const res = await rpc(admin.accessToken, 'admin_edit_order', {
    p_order_id: order.id,
    p_changes: { items: [{ id: items.data![0].id, quantity: 3 }], delivery_fee: 0 },
  });
  expect(res.ok, res.error ?? '').toBe(true);
  expect(await productStock(product.id)).toBe(stock);
});

test('Part 2: staff without "Edit orders" are refused by the database (and see no button)', async ({ page }) => {
  test.skip(!migrationReady, 'Needs migration-033 (Batch 30 database update) — not applied yet.');
  test.setTimeout(120_000);
  const role = await rpc<string>(admin.accessToken, 'admin_role_save', {
    p_id: null,
    p_name: ROLE_NAME,
    p_permissions: ['view_orders', 'change_order_status'],
  });
  expect(role.ok, role.error ?? '').toBe(true);
  roleId = role.data!;
  const created = await callFunction<{ ok: boolean; userId?: string; error?: string }>(admin.accessToken, 'admin-team', {
    action: 'create',
    username: STAFF_USERNAME,
    fullName: 'E2E Batch30 Staff',
    phone: '01700000030',
    password: E2E_MOD_PASSWORD,
  });
  expect(created.ok, created.error).toBe(true);
  staffId = created.userId!;
  const setRole = await rpc(admin.accessToken, 'admin_team_set_role', { p_user_id: staffId, p_role_id: roleId });
  expect(setRole.ok, setRole.error ?? '').toBe(true);

  const order = await newWebOrder();
  const staff = await passwordSession(`${STAFF_USERNAME}@staff.naeems.internal`, E2E_MOD_PASSWORD);
  const refused = await rpc(staff.accessToken, 'admin_edit_order', { p_order_id: order.id, p_changes: { delivery_fee: 0 } });
  expect(refused.error).toContain('Not authorized');
  expect(Number((await orderRow(order.id)).delivery_fee)).toBeGreaterThan(0);

  await useSessionInPage(page, staff);
  await page.goto(`/admin?tab=orders&order=${order.id}`);
  await expect(page.getByRole('dialog').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('edit-order')).toHaveCount(0);

  // With the switch on: allowed — but prices stay Super Admin only.
  const on = await rpc(admin.accessToken, 'admin_role_save', {
    p_id: roleId,
    p_name: ROLE_NAME,
    p_permissions: ['view_orders', 'change_order_status', 'edit_orders'],
  });
  expect(on.ok, on.error ?? '').toBe(true);
  const allowed = await rpc(staff.accessToken, 'admin_edit_order', { p_order_id: order.id, p_changes: { delivery_fee: 0 } });
  expect(allowed.ok, allowed.error ?? '').toBe(true);
  const items = await select<{ id: string }[]>(admin.accessToken, `order_items?select=id&order_id=eq.${order.id}`);
  const price = await rpc(staff.accessToken, 'admin_edit_order', {
    p_order_id: order.id,
    p_changes: { items: [{ id: items.data![0].id, quantity: 1, unit_price: 1 }] },
  });
  expect(price.error).toContain('Only the Super Admin can change prices');
});

/* ---------------------------------------------------------------- Part 3 */

test('Part 3: add a partial payment, the rest, mark fully paid, edit, delete, over-payment', async ({ page }) => {
  test.skip(!migrationReady, 'Needs migration-033 (Batch 30 database update) — not applied yet.');
  test.setTimeout(120_000);
  const order = await newWebOrder();
  await setStatus(order.id, 'confirmed');
  const total = Number((await orderRow(order.id)).total);
  await openAdminOrder(page, order.id);
  const block = page.getByTestId('payment-block');
  await expect(block.getByTestId('payment-state')).toHaveText('Unpaid', { timeout: 15_000 });

  await block.getByRole('button', { name: 'Add payment' }).click();
  let sheet = page.getByRole('dialog', { name: 'Add payment' });
  await sheet.getByLabel('Amount (৳)').fill('300');
  await sheet.getByLabel('Transaction ID (optional)').fill('E2EB30A');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(block.getByTestId('payment-state')).toHaveText('Partly paid', { timeout: 15_000 });
  await expect(block.getByTestId('payment-due')).toHaveText(taka(total - 300));

  // The booking confirmation offers COD = what is due, not the total.
  await mockSteadfast(page, {});
  await page.getByRole('button', { name: 'Send to Steadfast' }).click();
  const confirm = page.getByRole('dialog', { name: 'Book with Steadfast?' });
  await expect(confirm).toContainText(`COD amount: ${taka(total - 300)}`);
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();

  await block.getByRole('button', { name: 'Add payment' }).click();
  sheet = page.getByRole('dialog', { name: 'Add payment' });
  await sheet.getByLabel('Amount (৳)').fill(String(total - 300));
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(block.getByTestId('payment-state')).toHaveText('Paid', { timeout: 15_000 });
  await expect(block.getByTestId('payment-due')).toHaveText(taka(0));
  expect((await orderRow(order.id)).payment_status).toBe('paid');

  // Delete one (Super Admin) → Partly paid again, logged.
  await block.getByRole('button', { name: `Delete payment ${taka(300)}` }).first().click();
  await page.getByRole('dialog', { name: 'Delete this payment?' }).getByRole('button', { name: 'Delete payment', exact: true }).click();
  await expect(block.getByTestId('payment-state')).toHaveText('Partly paid', { timeout: 15_000 });

  // Mark fully paid adds exactly what is due.
  await block.getByRole('button', { name: 'Mark fully paid' }).click();
  await page.getByRole('dialog', { name: 'Mark fully paid' }).getByRole('button', { name: 'Save' }).click();
  await expect(block.getByTestId('payment-state')).toHaveText('Paid', { timeout: 15_000 });

  // Edit one up → over-paid shown.
  await block.getByRole('button', { name: `Edit payment ${taka(300)}` }).first().click();
  sheet = page.getByRole('dialog', { name: 'Edit payment' });
  await sheet.getByLabel('Amount (৳)').fill('800');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(block.getByTestId('payment-overpaid')).toHaveText(`Over-paid ${taka(500)}`, { timeout: 15_000 });

  const notes = await historyNotes(order.id);
  expect(notes).toContain('Payment ৳300 (bKash, TrxID E2EB30A) added');
  expect(notes.some((n) => n.startsWith('Payment ৳300 (bKash, TrxID E2EB30A) deleted'))).toBe(true);
  expect(notes.some((n) => n.startsWith('Marked fully paid'))).toBe(true);
  expect(notes.some((n) => n.includes('changed: amount ৳300 → ৳800'))).toBe(true);
  const activity = await select<{ action: string }[]>(
    admin.accessToken,
    `activity_log?select=action&entity_id=eq.${order.id}&action=like.order.payment_*`
  );
  expect((activity.data ?? []).map((a) => a.action)).toEqual(
    expect.arrayContaining(['order.payment_added', 'order.payment_deleted', 'order.payment_changed'])
  );
});

test('Part 3: a payment on a booked order shows the new COD in the banner', async ({ page }) => {
  test.skip(!migrationReady, 'Needs migration-033 (Batch 30 database update) — not applied yet.');
  test.setTimeout(60_000);
  const order = await bookedOrder();
  const total = Number((await orderRow(order.id)).total);
  await rpc(admin.accessToken, 'admin_set_steadfast_cod', { p_order_id: order.id, p_amount: total });
  const pay = await rpc(admin.accessToken, 'admin_add_order_payment', { p_order_id: order.id, p_amount: 200, p_method: 'nagad' });
  expect(pay.ok, pay.error ?? '').toBe(true);
  await openAdminOrder(page, order.id);
  await expect(page.getByTestId('steadfast-banner-cod')).toContainText(`COD on Steadfast should now be ${taka(total - 200)}`, { timeout: 15_000 });
});

test('Part 3: a confirmed Steadfast delivery records "COD via Steadfast" once; approval pending records nothing', async () => {
  test.skip(!migrationReady, 'Needs migration-033 (Batch 30 database update) — not applied yet.');
  const order = await bookedOrder();
  const pending = await bookedOrder();
  const set = (id: string, status: string) =>
    rpc(admin.accessToken, 'admin_update_steadfast_status', { p_order_id: id, p_courier_status: status, p_mark_delivered: status === 'delivered' });
  expect((await set(pending.id, 'delivered_approval_pending')).ok).toBe(true);
  expect((await set(order.id, 'delivered')).ok).toBe(true);
  expect((await set(order.id, 'delivered')).ok).toBe(true);
  const cod = (id: string) => select<{ amount: number; method: string }[]>(admin.accessToken, `order_payments?select=amount,method&order_id=eq.${id}&source=eq.steadfast_cod`);
  const rows = (await cod(order.id)).data ?? [];
  expect(rows).toHaveLength(1);
  expect(rows[0].method).toBe('cod_steadfast');
  expect(Number(rows[0].amount)).toBe(Number((await orderRow(order.id)).total));
  expect((await orderRow(order.id)).payment_status).toBe('paid');
  expect((await cod(pending.id)).data ?? []).toHaveLength(0);
});

test('Part 3: an existing bKash advance TrxID shows as the first payment; Due filter; Customers due', async ({ page }) => {
  test.skip(!migrationReady, 'Needs migration-033 (Batch 30 database update) — not applied yet.');
  test.setTimeout(90_000);
  const placed = await rpc<{ order_id: string; order_number: string }[]>(customer.accessToken, 'place_order', {
    p_items: [{ product_id: product.id, variant_id: null, quantity: 1 }],
    p_full_name: 'E2E Test Customer',
    p_phone: '01712345678',
    p_division: 'Dhaka',
    p_district: 'Dhaka',
    p_thana: 'Gulshan',
    p_address_line: '123 Test Road (e2e)',
    p_delivery_zone: 'inside_dhaka',
    p_payment_method: 'bkash',
    p_bkash_trx_id: 'E2EB30TRX',
    p_bkash_sender: '01712345678',
  });
  expect(placed.ok, placed.error ?? '').toBe(true);
  const id = placed.data![0].order_id;
  createdOrderIds.push(id);
  await openAdminOrder(page, id);
  const block = page.getByTestId('payment-block');
  await expect(block).toContainText('bKash advance · TrxID E2EB30TRX', { timeout: 15_000 });
  await block.getByRole('button', { name: 'Confirm received' }).click();
  await expect(block.getByTestId('payment-row').first()).toContainText('bKash · TrxID E2EB30TRX', { timeout: 15_000 });
  await expect(block.getByTestId('payment-state')).toHaveText('Paid');

  // Due filter: a partly paid order is listed.
  const due = await newWebOrder();
  await rpc(admin.accessToken, 'admin_add_order_payment', { p_order_id: due.id, p_amount: 100, p_method: 'cash' });
  await page.goto('/admin?tab=orders&ostatus=due');
  await expect(page.getByTestId('order-row').filter({ hasText: due.orderNumber })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('order-row').filter({ hasText: due.orderNumber }).getByTestId('order-payment-cell')).toContainText('Partly paid');
  await expect(page.getByTestId('order-row').filter({ hasText: placed.data![0].order_number })).toHaveCount(0);

  // Customers: the test customer's due across their orders.
  const rows = await rpc<{ customer_key: string; profile_id: string | null; total_due: number }[]>(admin.accessToken, 'admin_customers_v2');
  const me = (rows.data ?? []).find((r) => r.profile_id === customer.userId);
  expect(Number(me?.total_due ?? 0)).toBeGreaterThan(0);
  await page.goto('/admin?tab=customers&csort=due');
  await expect(page.getByTestId('customer-row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('customer-due').first()).not.toHaveText('—');
});

/* ---------------------------------------------------------------- Part 4 */

test('Part 4: New order finds the customer by phone (+880 / spaces), fills name and last address; unknown → New customer', async ({ page }) => {
  test.skip(!migrationReady, 'Needs migration-033 (Batch 30 database update) — not applied yet.');
  test.setTimeout(120_000);
  const manual = await rpc<{ order_id: string }[]>(admin.accessToken, 'admin_create_order', {
    p_source: 'phone',
    p_items: [{ product_id: product.id, variant_id: null, quantity: 1 }],
    p_full_name: 'E2E B30 Phone Customer',
    p_phone: PHONE_CUSTOMER,
    p_division: 'Dhaka',
    p_district: 'Dhaka',
    p_thana: 'Mirpur',
    p_address_line: 'House 30, Road 3 (e2e)',
    p_delivery_zone: 'inside_dhaka',
    p_delivery_fee: 70,
  });
  expect(manual.ok, manual.error ?? '').toBe(true);
  createdOrderIds.push(manual.data![0].order_id);

  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=orders');
  await page.getByRole('button', { name: 'New order' }).click();
  const field = page.getByLabel('Customer', { exact: true });
  await field.fill('+880 1799 990030');
  const results = page.getByTestId('customer-results');
  await expect(results).toContainText('E2E B30 Phone Customer', { timeout: 15_000 });
  await results.getByRole('button', { name: /E2E B30 Phone Customer/ }).click();
  await expect(page.getByTestId('customer-picked')).toContainText('E2E B30 Phone Customer');
  await expect(page.locator('#manual-order-name')).toHaveValue('E2E B30 Phone Customer');
  await expect(page.locator('#manual-order-phone')).toHaveValue(PHONE_CUSTOMER);
  await expect(page.locator('#manual-order-thana')).toHaveText('Mirpur');
  await expect(page.locator('#manual-order-address')).toHaveValue('House 30, Road 3 (e2e)');

  // Save an order for them: it lands under the same customer.
  const form = page.getByRole('dialog', { name: 'New order' });
  await form.getByRole('button', { name: 'Phone call', exact: true }).click();
  await form.getByPlaceholder('Search product name...').fill(product.name.slice(0, 18));
  await form.locator('.picker-sheet__row').filter({ hasText: product.name }).first().click();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = page.getByText(/Order .* saved/);
  await expect(saved).toBeVisible({ timeout: 15_000 });
  const theirs = await rpc<{ id: string }[]>(admin.accessToken, 'admin_customer_orders_v2', { p_customer_key: `ph:${PHONE_CUSTOMER}` });
  for (const o of theirs.data ?? []) if (!createdOrderIds.includes(o.id)) createdOrderIds.push(o.id);
  expect(theirs.data?.length).toBe(2);

  // An unknown number → "New customer" with that phone.
  await page.goto('/admin?tab=orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await page.getByLabel('Customer', { exact: true }).fill('+880 1799 990031');
  await page.getByTestId('customer-results').getByRole('button', { name: /New customer/ }).click();
  await expect(page.getByTestId('customer-picked')).toContainText('New customer');
  await expect(page.locator('#manual-order-phone')).toHaveValue('+880 1799 990031');
});
