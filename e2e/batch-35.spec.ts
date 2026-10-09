import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import {
  passwordSession,
  pickStockedProduct,
  placeTestOrder,
  rpc,
  select,
  upsertSettings,
  useSessionInPage,
  type TestSession,
} from './helpers/api';
import { STEADFAST_FUNCTION, mockSteadfast, type MockTracking } from './helpers/steadfastMock';

// Batch 35: order tracking for the customer, the order as a page and
// lighter lists for the admin, one set of status names, and the small
// fixes (greeting, ৳ in money fields, product photo, image saving).
// Steadfast is ALWAYS mocked — nothing is booked, cancelled or changed on
// Steadfast. Orders are test orders of the test customer, deleted in
// afterAll. The "Show rider's phone" switch is never changed for real: the
// page is shown it On by changing the answer it receives.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');

let admin: TestSession;
let customer: TestSession;
let product: { id: string; name: string; stock: number };
const createdOrderIds: string[] = [];

/** Steadfast's real wording (read from live answers, Batch 35). */
const CREATED = { text: 'Consignment created by Sender(API).', at: '2026-10-07T09:00:00Z' };
const PICKED = { text: 'Consignment status has been updated as Pending', at: '2026-10-07T12:00:00Z' };
const INTERNAL = { text: "Changes: COD '4079' to '0'. By User Naeem(1380201)", at: '2026-10-07T13:00:00Z' };
const TO_SORTING = { text: 'Consignment sent to MIRPUR WAREHOUSE.  Dispatch ID: 18085103', at: '2026-10-07T15:00:00Z' };
const AT_HUB = { text: 'Consignment has been received at PALLABI.', at: '2026-10-08T03:00:00Z' };
const RIDER = { text: 'Assigned to rider.', at: '2026-10-08T05:00:00Z' };
const DELIVERED = { text: 'Consignment marked as delivered by rider.', at: '2026-10-08T09:00:00Z' };

async function freshAdmin(): Promise<void> {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
}

async function newOrder(): Promise<{ id: string; orderNumber: string }> {
  const order = await placeTestOrder(customer.accessToken, product.id, 1);
  createdOrderIds.push(order.id);
  return order;
}

async function setStatus(orderId: string, status: string): Promise<void> {
  const res = await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: orderId, p_new_status: status });
  expect(res.ok, res.error ?? '').toBe(true);
}

/** "Booked" with a made-up consignment id — the database only. */
async function bookedOrder(courierStatus: string): Promise<{ id: string; orderNumber: string }> {
  const order = await newOrder();
  await setStatus(order.id, 'confirmed');
  const res = await rpc(admin.accessToken, 'admin_record_steadfast_shipment', {
    p_order_id: order.id,
    p_consignment_id: `E2E-B35-${Date.now()}`,
    p_tracking_code: 'E2EB35',
    p_tracking_link: '',
    p_courier_status: courierStatus,
  });
  expect(res.ok, res.error ?? '').toBe(true);
  return order;
}

/** Shows the customer the "Show rider's phone" switch as On (the real
 *  setting is not touched). */
async function riderSettingOn(page: Page): Promise<void> {
  const real = await select<{ key: string; value: string }[]>(null, 'app_settings?select=key,value');
  const rows = (real.data ?? []).filter((r) => r.key !== 'show_rider_phone');
  rows.push({ key: 'show_rider_phone', value: 'true' });
  await page.route(/\/rest\/v1\/app_settings\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(rows) })
  );
}

async function openCustomerOrder(page: Page, orderId: string, tracking: MockTracking | null = null): Promise<void> {
  await page.unroute(STEADFAST_FUNCTION);
  await mockSteadfast(page, { tracking });
  await useSessionInPage(page, customer);
  await page.goto(`/orders/${orderId}`);
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  await expect(page.getByTestId('order-tracking')).toBeVisible({ timeout: 15_000 });
}

async function stepStates(page: Page): Promise<string[]> {
  return page.locator('.ot-step').evaluateAll((els) =>
    els.map((el) => (el.classList.contains('ot-step--done') ? 'done' : el.classList.contains('ot-step--current') ? 'current' : 'upcoming'))
  );
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  await freshAdmin();
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(10);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await freshAdmin();
  if (createdOrderIds.length > 0) {
    await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
    await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: createdOrderIds });
    await rpc(admin.accessToken, 'admin_close_delete_lock');
  }
});

/* ---------------------------------------------------------------- Part 2 */

test('Part 2: Processing — Order placed is current, expected date, pay on delivery', async ({ page }) => {
  const order = await newOrder();
  await page.setViewportSize({ width: 360, height: 780 });
  await openCustomerOrder(page, order.id);
  await expect(page.getByRole('heading', { name: `Order ${order.orderNumber}` })).toBeVisible();
  await expect(page.locator('.ot-track__label')).toHaveText('Expected delivery');
  await expect(page.getByTestId('tracking-headline')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}( [A-Z][a-z]{2})? – [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
  await expect(page.getByTestId('delivery-status')).toHaveText('Order placed');
  expect(await stepStates(page)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  await expect(page.getByTestId('payment-pill')).toHaveText(/^Pay on delivery: ৳[\d,]+$/);
  await expect(page.getByTestId('payment-pill')).toHaveClass(/ot-pill--amber/);
  await expect(page.locator('.ot-step__sentence')).toHaveText('We received your order.');
  // The current step: a 48 px orange circle; done/upcoming 36 px.
  const current = await page.locator('.ot-step__circle--current').boundingBox();
  expect(Math.round(current?.width ?? 0)).toBe(48);
  const upcoming = await page.locator('.ot-step__circle--upcoming').first().boundingBox();
  expect(Math.round(upcoming?.width ?? 0)).toBe(36);
  // WhatsApp help carries the order number.
  await expect(page.getByTestId('chat-whatsapp')).toHaveAttribute('data-href', new RegExp(encodeURIComponent(order.orderNumber)));
  await noSideScroll(page);
});

test('Part 2: Confirmed — one done step, Confirmed current', async ({ page }) => {
  const order = await newOrder();
  await setStatus(order.id, 'confirmed');
  await openCustomerOrder(page, order.id);
  await expect(page.getByTestId('delivery-status')).toHaveText('Confirmed');
  expect(await stepStates(page)).toEqual(['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
  await expect(page.locator('.ot-step--done .ot-step__tick')).toHaveCount(1);
  await expect(page.locator('.ot-step__sentence')).toHaveText('We checked your order and packed it.');
});

test('Part 2: In transit — friendly courier words, internal edits never shown, reached your area', async ({ page }) => {
  const order = await bookedOrder('pending');
  await openCustomerOrder(page, order.id, { courierStatus: 'pending', events: [CREATED, PICKED, INTERNAL, TO_SORTING, AT_HUB] });
  await expect(page.getByTestId('delivery-status')).toHaveText('In transit');
  expect(await stepStates(page)).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
  await expect(page.locator('.ot-step__sentence')).toHaveText('Your parcel has reached your area. Almost there!');
  await expect(page.getByTestId('order-step-latest')).toContainText('Arrived at Pallabi delivery hub');
  await expect(page.locator('body')).not.toContainText('By User');
  await expect(page.locator('body')).not.toContainText('Dispatch ID');

  // See all updates opens inline, lists the courier updates, and closes.
  await page.getByTestId('toggle-updates').click();
  const all = page.getByTestId('all-updates');
  await expect(all).toBeVisible();
  await expect(page.getByTestId('toggle-updates')).toHaveText(/Hide updates/);
  await expect(all.getByTestId('courier-update')).toContainText([
    'Arrived at Pallabi delivery hub',
    'On the way to the Mirpur sorting centre',
    'Picked up by Steadfast',
    'Handed to Steadfast',
  ]);
  await expect(all.locator('.ot-all__card--upcoming')).toHaveCount(2);
  await expect(all).not.toContainText('COD');
  await page.getByTestId('toggle-updates').click();
  await expect(page.getByTestId('all-updates')).toHaveCount(0);
  await expect(page.locator('.order-detail__tracking-link')).toHaveText(/Track on Steadfast/);
});

test('Part 2: Out for delivery — "Today", no rider row unless the setting is On and Steadfast names the rider', async ({ page }) => {
  const order = await bookedOrder('pending');
  const events = [CREATED, TO_SORTING, AT_HUB, RIDER];
  await openCustomerOrder(page, order.id, { courierStatus: 'pending', events, rider: { name: 'Md. Karim', phone: '01711111111' } });
  await expect(page.getByTestId('delivery-status')).toHaveText('Out for delivery');
  await expect(page.getByTestId('tracking-headline')).toHaveText('Today');
  await expect(page.locator('.ot-step__sentence')).toHaveText('Your rider is on the way. Please keep your phone nearby.');
  // Setting Off (the default): nothing about the rider.
  await expect(page.getByTestId('rider-row')).toHaveCount(0);

  // Setting On + rider named → the row with a Call button.
  await riderSettingOn(page);
  await openCustomerOrder(page, order.id, { courierStatus: 'pending', events, rider: { name: 'Md. Karim', phone: '01711111111' } });
  await expect(page.getByTestId('rider-row')).toContainText('Your rider: Md. Karim');
  await expect(page.getByTestId('rider-row').getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:+8801711111111');
  // Never in the update list.
  await page.getByTestId('toggle-updates').click();
  await expect(page.getByTestId('all-updates')).not.toContainText('Karim');

  // Setting On but Steadfast names no rider → nothing.
  await openCustomerOrder(page, order.id, { courierStatus: 'pending', events, rider: null });
  await expect(page.getByTestId('rider-row')).toHaveCount(0);
});

test('Part 2: Delivered — green, every earlier step filled, delivered date', async ({ page }) => {
  const order = await bookedOrder('pending');
  // No "Assigned to rider" update at all: Out for delivery still fills.
  await openCustomerOrder(page, order.id, { courierStatus: 'delivered', events: [CREATED, TO_SORTING, DELIVERED] });
  await expect(page.getByTestId('delivery-status')).toHaveText('Delivered');
  expect(await stepStates(page)).toEqual(['done', 'done', 'done', 'done', 'current']);
  await expect(page.locator('.ot-step__circle--delivered')).toHaveCount(1);
  const bg = await page.locator('.ot-step__circle--delivered').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toMatch(/255, 122, 69/);
  await expect(page.locator('.ot-track__label')).toHaveText('Delivered');
  await expect(page.getByTestId('tracking-headline')).toHaveText(/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}$/);
});

test('Part 2: Cancelled — calm line, no steps, no payment pill', async ({ page }) => {
  const order = await newOrder();
  await setStatus(order.id, 'cancelled');
  await openCustomerOrder(page, order.id);
  await expect(page.getByTestId('order-ended')).toContainText('This order was cancelled. Questions? Chat with us.');
  await expect(page.locator('.ot-track__label')).toHaveText('Cancelled');
  await expect(page.locator('.ot-step')).toHaveCount(0);
  await expect(page.getByTestId('payment-pill')).toHaveCount(0);
});

test('Part 2: 360 px dark mode — no sideways scroll, readable grey', async ({ page }) => {
  const order = await bookedOrder('pending');
  await page.setViewportSize({ width: 360, height: 780 });
  await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'));
  await openCustomerOrder(page, order.id, { courierStatus: 'pending', events: [CREATED, TO_SORTING, AT_HUB] });
  await page.getByTestId('toggle-updates').click();
  await noSideScroll(page);
  const grey = await page.locator('.ot-track__label').evaluate((el) => getComputedStyle(el).color);
  // #98989D in dark mode — light enough on black.
  expect(grey).toBe('rgb(152, 152, 157)');
});

test('Part 2: My orders uses the same names and colours', async ({ page }) => {
  const order = await newOrder();
  await useSessionInPage(page, customer);
  await page.goto('/orders');
  const row = page.locator('.orders-list__row').filter({ hasText: order.orderNumber });
  await expect(row.getByTestId('order-status-pill')).toHaveText('Order placed', { timeout: 15_000 });
  await expect(row.getByTestId('order-status-pill')).toHaveClass(/track-pill--amber/);
});

/* ---------------------------------------------------------------- Part 3 */

async function openAdminOrderPage(page: Page, orderNumber: string): Promise<Locator> {
  await useSessionInPage(page, admin);
  await page.goto(`/admin/orders/${orderNumber}`);
  const pageEl = page.getByTestId('admin-order-page');
  await expect(pageEl.getByTestId('order-step-label')).toBeVisible({ timeout: 15_000 });
  return pageEl;
}

test('Part 3: an order opens as its own page (also after refresh), no pop-up; Back keeps the list', async ({ page }) => {
  test.setTimeout(60_000);
  const order = await newOrder();
  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=orders&oq=${order.orderNumber}`);
  const row = page.getByTestId('order-row').filter({ hasText: order.orderNumber });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/admin/orders/${order.orderNumber}$`));
  await expect(page.getByTestId('admin-order-page')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('admin-order-page').getByTestId('order-step-label')).toHaveText('Processing', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Back to orders' }).click();
  await expect(page).toHaveURL(new RegExp(`tab=orders&oq=${order.orderNumber}`));
  await expect(page.getByTestId('order-row').filter({ hasText: order.orderNumber })).toBeVisible();

  // An old ?order=<id> link (Telegram) lands on the order's page.
  await page.goto(`/admin?tab=orders&order=${order.id}`);
  await expect(page).toHaveURL(new RegExp(`/admin/orders/${order.orderNumber}$`), { timeout: 15_000 });
});

test('Part 3: the one main action follows the status; every other action is still there', async ({ page }) => {
  test.setTimeout(60_000);
  const order = await newOrder();
  let el = await openAdminOrderPage(page, order.orderNumber);
  await expect(el.getByRole('button', { name: 'Confirm order' })).toBeVisible();
  for (const name of ['Invoice', 'Cancel order', 'Copy address', 'Call', 'WhatsApp', 'Profile']) {
    await expect(el.getByRole(name === 'Call' || name === 'WhatsApp' ? 'link' : 'button', { name, exact: true }).first()).toBeVisible();
  }
  await expect(el.getByTestId('edit-order')).toBeVisible();
  await el.getByRole('button', { name: 'Confirm order' }).click();
  await expect(el.getByTestId('order-step-label')).toHaveText('Confirmed', { timeout: 15_000 });
  await expect(el.getByRole('button', { name: 'Book with Steadfast' })).toBeVisible();
  await expect(el.getByRole('button', { name: 'Mark In transit (other courier)' })).toBeVisible();

  // History is folded until tapped.
  await expect(el.locator('.order-admin-detail__history')).toHaveCount(0);
  await el.getByTestId('history-toggle').click();
  await expect(el.locator('.order-admin-detail__history')).toContainText('Processing → Confirmed');

  // Booked: no orange main button any more.
  const booked = await bookedOrder('pending');
  await mockSteadfast(page, { tracking: { courierStatus: 'pending', events: [CREATED, AT_HUB, RIDER] } });
  el = await openAdminOrderPage(page, booked.orderNumber);
  await expect(el.getByTestId('order-step-label')).toHaveText('Out for delivery', { timeout: 15_000 });
  await expect(el.locator('.adm-btn--primary')).toHaveCount(0);
  await expect(el.getByRole('button', { name: 'Check delivery status' })).toBeVisible();
  await expect(el.getByRole('button', { name: 'Mark Delivered' })).toBeVisible();

  // The pen opens the edit page.
  await el.getByTestId('edit-order').click();
  await expect(page).toHaveURL(new RegExp(`/admin/orders/${booked.orderNumber}/edit$`));
});

/* ---------------------------------------------------------------- Part 4 */

test('Part 4: one status pill per row, money pill only when owed, phone search finds the order', async ({ page }) => {
  test.setTimeout(60_000);
  const order = await newOrder();
  const phone = (await select<{ customer_phone: string }[]>(admin.accessToken, `orders?select=customer_phone&id=eq.${order.id}`)).data![0]
    .customer_phone;
  const digits = phone.replace(/\D/g, '').slice(-10);
  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=orders&oq=${encodeURIComponent(`+880 ${digits}`)}`);
  const row = page.getByTestId('order-row').filter({ hasText: order.orderNumber });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByTestId('order-status-pill')).toHaveCount(1);
  await expect(row.getByTestId('order-status-pill')).toHaveText('Processing');
  await expect(row.getByTestId('order-money-pill')).toHaveText(/^COD ৳[\d,]+$/);
  await expect(page.getByPlaceholder('Search order, name or phone')).toBeVisible();
  for (const chip of ['All', 'To confirm', 'With courier']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${chip}`) }).first()).toBeVisible();
  }

  // Fully paid: no money pill.
  await rpc(admin.accessToken, 'admin_mark_order_fully_paid', { p_order_id: order.id, p_method: 'cash', p_trx_id: null, p_note: 'E2E batch 35' });
  await page.reload();
  await expect(row.getByTestId('order-status-pill')).toBeVisible({ timeout: 15_000 });
  await expect(row.getByTestId('order-money-pill')).toHaveCount(0);

  // Customers: the phone is not on the row, but searching by it works.
  await page.goto(`/admin?tab=customers&cq=${encodeURIComponent(`0${digits}`)}`);
  await expect(page.getByTestId('customer-row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('customer-row').first()).not.toContainText(digits);
  await expect(page.getByPlaceholder('Search name or phone')).toBeVisible();
});

/* ---------------------------------------------------------------- Part 5 */

for (const [utc, expected] of [
  ['2026-10-08T22:00:00Z', 'Hello'], // 04:00 Dhaka
  ['2026-10-09T03:00:00Z', 'Good morning'], // 09:00
  ['2026-10-09T08:00:00Z', 'Good afternoon'], // 14:00
  ['2026-10-09T14:00:00Z', 'Good evening'], // 20:00
] as const) {
  test(`Part 5: greeting at ${utc} (Dhaka) → ${expected}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(utc));
    await useSessionInPage(page, admin);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1 }).first()).toHaveText(new RegExp(`^${expected}, `), { timeout: 15_000 });
  });
}

/* ---------------------------------------------------------------- Part 6 */

test("Part 6: \"Show rider's phone\" is Off by default and only the Super Admin can change it", async ({ page }) => {
  const stored = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.show_rider_phone');
  expect(['false', undefined]).toContain(stored.data?.[0]?.value);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=settings&sset=delivery');
  const sw = page.getByTestId('rider-phone-switch');
  await expect(sw).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await expect(page.getByText('Only while the order is Out for delivery.')).toBeVisible();

  // Anyone else (here the shop's test customer) is refused by the database.
  const refused = await upsertSettings(customer.accessToken, [{ key: 'show_rider_phone', value: 'true' }]);
  expect(refused.ok).toBe(false);
  const after = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.show_rider_phone');
  expect(after.data?.[0]?.value).not.toBe('true');
});

/* ---------------------------------------------------------------- Part 7 */

/** Every ৳ sign sits fully to the left of where its number starts. */
async function moneyFieldsClear(page: Page): Promise<number> {
  const fields = page.locator('[data-testid="money-input"]:visible');
  const count = await fields.count();
  for (let i = 0; i < count; i += 1) {
    const gap = await fields.nth(i).evaluate((wrap) => {
      const sign = wrap.querySelector('.money-input__sign') as HTMLElement;
      const input = wrap.querySelector('input') as HTMLInputElement;
      const s = sign.getBoundingClientRect();
      const r = input.getBoundingClientRect();
      const css = getComputedStyle(input);
      const textStart = r.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
      return textStart - s.right;
    });
    expect(gap).toBeGreaterThanOrEqual(2);
  }
  return count;
}

test('Part 7: in every money field the number starts to the right of the ৳', async ({ page }) => {
  test.setTimeout(90_000);
  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${product.id}/edit`);
  await expect(page.locator('#pf-retail')).toBeVisible({ timeout: 20_000 });
  expect(await moneyFieldsClear(page)).toBeGreaterThanOrEqual(3);

  await page.goto('/admin?tab=settings&sset=payment');
  await expect(page.locator('#settings-fee-inside')).toBeVisible({ timeout: 15_000 });
  expect(await moneyFieldsClear(page)).toBe(2);

  await page.goto('/admin/orders/new');
  await expect(page.locator('#manual-order-discount')).toBeVisible({ timeout: 15_000 });
  expect(await moneyFieldsClear(page)).toBeGreaterThanOrEqual(2);

  const order = await newOrder();
  await page.goto(`/admin/orders/${order.orderNumber}/edit`);
  await expect(page.locator('#edit-order-fee')).toBeVisible({ timeout: 15_000 });
  expect(await moneyFieldsClear(page)).toBeGreaterThanOrEqual(3);

  await page.goto('/admin?tab=promo-codes');
  await page.getByRole('button', { name: 'Add code' }).click();
  await expect(page.locator('#promo-discount-amount')).toBeVisible();
  expect(await moneyFieldsClear(page)).toBe(1);
});

/* ---------------------------------------------------------------- Part 8 */

async function openProductPage(page: Page, width: number, theme: 'light' | 'dark'): Promise<void> {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 860 });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  const slug = (await select<{ slug: string }[]>(null, `products_view?select=slug&id=eq.${product.id}`)).data?.[0]?.slug ?? product.id;
  await page.goto(`/product/${slug}`);
  await expect(page.locator('.product-detail__image').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.product-detail__backdrop--on')).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(900);
}

/** The colour of one screen pixel. */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const shot = PNG.sync.read(await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } }));
  return [shot.data[0], shot.data[1], shot.data[2]];
}

function parseRgb(css: string): [number, number, number] {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 6);

for (const width of [360, 390, 430, 1280]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`Part 8: whole square photo, blurred photo colour at the sheet corners — ${width} px ${theme}`, async ({ page }) => {
      await openProductPage(page, width, theme);
      const photo = (await page.locator('.product-detail__image').first().boundingBox())!;
      const sheet = (await page.getByTestId('pdp-sheet').boundingBox())!;
      const gallery = (await page.locator('.product-detail__gallery').boundingBox())!;
      // The square photo ends exactly where the sheet starts — never under it.
      expect(Math.abs(photo.width - photo.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(photo.y + photo.height - sheet.y)).toBeLessThanOrEqual(1);
      // The photo area is the square + 24 px, and the sheet overlaps only that.
      expect(Math.round(gallery.y + gallery.height - sheet.y)).toBe(24);

      // Both rounded corners show the blurred photo, not the page colour.
      const pageBg = parseRgb(await page.locator('.pdp-shell').evaluate((el) => getComputedStyle(el).backgroundColor));
      const left = await pixel(page, sheet.x + 2, sheet.y + 3);
      const right = await pixel(page, sheet.x + sheet.width - 3, sheet.y + 3);
      expect(near(left, pageBg), `left corner ${left} vs page ${pageBg}`).toBe(false);
      expect(near(right, pageBg), `right corner ${right} vs page ${pageBg}`).toBe(false);
      expect(near(left, [255, 255, 255]) && theme === 'dark').toBe(false);

      // Dark mode: the page and the photo area underneath are dark.
      if (theme === 'dark') {
        const galleryBg = parseRgb(await page.locator('.product-detail__gallery').evaluate((el) => getComputedStyle(el).backgroundColor));
        expect(Math.max(...pageBg)).toBeLessThan(60);
        expect(Math.max(...galleryBg)).toBeLessThan(60);
      }
    });
  }
}

test('Part 8: the blurred layer follows a swipe to the next photo', async ({ page }) => {
  await openProductPage(page, 390, 'light');
  const slides = page.locator('.product-detail__image');
  test.skip((await slides.count()) < 2, 'This test product has one photo.');
  const second = await slides.nth(1).getAttribute('src');
  await page.locator('.product-detail__carousel').evaluate((el) => el.scrollTo({ left: el.clientWidth, behavior: 'instant' as ScrollBehavior }));
  await expect(page.getByTestId('image-counter')).toHaveText(/^2 \//);
  await expect(page.locator('.product-detail__backdrop--on')).toHaveAttribute('src', second ?? '');
  await expect(page.locator('.product-detail__backdrop--on')).toHaveCount(1);
});

/* ---------------------------------------------------------------- Part 9 */

test('Part 9: shop photos cannot be dragged or long-press saved; admin photos still drag', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.product-card__image').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute('draggable', 'false');
  expect(await card.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-touch-callout') || 'none')).toBe('none');
  expect(await card.evaluate((el) => getComputedStyle(el).userSelect)).toBe('none');
  const prevented = await card.evaluate((el) => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(true);

  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${product.id}/edit`);
  await expect(page.locator('#pf-retail')).toBeVisible({ timeout: 20_000 });
  // The admin keeps its own image behaviour: none of the shop protection
  // is applied there.
  const adminImages = page.locator('.adm img, .adm-fpage img');
  const total = await adminImages.count();
  expect(total).toBeGreaterThan(0);
  for (let i = 0; i < total; i += 1) {
    // (The photo tiles' own long-press menu was already blocked by the
    // Batch 26 drag-to-reorder code; reordering itself is tested there.)
    await expect(adminImages.nth(i)).not.toHaveClass(/protected-image/);
  }
});
