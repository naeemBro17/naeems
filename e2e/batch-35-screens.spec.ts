import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, pickStockedProduct, placeTestOrder, rpc, select, useSessionInPage, type TestSession } from './helpers/api';
import { STEADFAST_FUNCTION, mockSteadfast, type MockTracking } from './helpers/steadfastMock';

// Batch 35: screenshots for reports/batch-35-screens/ — 390 px and
// 1280 px, light and dark. Not a pass/fail test; only runs when asked:
//   SCREENS=1 npx playwright test e2e/batch-35-screens.spec.ts --project=parallel --no-deps
// Steadfast is mocked (nothing is booked). Test orders only, deleted after.

test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

const DIR = 'reports/batch-35-screens';
const SIZES = [
  { label: '390', width: 390, height: 844 },
  { label: '1280', width: 1280, height: 900 },
] as const;
const THEMES = ['light', 'dark'] as const;

let admin: TestSession;
let customer: TestSession;
let product: { id: string; name: string; stock: number };
const ids: string[] = [];
const orders: Record<string, { id: string; orderNumber: string }> = {};

const EVENTS = [
  { text: 'Consignment created by Sender(API).', at: '2026-10-07T09:00:00Z' },
  { text: 'Consignment status has been updated as Pending', at: '2026-10-07T12:00:00Z' },
  { text: 'Consignment sent to MIRPUR WAREHOUSE.  Dispatch ID: 18085103', at: '2026-10-07T15:00:00Z' },
  { text: 'Consignment has been received at PALLABI.', at: '2026-10-08T03:00:00Z' },
];
const RIDER = { text: 'Assigned to rider.', at: '2026-10-08T05:00:00Z' };
const DELIVERED = { text: 'Consignment marked as delivered by rider.', at: '2026-10-08T09:00:00Z' };

const TRACKING: Record<string, MockTracking | null> = {
  processing: null,
  confirmed: null,
  in_transit: { courierStatus: 'pending', events: EVENTS },
  out_for_delivery: { courierStatus: 'pending', events: [...EVENTS, RIDER] },
  delivered: { courierStatus: 'delivered', events: [...EVENTS, RIDER, DELIVERED] },
  cancelled: null,
};

test.beforeAll(async () => {
  test.setTimeout(90_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(10);
  for (const state of Object.keys(TRACKING)) {
    const order = await placeTestOrder(customer.accessToken, product.id, 1);
    ids.push(order.id);
    orders[state] = order;
    if (state === 'processing') continue;
    if (state === 'cancelled') {
      await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: order.id, p_new_status: 'cancelled' });
      continue;
    }
    await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: order.id, p_new_status: 'confirmed' });
    if (state === 'confirmed') continue;
    await rpc(admin.accessToken, 'admin_record_steadfast_shipment', {
      p_order_id: order.id,
      p_consignment_id: `E2E-B35S-${Date.now()}`,
      p_tracking_code: 'E2EB35S',
      p_tracking_link: '',
      p_courier_status: 'pending',
    });
    if (state === 'in_transit') {
      await rpc(admin.accessToken, 'admin_add_order_payment', {
        p_order_id: order.id,
        p_amount: 500,
        p_method: 'bkash',
        p_trx_id: 'E2E35SCREEN',
        p_paid_at: '2026-10-07T10:00:00Z',
        p_note: 'E2E screenshot',
        p_kind: 'payment',
      });
    }
  }
});

test.afterAll(async () => {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
  await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: ids });
  await rpc(admin.accessToken, 'admin_close_delete_lock');
});

async function start(page: Page, theme: 'light' | 'dark', width: number, height: number, session: TestSession): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await useSessionInPage(page, session);
}

for (const size of SIZES) {
  for (const theme of THEMES) {
    test(`customer order page, every state — ${size.label} ${theme}`, async ({ page }) => {
      test.setTimeout(120_000);
      await start(page, theme, size.width, size.height, customer);
      for (const [state, tracking] of Object.entries(TRACKING)) {
        await page.unroute(STEADFAST_FUNCTION);
        await mockSteadfast(page, { tracking });
        await page.goto(`/orders/${orders[state].id}`);
        await page.evaluate(() => window.sessionStorage.clear());
        await page.reload();
        await expect(page.getByTestId('order-tracking')).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${DIR}/customer-${state}-${size.label}-${theme}.png`, fullPage: true });
        if (state === 'in_transit') {
          await page.getByTestId('toggle-updates').click();
          await page.waitForTimeout(300);
          await page.screenshot({ path: `${DIR}/customer-all-updates-${size.label}-${theme}.png`, fullPage: true });
        }
      }
    });

    test(`admin order page, lists, settings, money fields — ${size.label} ${theme}`, async ({ page }) => {
      test.setTimeout(150_000);
      await start(page, theme, size.width, size.height, admin);
      await mockSteadfast(page, { tracking: TRACKING.in_transit });
      for (const state of ['processing', 'confirmed', 'in_transit']) {
        await page.goto(`/admin/orders/${orders[state].orderNumber}`);
        await expect(page.getByTestId('order-step-label')).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${DIR}/admin-order-${state}-${size.label}-${theme}.png`, fullPage: true });
      }
      await page.goto('/admin?tab=orders');
      await expect(page.getByTestId('order-row').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${DIR}/admin-orders-list-${size.label}-${theme}.png` });
      await page.goto('/admin?tab=customers');
      await expect(page.getByTestId('customer-row').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/admin-customers-list-${size.label}-${theme}.png` });
      await page.goto('/admin?tab=settings&sset=delivery');
      await expect(page.getByTestId('rider-phone-switch')).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: `${DIR}/admin-settings-rider-${size.label}-${theme}.png` });

      await page.goto(`/admin/products/${product.id}/edit`);
      await expect(page.locator('#pf-retail')).toBeVisible({ timeout: 20_000 });
      await page.locator('#pf-retail').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/money-product-prices-${size.label}-${theme}.png` });
      await page.goto('/admin?tab=settings&sset=payment');
      await expect(page.locator('#settings-fee-inside')).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: `${DIR}/money-settings-fees-${size.label}-${theme}.png` });
      await page.goto(`/admin/orders/${orders.processing.orderNumber}/edit`);
      await expect(page.locator('#edit-order-fee')).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: `${DIR}/money-edit-order-${size.label}-${theme}.png`, fullPage: true });
      await page.goto('/admin/orders/new');
      await expect(page.locator('#manual-order-discount')).toBeVisible({ timeout: 20_000 });
      await page.locator('#manual-order-discount').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${DIR}/money-new-order-${size.label}-${theme}.png` });
      await page.goto('/admin?tab=promo-codes');
      await page.getByRole('button', { name: 'Add code' }).click();
      await expect(page.locator('#promo-discount-amount')).toBeVisible();
      await page.screenshot({ path: `${DIR}/money-promo-${size.label}-${theme}.png` });
    });

    test(`product page photo — ${size.label} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
      const slug = (await select<{ slug: string }[]>(null, `products_view?select=slug&id=eq.${product.id}`)).data?.[0]?.slug ?? product.id;
      await page.goto(`/product/${slug}`);
      await expect(page.locator('.product-detail__image').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${DIR}/product-photo-${size.label}-${theme}.png` });
    });
  }
}
