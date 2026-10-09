import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, pickStockedProduct, placeTestOrder, rpc, select, useSessionInPage, type TestSession } from './helpers/api';
import { DAY, mockPayouts, restAnswer, withRichProduct } from './helpers/batch36';

// Batch 36: screenshots for reports/batch-36-screens/ — 390 px and
// 1280 px, light and dark. Not a pass/fail test; only runs when asked:
//   SCREENS=1 npx playwright test e2e/batch-36-screens.spec.ts --project=parallel --no-deps
// Steadfast and every payout number are mocked. One test order, deleted after.
test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

const DIR = 'reports/batch-36-screens';
const SIZES = [
  { label: '390', width: 390, height: 844 },
  { label: '1280', width: 1280, height: 900 },
] as const;
const THEMES = ['light', 'dark'] as const;
const MESSAGE = 'Rume\nYousuf traders dhan dokaner pisone basha,uttar bazar,poroshuram, Feni\n01638820872';

let admin: TestSession;
let product: { id: string; name: string; stock: number };
let order: { id: string; orderNumber: string } | null = null;
let slug = '';
let photoSlug = '';

test.beforeAll(async () => {
  test.setTimeout(90_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  const customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(10);
  slug = (await select<{ slug: string }[]>(null, `products_view?select=slug&id=eq.${product.id}`)).data?.[0]?.slug ?? product.id;
  const rows = await select<{ slug: string; image_urls: string[] | null }[]>(null, 'products_view?select=slug,image_urls&is_active=eq.true&limit=300');
  photoSlug = (rows.data ?? []).find((r) => (r.image_urls ?? []).length >= 2)?.slug ?? slug;
  order = await placeTestOrder(customer.accessToken, product.id, 1);
  await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: order.id, p_new_status: 'confirmed' });
  await rpc(admin.accessToken, 'admin_record_steadfast_shipment', {
    p_order_id: order.id,
    p_consignment_id: `E2E-B36S-${Date.now()}`,
    p_tracking_code: 'E2EB36S',
    p_tracking_link: '',
    p_courier_status: 'in_review',
  });
});

test.afterAll(async () => {
  if (!order) return;
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
  await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: [order.id] });
  await rpc(admin.accessToken, 'admin_close_delete_lock');
});

async function setup(page: Page, width: number, height: number, theme: string): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
}

const UNPAID = () => [
  { order_id: 'u1', order_number: 'NM-1450', delivered_at: new Date(Date.now() - 9 * DAY).toISOString() },
  { order_id: 'u2', order_number: 'NM-1451', delivered_at: new Date(Date.now() - 9 * DAY).toISOString() },
  { order_id: 'u3', order_number: 'NM-1490', delivered_at: new Date(Date.now() - 2 * DAY).toISOString() },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    const tag = `${size.label}-${theme}`;

    test(`admin screens ${tag}`, async ({ page }) => {
      test.setTimeout(120_000);
      await setup(page, size.width, size.height, theme);
      await mockPayouts(page, { unpaid: UNPAID() });
      await page.route(/\/rest\/v1\/order_courier_costs\?/, (route) =>
        restAnswer(route, [
          { net_received: 2146.01, total_kept: 152.99, paid_at: '2026-10-08T10:10:00Z', payout_id: 'p-48213', steadfast_payouts: { steadfast_payment_id: '48213' } },
        ])
      );
      await useSessionInPage(page, admin);

      await page.goto('/admin?tab=payouts');
      await expect(page.getByTestId('payouts-list')).toBeVisible();
      await page.screenshot({ path: `${DIR}/payouts-${tag}.png`, fullPage: true });

      await page.getByTestId('payouts-list').getByRole('button').first().click();
      await expect(page.getByTestId('payout-table')).toBeVisible();
      await page.screenshot({ path: `${DIR}/payout-detail-${tag}.png`, fullPage: true });

      await page.goto(`/admin/orders/${order?.orderNumber ?? ''}`);
      const paid = page.getByTestId('order-steadfast-paid');
      await expect(paid).toBeVisible({ timeout: 15_000 });
      await paid.locator('xpath=ancestor::section[1]').screenshot({ path: `${DIR}/order-steadfast-paid-${tag}.png` });

      await page.goto('/admin');
      await expect(page.getByTestId('home-unpaid-row')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('heading', { name: 'Needs attention' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${DIR}/home-needs-attention-${tag}.png` });
    });

    test(`rich text screens ${tag}`, async ({ page }) => {
      test.setTimeout(90_000);
      await setup(page, size.width, size.height, theme);
      await withRichProduct(page, product.id);
      await page.goto(`/product/${slug}`);
      const about = page.getByTestId('pdp-about');
      await expect(about).toBeVisible({ timeout: 15_000 });
      await about.scrollIntoViewIfNeeded();
      await about.screenshot({ path: `${DIR}/customer-description-${tag}.png` });

      await useSessionInPage(page, admin);
      await page.goto(`/admin/products/${product.id}/edit`);
      const editor = page.getByTestId('rt-editor-pf-description');
      await expect(editor.locator('.rt-editor__content')).toBeVisible({ timeout: 15_000 });
      await editor.getByTestId('rt-colour').click();
      await editor.scrollIntoViewIfNeeded();
      await editor.screenshot({ path: `${DIR}/editor-toolbar-${tag}.png` });
    });

    test(`smart paste screens ${tag}`, async ({ page }) => {
      test.setTimeout(60_000);
      await setup(page, size.width, size.height, theme);
      await useSessionInPage(page, admin);
      await page.goto('/admin/orders/new');
      const card = page.getByTestId('smart-paste');
      await page.getByTestId('smart-paste-text').fill(MESSAGE);
      await card.screenshot({ path: `${DIR}/smart-paste-before-${tag}.png` });
      await page.getByTestId('smart-paste-fill').click();
      await page.waitForTimeout(900);
      await card.screenshot({ path: `${DIR}/smart-paste-reading-${tag}.png` });
      await expect(card).toHaveAttribute('data-state', 'filled', { timeout: 5000 });
      await expect(page.locator('#manual-order-thana')).toHaveText('Parshuram');
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/smart-paste-filled-${tag}.png`, fullPage: true });
    });

    test(`photo corners ${tag}`, async ({ page }) => {
      await setup(page, size.width, size.height, theme);
      await page.goto(`/product/${photoSlug}`);
      await expect(page.locator('.product-detail__image').first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1200);
      const sheet = (await page.getByTestId('pdp-sheet').boundingBox())!;
      await page.screenshot({
        path: `${DIR}/photo-corner-left-${tag}.png`,
        clip: { x: sheet.x, y: Math.max(0, sheet.y - 40), width: 90, height: 70 },
      });
      await page.screenshot({
        path: `${DIR}/photo-corner-right-${tag}.png`,
        clip: { x: sheet.x + sheet.width - 90, y: Math.max(0, sheet.y - 40), width: 90, height: 70 },
      });
    });
  }
}
