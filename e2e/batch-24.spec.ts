import { devices } from '@playwright/test';
import { test, expect } from './fixtures';
import { blockAdTracking } from './helpers/tracking';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_MOD_PASSWORD, E2E_PASSWORD } from './helpers/env';
import {
  callFunction,
  passwordSession,
  pickStockedProduct,
  placeTestOrder,
  productStock,
  rpc,
  select,
  update,
  upsertSettings,
  useSessionInPage,
  type TestSession,
} from './helpers/api';

// Batch 24: admin team, activity log, order number format, deleting orders
// with the Safety Lock, price edits, the customer's delivery status and the
// editable checkout text. Signs in as a dedicated TEST Super Admin (never
// Naeem's own account), a throwaway test moderator, and the usual test
// customer. Every order and the moderator are deleted again in afterAll,
// and the settings it touches are put back exactly as they were.

const MOD_USERNAME = 'e2e.mod';
const TEXT_TITLE = 'E2E title check';

test.describe.configure({ mode: 'serial' });

test.skip(
  !E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_MOD_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD,
  'Needs the Batch 24 test accounts in .env.e2e (see reports/batch-24.txt).'
);

let admin: TestSession;
let customer: TestSession;
let moderatorId = '';
let product: { id: string; name: string; stock: number };
const createdOrderIds: string[] = [];
let originalFormat: { prefix: string; next_number: number; suffix: string } | null = null;
let originalTexts: { key: string; value: string }[] = [];

async function freshAdmin(): Promise<TestSession> {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  return admin;
}

async function moderatorSession(): Promise<TestSession> {
  return passwordSession(`${MOD_USERNAME}@staff.naeems.internal`, E2E_MOD_PASSWORD);
}

async function setModerator(permissions: string[], disabled = false): Promise<void> {
  const res = await callFunction<{ ok: boolean; error?: string }>(admin.accessToken, 'admin-team', {
    action: 'update',
    userId: moderatorId,
    fullName: 'E2E Moderator',
    phone: '01700000000',
    permissions,
    disabled,
  });
  expect(res.ok, res.error).toBe(true);
}

async function newOrder(quantity = 1): Promise<{ id: string; orderNumber: string }> {
  const order = await placeTestOrder(customer.accessToken, product.id, quantity);
  createdOrderIds.push(order.id);
  return order;
}

async function setStatus(orderId: string, status: string): Promise<void> {
  const res = await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: orderId, p_new_status: status });
  expect(res.ok, res.error ?? '').toBe(true);
}

async function deleteAsAdmin(ids: string[]): Promise<{ order_id: string; deleted: boolean; reason: string | null }[]> {
  const res = await rpc<{ order_id: string; deleted: boolean; reason: string | null }[]>(
    admin.accessToken,
    'admin_delete_orders',
    { p_order_ids: ids }
  );
  expect(res.ok, res.error ?? '').toBe(true);
  return res.data ?? [];
}

test.beforeAll(async () => {
  await freshAdmin();
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(6);

  // A moderator left over from an interrupted run is removed first.
  const team = await rpc<{ id: string; username: string }[]>(admin.accessToken, 'admin_team_list');
  for (const member of team.data ?? []) {
    if (member.username === MOD_USERNAME) {
      await callFunction(admin.accessToken, 'admin-team', { action: 'delete', userId: member.id });
    }
  }

  const format = await rpc<{ prefix: string; next_number: number; suffix: string }[]>(
    admin.accessToken,
    'admin_order_number_info'
  );
  originalFormat = format.data?.[0] ?? null;
  const texts = await select<{ key: string; value: string }[]>(
    null,
    'app_settings?select=key,value&key=in.(text_checkout_signin_title,text_checkout_signin_message)'
  );
  originalTexts = texts.data ?? [];
});

test.afterAll(async () => {
  test.setTimeout(90_000);
  await freshAdmin();
  // Any order left (late-stage ones need the Safety Lock, opened for a
  // minute with a fresh password sign-in, then closed again).
  if (createdOrderIds.length > 0) {
    await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
    await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: createdOrderIds });
    await rpc(admin.accessToken, 'admin_close_delete_lock');
  }
  if (moderatorId) {
    await callFunction(admin.accessToken, 'admin-team', { action: 'delete', userId: moderatorId });
  }
  if (originalFormat) {
    const now = await rpc<{ next_number: number }[]>(admin.accessToken, 'admin_order_number_info');
    await rpc(admin.accessToken, 'admin_set_order_number_format', {
      p_prefix: originalFormat.prefix,
      p_next_number: now.data?.[0]?.next_number ?? originalFormat.next_number,
      p_suffix: originalFormat.suffix,
    });
  }
  const restore = ['text_checkout_signin_title', 'text_checkout_signin_message'].map((key) => ({
    key,
    value: originalTexts.find((t) => t.key === key)?.value ?? '',
  }));
  await upsertSettings(admin.accessToken, restore);
});

test('Super Admin adds a moderator with only "View orders"', async ({ page }) => {
  test.setTimeout(60_000);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=team');
  await page.getByRole('button', { name: 'Add moderator' }).first().click();

  const sheet = page.getByRole('dialog', { name: 'Add moderator' });
  await sheet.getByLabel('Username').fill(MOD_USERNAME);
  await sheet.getByLabel('Full name').fill('E2E Moderator');
  await sheet.getByLabel('Phone').fill('01700000000');
  await sheet.getByLabel('Password', { exact: true }).fill(E2E_MOD_PASSWORD);
  await sheet.getByRole('button', { name: 'Add moderator' }).click();
  await expect(page.getByText(`Moderator "${MOD_USERNAME}" added`)).toBeVisible({ timeout: 15_000 });

  await page.locator('.admin-order-row', { hasText: MOD_USERNAME }).click();
  const edit = page.getByRole('dialog', { name: `Moderator: ${MOD_USERNAME}` });
  // All permissions start OFF.
  for (const sw of await edit.getByRole('switch').all()) {
    await expect(sw).toHaveAttribute('aria-checked', 'false');
  }
  await edit.getByRole('switch', { name: 'View orders' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });

  const team = await rpc<{ id: string; username: string; permissions: string[] }[]>(admin.accessToken, 'admin_team_list');
  const member = team.data?.find((m) => m.username === MOD_USERNAME);
  expect(member).toBeTruthy();
  moderatorId = member!.id;
  expect(member!.permissions).toEqual(['view_orders']);
});

test('Staff login works, and the moderator sees only Orders', async ({ page }) => {
  await page.goto('/admin-access');
  await page.getByRole('tab', { name: 'Staff login' }).click();
  await page.getByLabel('Username').fill(MOD_USERNAME);
  await page.getByLabel('Password', { exact: true }).fill('wrong-password-123');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('alert')).toHaveText('Username or password is incorrect');

  await page.getByLabel('Password', { exact: true }).fill(E2E_MOD_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/admin/, { timeout: 15_000 });
  await expect(page.locator('.admin-nav__item').first()).toBeVisible();
  const labels = (await page.locator('.admin-nav__item .admin-nav__label').allInnerTexts()).map((t) =>
    t.replace(/\d+$/, '').trim()
  );
  expect(labels).toEqual(['Orders', 'My Profile']);
  await expect(page.locator('.admin-header__user')).toHaveText(MOD_USERNAME);
});

test('Direct API calls outside the moderator\'s permissions are refused', async () => {
  const mod = await moderatorSession();
  const order = await newOrder();

  // Allowed: reading orders.
  const read = await select<{ id: string }[]>(mod.accessToken, `orders?select=id&id=eq.${order.id}`);
  expect(read.data?.length).toBe(1);

  // Refused: changing a status.
  const status = await rpc(mod.accessToken, 'admin_set_order_status', { p_order_id: order.id, p_new_status: 'confirmed' });
  expect(status.ok).toBe(false);
  expect(status.error).toContain('Not authorized');

  // Refused: editing a product (no row is changed).
  const before = await productStock(product.id);
  const edit = await update<unknown[]>(mod.accessToken, `products?id=eq.${product.id}`, { stock_quantity: 999 });
  expect(edit.ok === false || (Array.isArray(edit.data) && edit.data.length === 0)).toBe(true);
  expect(await productStock(product.id)).toBe(before);

  // Refused: the Activity Log (nothing comes back), price edits, deleting,
  // the Team list, and the Safety Lock.
  const log = await select<unknown[]>(mod.accessToken, 'activity_log?select=id&limit=5');
  expect(log.data ?? []).toHaveLength(0);
  const items = await select<{ id: string }[]>(admin.accessToken, `order_items?select=id&order_id=eq.${order.id}`);
  const price = await rpc(mod.accessToken, 'admin_update_order_item_price', {
    p_item_id: items.data![0].id,
    p_new_unit_price: 1,
  });
  expect(price.error).toContain('Not authorized');
  const del = await rpc(mod.accessToken, 'admin_delete_orders', { p_order_ids: [order.id] });
  expect(del.error).toContain('Not authorized');
  const team = await rpc<unknown[]>(mod.accessToken, 'admin_team_list');
  expect(team.data ?? []).toHaveLength(0);
  const lock = await rpc(mod.accessToken, 'admin_open_delete_lock', { p_seconds: 5 });
  expect(lock.error).toContain('Not authorized');
  const teamFn = await callFunction<{ ok: boolean }>(mod.accessToken, 'admin-team', {
    action: 'update',
    userId: mod.userId,
    permissions: ['edit_products'],
  });
  expect(teamFn.ok).toBe(false);
});

test('Activity Log shows who did what, by username', async ({ page }) => {
  const adminName = (
    await select<{ username: string }[]>(admin.accessToken, `staff_members?select=username&id=eq.${admin.userId}`)
  ).data?.[0]?.username;
  expect(adminName).toBeTruthy();

  const rows = await select<{ actor_username: string; action: string; entity_label: string }[]>(
    admin.accessToken,
    `activity_log?select=actor_username,action,entity_label&entity_label=eq.${MOD_USERNAME}&order=id.desc&limit=20`
  );
  const actions = (rows.data ?? []).map((r) => `${r.actor_username}:${r.action}`);
  expect(actions).toContain(`${adminName}:team.moderator_added`);
  expect(actions).toContain(`${adminName}:team.permissions_changed`);
  expect(actions).toContain(`${MOD_USERNAME}:staff.login`);

  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=activity&lperson=${MOD_USERNAME}`);
  await expect(page.locator('.activity-row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.activity-row__who').first()).toHaveText(MOD_USERNAME);
  await expect(page.locator('.activity-row', { hasText: 'Signed in' }).first()).toBeVisible();

  // Back keeps the filter (it lives in the URL).
  await page.goto('/');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`lperson=${MOD_USERNAME.replace('.', '\\.')}`));
});

test('Order number preview, and the next order uses it', async ({ page }) => {
  test.setTimeout(60_000);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=settings');
  const preview = page.getByTestId('order-number-preview');
  await expect(preview).toContainText('Next order will be:', { timeout: 15_000 });
  const before = await rpc<{ prefix: string; next_number: number; suffix: string }[]>(admin.accessToken, 'admin_order_number_info');
  const format = before.data![0];
  await expect(preview).toContainText(`${format.prefix}${format.next_number}${format.suffix}`);

  const panel = page.locator('.admin-panel', { hasText: 'Orders: order number' });
  // The next number can never go down.
  await page.getByLabel('Next number').fill(String(format.next_number - 1));
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/can only go up/).first()).toBeVisible();
  const down = await rpc(admin.accessToken, 'admin_set_order_number_format', {
    p_prefix: format.prefix,
    p_next_number: format.next_number - 1,
    p_suffix: format.suffix,
  });
  expect(down.error).toContain('can only go up');

  await page.getByLabel('Next number').fill(String(format.next_number));
  await page.getByLabel('Suffix').fill('-T');
  const expected = `${format.prefix}${format.next_number}-T`;
  await expect(preview).toContainText(`Next order will be: ${expected}`);
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Order number format saved')).toBeVisible({ timeout: 15_000 });

  const order = await newOrder();
  expect(order.orderNumber).toBe(expected);

  const restore = await rpc(admin.accessToken, 'admin_set_order_number_format', {
    p_prefix: format.prefix,
    p_next_number: format.next_number + 1,
    p_suffix: format.suffix,
  });
  expect(restore.ok, restore.error ?? '').toBe(true);
});

test('Deleting an order restores its stock', async ({ page }) => {
  test.setTimeout(60_000);
  const before = await productStock(product.id);
  const order = await newOrder(2);
  expect(await productStock(product.id)).toBe(before - 2);

  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=orders&order=${order.id}`);
  await page.getByRole('button', { name: 'Delete order' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete order ${order.orderNumber}?` });
  await expect(dialog).toContainText('Stock for the items will be put back');
  await dialog.getByRole('button', { name: 'Delete order' }).click();
  await expect(page.getByText(`Order ${order.orderNumber} deleted`)).toBeVisible({ timeout: 15_000 });

  expect(await productStock(product.id)).toBe(before);
  const gone = await select<unknown[]>(admin.accessToken, `orders?select=id&id=eq.${order.id}`);
  expect(gone.data).toHaveLength(0);
  // Recorded with the order number, customer and total.
  const log = await select<{ action: string; details: { customer_name: string; total: number } }[]>(
    admin.accessToken,
    `activity_log?select=action,details&action=eq.order.deleted&entity_label=eq.${order.orderNumber}`
  );
  expect(log.data?.[0]?.details.customer_name).toBe('E2E Test Customer');
});

test('Safety Lock: a shipped order cannot be deleted until the lock is off, and the lock turns itself back on', async ({ page }) => {
  test.setTimeout(90_000);
  const shipped = await newOrder();
  await setStatus(shipped.id, 'confirmed');
  await setStatus(shipped.id, 'shipped');

  // Locked, even for the Super Admin, even straight through the API.
  let result = await deleteAsAdmin([shipped.id]);
  expect(result[0].deleted).toBe(false);
  expect(result[0].reason).toContain('Locked');

  // The order screen shows why.
  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=orders&order=${shipped.id}`);
  await expect(page.getByText("Locked: turn on 'Allow deleting orders at any stage' in Safety Locks.")).toBeVisible({
    timeout: 15_000,
  });

  // Turning it off needs a fresh password sign-in (a short test window of
  // 6 seconds instead of 15 minutes).
  await freshAdmin();
  const opened = await rpc<string>(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 6 });
  expect(opened.ok, opened.error ?? '').toBe(true);

  const stockBefore = await productStock(product.id);
  result = await deleteAsAdmin([shipped.id]);
  expect(result[0].deleted).toBe(true);
  expect(await productStock(product.id)).toBe(stockBefore + 1);

  // Another shipped order, after the window has passed: locked again.
  const later = await newOrder();
  await setStatus(later.id, 'confirmed');
  await setStatus(later.id, 'shipped');
  await page.waitForTimeout(7_000);
  result = await deleteAsAdmin([later.id]);
  expect(result[0].deleted).toBe(false);
  const until = await rpc<string | null>(admin.accessToken, 'admin_delete_lock_until');
  expect(until.data).toBeNull();

  // Both switches were recorded.
  const log = await select<{ action: string }[]>(
    admin.accessToken,
    `activity_log?select=action&action=like.safety.*&actor_id=eq.${admin.userId}&order=id.desc&limit=3`
  );
  expect((log.data ?? []).map((r) => r.action)).toContain('safety.delete_lock_off');
});

test('A moderator with "Delete early orders" can delete a Pending order but not a Confirmed one', async () => {
  await setModerator(['view_orders', 'delete_early_orders']);
  const mod = await moderatorSession();
  const pending = await newOrder();
  const confirmed = await newOrder();
  await setStatus(confirmed.id, 'confirmed');

  const res = await rpc<{ order_id: string; deleted: boolean; reason: string | null }[]>(
    mod.accessToken,
    'admin_delete_orders',
    { p_order_ids: [pending.id, confirmed.id] }
  );
  expect(res.ok, res.error ?? '').toBe(true);
  const byId = new Map((res.data ?? []).map((r) => [r.order_id, r]));
  expect(byId.get(pending.id)?.deleted).toBe(true);
  expect(byId.get(confirmed.id)?.deleted).toBe(false);
});

test('Price edit recalculates the total; a moderator cannot do it', async ({ page }) => {
  test.setTimeout(60_000);
  const order = await newOrder(2);
  const [row] = (
    await select<{ total: number; delivery_fee: number }[]>(admin.accessToken, `orders?select=total,delivery_fee&id=eq.${order.id}`)
  ).data!;

  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=orders&order=${order.id}`);
  await page.getByRole('button', { name: `Edit price of ${product.name}` }).click();
  await page.getByLabel('Unit price (৳)').fill('100');
  await page.locator('.order-item-price').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Price saved, total updated')).toBeVisible({ timeout: 15_000 });

  const [after] = (
    await select<{ total: number; subtotal: number }[]>(admin.accessToken, `orders?select=total,subtotal&id=eq.${order.id}`)
  ).data!;
  expect(Number(after.subtotal)).toBe(200);
  expect(Number(after.total)).toBe(200 + Number(row.delivery_fee));

  const history = await select<{ note: string; changed_by_username: string }[]>(
    admin.accessToken,
    `order_status_history?select=note,changed_by_username&order_id=eq.${order.id}&note=like.Price*`
  );
  expect(history.data?.[0]?.note).toContain('→ ৳100');

  const mod = await moderatorSession();
  const items = await select<{ id: string }[]>(admin.accessToken, `order_items?select=id&order_id=eq.${order.id}`);
  const refused = await rpc(mod.accessToken, 'admin_update_order_item_price', {
    p_item_id: items.data![0].id,
    p_new_unit_price: 0,
  });
  expect(refused.error).toContain('Not authorized');
});

test('The customer sees a friendly delivery status, for their own orders only', async ({ page }) => {
  test.setTimeout(60_000);
  const order = await newOrder();
  await setStatus(order.id, 'confirmed');
  await setStatus(order.id, 'shipped');
  const courier = await rpc(admin.accessToken, 'admin_update_steadfast_status', {
    p_order_id: order.id,
    p_courier_status: 'pending',
    p_mark_delivered: false,
  });
  expect(courier.ok, courier.error ?? '').toBe(true);

  // An order that is not theirs (a manual order with no account linked).
  const manual = await rpc<{ order_id: string }[]>(admin.accessToken, 'admin_create_order', {
    p_source: 'phone',
    p_items: [{ product_id: product.id, variant_id: null, quantity: 1 }],
    p_full_name: 'E2E Someone Else',
    p_phone: '01799999999',
    p_division: 'Dhaka',
    p_district: 'Dhaka',
    p_thana: 'Gulshan',
    p_address_line: 'Not the test customer (e2e)',
    p_delivery_zone: 'inside_dhaka',
    p_delivery_fee: 70,
  });
  expect(manual.ok, manual.error ?? '').toBe(true);
  const manualId = manual.data![0].order_id;
  createdOrderIds.push(manualId);

  const foreign = await select<unknown[]>(customer.accessToken, `orders?select=id&id=eq.${manualId}`);
  expect(foreign.data).toHaveLength(0);

  await useSessionInPage(page, customer);
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId('delivery-status')).toHaveText('On the way', { timeout: 15_000 });
  await expect(page.locator('.delivery-progress')).toContainText('Last update');
  await expect(page.locator('.order-timeline__step--reached')).toHaveCount(4);
  await expect(page.getByText('Track parcel on Steadfast →')).toHaveCount(0);

  await page.goto(`/orders/${manualId}`);
  await expect(page.getByText('Order not found')).toBeVisible({ timeout: 15_000 });
});

test('The checkout sign-in note can be edited, and reset to default', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=settings');
  const texts = page.locator('.admin-panel', { hasText: 'Checkout sign-in note' });
  await texts.getByLabel('Title').fill(TEXT_TITLE);
  await texts.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Text saved')).toBeVisible({ timeout: 15_000 });

  const checkoutTitle = async (): Promise<string> => {
    const context = await browser.newContext({
      ...devices['Pixel 7'],
      baseURL: test.info().project.use.baseURL,
    });
    const shopper = await context.newPage();
    await blockAdTracking(shopper);
    await shopper.goto('/');
    await shopper.waitForSelector('.product-card');
    await shopper.getByRole('button', { name: /^Add .* to cart$/ }).first().click();
    await shopper.goto('/cart');
    await shopper.getByRole('button', { name: 'Checkout' }).click();
    const title = (await shopper.locator('.sheet-title').first().innerText()).trim();
    await context.close();
    return title;
  };

  expect(await checkoutTitle()).toBe(TEXT_TITLE);

  await texts.getByRole('button', { name: 'Reset to default' }).click();
  await expect(page.getByText('Back to the default text')).toBeVisible({ timeout: 15_000 });
  expect(await checkoutTitle()).toBe('Almost done!');
});

test('Disabling the moderator blocks them straight away', async ({ page }) => {
  test.setTimeout(60_000);
  const modBefore = await moderatorSession();

  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=team');
  await page.locator('.admin-order-row', { hasText: MOD_USERNAME }).click();
  const edit = page.getByRole('dialog', { name: `Moderator: ${MOD_USERNAME}` });
  await edit.getByRole('switch', { name: 'Disabled' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });

  // The login they already had stops working on their next action.
  const can = await rpc<boolean>(modBefore.accessToken, 'staff_can', { p_perm: 'view_orders' });
  expect(can.data).toBe(false);
  const orders = await select<unknown[]>(modBefore.accessToken, 'orders?select=id&limit=1');
  expect(orders.data ?? []).toHaveLength(0);

  // And they cannot sign in again.
  await expect(moderatorSession()).rejects.toThrow();
});
