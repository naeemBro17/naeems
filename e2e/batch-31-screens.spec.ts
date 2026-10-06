import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, pickStockedProduct, placeTestOrder, rpc, useSessionInPage, type TestSession } from './helpers/api';
import { mockSteadfast, type MockFraudResult } from './helpers/steadfastMock';

// Batch 31: screenshots for reports/batch-31-screens/ — admin at 390 px and
// 1280 px, the shop at 390 px, light and dark. Not a pass/fail test; only
// runs when asked:
//   SCREENS=1 npx playwright test e2e/batch-31-screens.spec.ts --project=parallel
// Steadfast is mocked. One test order is created and deleted afterwards.

test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

const DIR = 'reports/batch-31-screens';
const TONES: Record<'good' | 'warn' | 'risk', MockFraudResult> = {
  good: { deliveryRatio: 92, cancellationRatio: 7, volumeBand: 'high', volumeRange: '50+', totalReports: 0 },
  warn: { deliveryRatio: 64, cancellationRatio: 35, volumeBand: 'medium', volumeRange: '10+', totalReports: 1 },
  risk: { deliveryRatio: 30, cancellationRatio: 70, volumeBand: 'low', volumeRange: '7', totalReports: 3 },
};
const STATIONS = [
  { name: 'Gulshan', district: 'Dhaka' },
  { name: 'Gulshan Model Town', district: 'Dhaka' },
  { name: 'Gulistan', district: 'Dhaka' },
  { name: 'Mirpur', district: 'Dhaka' },
  { name: 'Kotwali', district: 'Chittagong' },
];

let admin: TestSession;
let customer: TestSession;
let orderId = '';

test.beforeAll(async () => {
  test.setTimeout(60_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  const product = await pickStockedProduct(5);
  orderId = (await placeTestOrder(customer.accessToken, product.id, 1)).id;
});

test.afterAll(async () => {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
  await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: [orderId] });
  await rpc(admin.accessToken, 'admin_close_delete_lock');
});

async function start(page: Page, theme: 'light' | 'dark', width: number, session: TestSession | null): Promise<void> {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  if (session) await useSessionInPage(page, session);
}

for (const theme of ['light', 'dark'] as const) {
  for (const size of [
    { label: '390', width: 390 },
    { label: '1280', width: 1280 },
  ]) {
    for (const tone of ['good', 'warn', 'risk'] as const) {
      test(`order detail with pen and ${tone} courier history ${size.label}px ${theme}`, async ({ page }) => {
        test.setTimeout(60_000);
        await start(page, theme, size.width, admin);
        await mockSteadfast(page, { fraud: { '01712345678': TONES[tone] } });
        await page.goto(`/admin?tab=orders&order=${orderId}`);
        await expect(page.getByTestId('fraud-card')).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${DIR}/admin-order-${tone}-${size.label}-${theme}.png` });
      });
    }

    test(`new order with courier history ${size.label}px ${theme}`, async ({ page }) => {
      test.setTimeout(60_000);
      await start(page, theme, size.width, admin);
      await mockSteadfast(page, { fraud: { '01711000002': TONES.risk } });
      await page.goto('/admin?tab=orders');
      await page.getByRole('button', { name: 'New order' }).click();
      await page.locator('#manual-order-phone').fill('01711000002');
      await expect(page.getByTestId('fraud-card')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('fraud-card').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/admin-new-order-fraud-${size.label}-${theme}.png` });
    });

    test(`settings version and products button ${size.label}px ${theme}`, async ({ page }) => {
      test.setTimeout(60_000);
      await start(page, theme, size.width, admin);
      await page.goto('/admin?tab=settings');
      await page.getByTestId('app-version').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/admin-settings-version-${size.label}-${theme}.png` });
      await page.goto('/admin?tab=products');
      await expect(page.getByTestId('product-row').first()).toBeVisible({ timeout: 20_000 });
      const kebab = page.getByRole('button', { name: /More actions for Products/ });
      if (await kebab.isVisible()) await kebab.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/admin-products-small-images-${size.label}-${theme}.png` });
    });
  }

  test(`thana picker while typing 390px ${theme}`, async ({ page }) => {
    test.setTimeout(60_000);
    await start(page, theme, 390, admin);
    await mockSteadfast(page, { policeStations: STATIONS });
    await page.addInitScript(() => window.localStorage.removeItem('steadfast-thanas-v1'));
    await page.goto('/admin?tab=orders');
    await page.getByRole('button', { name: 'New order' }).click();
    await page.locator('#manual-order-division').click();
    await page.getByPlaceholder('Search division...').fill('Dhaka');
    await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
    await page.locator('#manual-order-district').click();
    await page.getByPlaceholder('Search district...').fill('Dhaka');
    await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
    await page.locator('#manual-order-thana').click();
    await page.getByLabel('Search thana').click();
    await page.keyboard.type('Guls');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${DIR}/thana-picker-typing-390-${theme}.png` });
  });

  test(`menu 390px ${theme}`, async ({ page }) => {
    test.setTimeout(60_000);
    await start(page, theme, 390, null);
    await page.goto('/');
    await page.waitForSelector('.product-card');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${DIR}/menu-390-${theme}.png` });
  });
}
