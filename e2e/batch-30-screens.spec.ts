import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, pickStockedProduct, placeTestOrder, rpc, useSessionInPage, type TestSession } from './helpers/api';
import { STEADFAST_FUNCTION, mockSteadfast } from './helpers/steadfastMock';

// Batch 30: screenshots for reports/batch-30-screens/ — admin at 390 px and
// 1280 px, the shop at 390 px, light and dark. Not a pass/fail test; only
// runs when asked:
//   SCREENS=1 npx playwright test e2e/batch-30-screens.spec.ts --project=parallel
// Steadfast is mocked. Until migration-033 is live the payment rows and the
// Batch 30 order columns are filled in by the mocks below (the screens show
// exactly what the real data will look like); one booked test order is
// created as the test customer and deleted afterwards.

test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

const DIR = 'reports/batch-30-screens';
// supabase-js sends the select list without spaces.
const NEW_COLUMNS = /,s*alt_phone,s*courier_note,s*admin_customer_id,s*steadfast_cod_amount,s*steadfast_outdated/;

let admin: TestSession;
let customer: TestSession;
let orderId = '';
let total = 0;

test.beforeAll(async () => {
  test.setTimeout(60_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  const product = await pickStockedProduct(5);
  const order = await placeTestOrder(customer.accessToken, product.id, 2);
  orderId = order.id;
  await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: orderId, p_new_status: 'confirmed' });
  await rpc(admin.accessToken, 'admin_record_steadfast_shipment', {
    p_order_id: orderId,
    p_consignment_id: `E2E-B30-SCREENS-${Date.now()}`,
    p_tracking_code: 'E2EB30S',
    p_tracking_link: '',
    p_courier_status: 'in_review',
  });
});

test.afterAll(async () => {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
  await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: [orderId] });
  await rpc(admin.accessToken, 'admin_close_delete_lock');
});

/** The order as migration-033 will return it: Steadfast was booked with
 *  the full total, the name and address were changed afterwards, and ৳500
 *  has been paid since. */
async function mockBatch30Data(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/orders\?select=.*alt_phone/, async (route) => {
    const url = decodeURIComponent(route.request().url()).replace(NEW_COLUMNS, '');
    if (url === decodeURIComponent(route.request().url())) throw new Error('Batch 30 columns not found in the order select');
    const res = await route.fetch({ url });
    const body = (await res.json()) as Record<string, unknown> | Record<string, unknown>[];
    const patch = (row: Record<string, unknown>) => {
      if (row.id !== orderId) return { ...row, alt_phone: null, courier_note: null, admin_customer_id: null, steadfast_cod_amount: null, steadfast_outdated: [] };
      total = Number(row.total);
      return {
        ...row,
        alt_phone: '01812345678',
        courier_note: 'Call before delivery',
        admin_customer_id: null,
        steadfast_cod_amount: Number(row.total),
        steadfast_outdated: ['Name', 'Address'],
      };
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(patch) : patch(body)) });
  });
  await page.route(/\/rest\/v1\/order_payments\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: '00000000-0000-0000-0000-0000000000a1',
          order_id: orderId,
          kind: 'payment',
          amount: 500,
          method: 'bkash',
          trx_id: 'BK7Q2X91',
          paid_at: '2026-10-04T09:30:00Z',
          note: 'Advance',
          source: 'manual',
          created_by_username: 'naeem',
          updated_by_username: null,
        },
      ]),
    })
  );
}

async function start(page: Page, theme: 'light' | 'dark', width: number, session: TestSession): Promise<void> {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await useSessionInPage(page, session);
}

const TIMELINE = [
  { text: 'Consignment created by Sender(API).', at: '2026-10-04T07:05:31Z' },
  { text: 'Parcel received at Dhanmondi hub.', at: '2026-10-04T11:22:04Z' },
  { text: 'Assigned to rider Md. Karim (01711111111)', at: '2026-10-05T09:10:00Z' },
];

for (const theme of ['light', 'dark'] as const) {
  for (const size of [
    { label: '390', width: 390 },
    { label: '1280', width: 1280 },
  ]) {
    test(`admin order screens ${size.label}px ${theme}`, async ({ page }) => {
      test.setTimeout(90_000);
      await start(page, theme, size.width, admin);
      await mockBatch30Data(page);
      await mockSteadfast(page, { tracking: { courierStatus: 'pending', events: TIMELINE } });
      await page.goto(`/admin?tab=orders&order=${orderId}`);
      const dialog = page.getByTestId('admin-order-page');
      await expect(dialog.getByTestId('steadfast-banner')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/admin-order-banner-${size.label}-${theme}.png` });

      await dialog.getByTestId('payment-block').scrollIntoViewIfNeeded();
      await expect(dialog.getByTestId('payment-state')).toHaveText('Partly paid');
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${DIR}/admin-payment-partly-paid-${size.label}-${theme}.png` });

      await dialog.getByTestId('history-toggle').click();
      await dialog.getByTestId('courier-timeline').scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${DIR}/admin-order-timeline-${size.label}-${theme}.png` });

      await dialog.getByTestId('edit-order').scrollIntoViewIfNeeded();
      await dialog.getByTestId('edit-order').click();
      await expect(page.getByTestId('edit-order-page')).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/admin-edit-order-${size.label}-${theme}.png` });
      await page.getByTestId('edit-order-page').locator('.edit-order__items').scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${DIR}/admin-edit-order-items-${size.label}-${theme}.png` });
    });

    test(`admin new order customer search ${size.label}px ${theme}`, async ({ page }) => {
      test.setTimeout(60_000);
      await start(page, theme, size.width, admin);
      await page.route(/\/rest\/v1\/rpc\/admin_find_customers/, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { customer_key: 'ph:01712345678', profile_id: null, full_name: 'Nusrat Jahan', phone: '01712345678', alt_phone: null, division: 'Dhaka', district: 'Dhaka', thana: 'Mirpur', address_line: 'House 12, Road 3', order_count: 4, total_due: 650 },
            { customer_key: 'p:00000000-0000-0000-0000-0000000000b2', profile_id: '00000000-0000-0000-0000-0000000000b2', full_name: 'Rahim Uddin', phone: '+880 1712-345670', alt_phone: null, division: 'Dhaka', district: 'Gazipur', thana: 'Tongi', address_line: 'Station Road', order_count: 1, total_due: 0 },
          ]),
        })
      );
      await page.goto('/admin?tab=orders');
      await page.getByRole('button', { name: 'New order' }).click();
      await page.getByLabel('Customer', { exact: true }).fill('+880 1712');
      await expect(page.getByTestId('customer-results')).toContainText('Nusrat Jahan', { timeout: 15_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/admin-new-order-customer-${size.label}-${theme}.png` });
    });
  }

  test(`customer order steps 390px ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await start(page, theme, 390, customer);
    const states: { name: string; courierStatus: string; events: typeof TIMELINE }[] = [
      { name: 'booked', courierStatus: 'in_review', events: TIMELINE.slice(0, 1) },
      { name: 'in-transit', courierStatus: 'pending', events: TIMELINE.slice(0, 2) },
      { name: 'out-for-delivery', courierStatus: 'pending', events: TIMELINE },
      { name: 'delivered', courierStatus: 'delivered', events: [...TIMELINE, { text: 'Delivered to the customer.', at: '2026-10-05T15:40:00Z' }] },
    ];
    for (const s of states) {
      await page.unroute(STEADFAST_FUNCTION);
      await mockSteadfast(page, { tracking: { courierStatus: s.courierStatus, events: s.events } });
      await page.goto(`/orders/${orderId}`);
      await page.evaluate(() => window.sessionStorage.clear());
      await page.reload();
      await expect(page.getByTestId('order-steps')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/customer-order-${s.name}-390-${theme}.png` });
    }
  });

  test(`checkout thana search 390px ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await start(page, theme, 390, customer);
    await page.goto('/');
    await page.waitForSelector('.product-card');
    await page.getByRole('button', { name: /^Add .* to cart$/ }).first().click();
    await page.goto('/cart');
    await page.getByRole('button', { name: 'Checkout' }).click();
    await expect(page).toHaveURL(/\/checkout\/delivery/);
    const prefix = (await page.locator('[id$="-division"]').first().getAttribute('id'))!.replace(/-division$/, '');
    await page.locator(`#${prefix}-division`).click();
    await page.getByPlaceholder('Search division...').fill('Dhaka');
    await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
    await page.locator(`#${prefix}-district`).click();
    await page.getByPlaceholder('Search district...').fill('Dhaka');
    await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
    await page.locator(`#${prefix}-thana`).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${DIR}/checkout-thana-list-390-${theme}.png` });
    await page.getByLabel('Search thana').fill('kotwali');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${DIR}/checkout-thana-search-390-${theme}.png` });
    await page.getByLabel('Search thana').fill('');
    await page.getByTestId('thana-list').getByRole('button', { name: 'Other — type your thana' }).click();
    await page.getByLabel('Type your thana').fill('Uttar Badda, Block C');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${DIR}/checkout-thana-other-390-${theme}.png` });
  });
}
