import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, pickStockedProduct, placeTestOrder, rpc, useSessionInPage, type TestSession } from './helpers/api';

// Batch 32: screenshots for reports/batch-32-screens/ — admin at 390 px and
// 1280 px, light and dark. Not a pass/fail test; only runs when asked:
//   SCREENS=1 npx playwright test e2e/batch-32-screens.spec.ts --project=parallel
// Steadfast is mocked (nothing is booked). One test order is created
// (confirmed, never booked) and deleted afterwards. "Customer pays later"
// is shown on that order by changing the answer the page receives — the
// order itself is not changed.

test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

const DIR = 'reports/batch-32-screens';

let admin: TestSession;
let product: { id: string; name: string; stock: number };
let orderId = '';
let customerKey = '';

test.beforeAll(async () => {
  test.setTimeout(60_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  const customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(5);
  orderId = (await placeTestOrder(customer.accessToken, product.id, 1)).id;
  await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: orderId, p_new_status: 'confirmed' });
  const rows = await rpc<{ customer_key: string; profile_id: string | null }[]>(admin.accessToken, 'admin_customers_v2');
  customerKey = (rows.data ?? []).find((r) => r.profile_id === customer.userId)?.customer_key ?? '';
});

test.afterAll(async () => {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
  await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: [orderId] });
  await rpc(admin.accessToken, 'admin_close_delete_lock');
});

async function start(page: Page, theme: 'light' | 'dark', width: number): Promise<void> {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await useSessionInPage(page, admin);
}

/** "Customer pays later" is offered (as after migration-035). */
async function payLaterOffered(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/orders\?select=collect_mode&limit=1/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
}

/** The test order reads as "Customer pays later" (screenshots only). */
async function showOrderAsPayLater(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/orders\?/, async (route) => {
    const url = new URL(route.request().url());
    const selectParam = url.searchParams.get('select') ?? '';
    if (!url.searchParams.get('id')?.includes(orderId) || !selectParam.includes('collect_mode')) return route.fallback();
    url.searchParams.set('select', selectParam.replace(/,\s*collect_mode/, ''));
    const response = await route.fetch({ url: url.toString() });
    const body = (await response.json()) as Record<string, unknown> | Record<string, unknown>[];
    const patch = (row: Record<string, unknown>) => ({ ...row, collect_mode: 'pay_later' });
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(patch) : patch(body) });
  });
}

async function fillNewOrder(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Phone call', exact: true }).click();
  await page.locator('#manual-order-name').fill('Nusrat Jahan');
  await page.locator('#manual-order-phone').fill('01712345678');
  await page.locator('#manual-order-address').fill('House 12, Road 3, Mirpur');
  await page.getByPlaceholder('Search product name...').fill(product.name.slice(0, 18));
  await page.locator('.picker-sheet__row').filter({ hasText: product.name }).first().click();
}

for (const theme of ['light', 'dark'] as const) {
  for (const size of [
    { label: '390', width: 390 },
    { label: '1280', width: 1280 },
  ]) {
    test(`new order payment modes ${size.label}px ${theme}`, async ({ page }) => {
      test.setTimeout(90_000);
      await start(page, theme, size.width);
      await payLaterOffered(page);
      await page.goto('/admin/orders/new');
      await expect(page.getByTestId('new-order-page')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${DIR}/new-order-page-${size.label}-${theme}.png` });
      await fillNewOrder(page);
      const section = page.getByTestId('payment-section');
      const shot = async (name: string) => {
        await section.scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${DIR}/payment-${name}-${size.label}-${theme}.png` });
      };
      await shot('cod');
      await page.getByTestId('paid-now-input').fill('500');
      await section.getByRole('button', { name: 'bKash' }).click();
      await shot('advance-rest-cod');
      await section.getByRole('radio', { name: 'Customer pays later' }).click();
      await shot('advance-pay-later');
      await page.getByTestId('paid-now-input').fill('0');
      await shot('pay-later');
      await section.getByRole('button', { name: 'Full amount' }).click();
      await section.getByRole('button', { name: 'Cash', exact: true }).click();
      await shot('fully-paid');
      await page.getByTestId('paid-now-input').fill('999999');
      await shot('error');
    });

    test(`booking confirmation pay later ${size.label}px ${theme}`, async ({ page }) => {
      test.setTimeout(60_000);
      await start(page, theme, size.width);
      await showOrderAsPayLater(page);
      await page.goto(`/admin?tab=orders&order=${orderId}`);
      const dialog = page.getByRole('dialog').first();
      await dialog.getByRole('button', { name: 'Send to Steadfast' }).click({ timeout: 20_000 });
      await expect(page.getByRole('dialog', { name: 'Book with Steadfast?' })).toContainText('customer pays later');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/booking-confirm-pay-later-${size.label}-${theme}.png` });
    });

    test(`pages, customers, home, settings ${size.label}px ${theme}`, async ({ page }) => {
      test.setTimeout(120_000);
      await start(page, theme, size.width);
      await page.goto('/admin/products/new');
      await expect(page.getByTestId('product-page')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/add-product-page-${size.label}-${theme}.png` });

      await page.goto(`/admin?tab=orders&order=${orderId}`);
      await page.getByTestId('edit-order').click({ timeout: 20_000 });
      await expect(page.getByTestId('edit-order-page')).toBeVisible({ timeout: 20_000 });
      await page.getByTestId('payment-section').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/edit-order-payment-${size.label}-${theme}.png` });
      await page.locator('#edit-order-name').fill('Typed, not saved');
      await page.getByRole('button', { name: 'Back to the order' }).click();
      await expect(page.getByRole('dialog', { name: 'Discard changes?' })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/discard-changes-${size.label}-${theme}.png` });
      await page.getByRole('button', { name: 'Discard' }).click();

      await page.goto(`/admin/customers/${encodeURIComponent(customerKey)}`);
      await expect(page.getByTestId('customer-page')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${DIR}/customer-page-${size.label}-${theme}.png` });

      await page.goto('/admin?tab=customers');
      await expect(page.getByTestId('customer-row').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/customers-list-${size.label}-${theme}.png` });

      await page.goto('/admin');
      await expect(page.getByTestId('kpi-today')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${DIR}/admin-home-${size.label}-${theme}.png`, fullPage: true });

      await page.goto('/admin?tab=settings');
      await page.getByTestId('app-version').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/settings-version-${size.label}-${theme}.png` });
    });
  }
}
