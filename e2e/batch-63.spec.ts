import { mkdirSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD, SUPABASE_URL } from './helpers/env';
import { passwordSession, useSessionInPage, type TestSession } from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';
import { planPayment } from '../src/lib/paymentPlan';
import { formatTaka } from '../src/lib/format';

// Batch 63: Admin → New order's new layout and the search results with
// photos. Made-up customers and products are answered in the browser (the
// real product list comes first, the made-up ones are added to it); nothing
// is saved (Create order is answered in the browser too). Pictures come from
// the placeholders in ./fixtures, never real Storage files.

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the admin test account in .env.e2e.');

const SHOTS = 'reports/batch-63-screens';
const BUCKET = `${SUPABASE_URL}/storage/v1/object/public/product-images`;
const SERUM_FULL = `${BUCKET}/products/b63-serum.webp`;
const SERUM_CARD = `${BUCKET}/products/card/b63-serum.webp`;

const ID = {
  serum: '00000000-0000-4000-8000-0000000063a1',
  cream: '00000000-0000-4000-8000-0000000063a2',
  lotion: '00000000-0000-4000-8000-0000000063a3',
  wash: '00000000-0000-4000-8000-0000000063a4',
  washBig: '00000000-0000-4000-8000-0000000063b1',
};

let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) };
}

async function mockRpc(page: Page, fn: string, reply: (args: Record<string, unknown>) => { status?: number; body: unknown }): Promise<Record<string, unknown>[]> {
  const calls: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push(args);
    const answer = reply(args);
    await route.fulfill(json(answer.body, answer.status ?? 200));
  });
  return calls;
}

const CUSTOMERS = [
  {
    customer_key: 'b63-k1', profile_id: '00000000-0000-4000-8000-0000000063c1', full_name: 'Rahima Akter Khan', phone: '01711000631',
    alt_phone: null, division: 'Dhaka', district: 'Dhaka', thana: 'Mirpur', address_line: 'House 7, Road 3', order_count: 4, total_due: 850,
  },
  {
    customer_key: 'b63-k2', profile_id: null, full_name: '', phone: '01811000642',
    alt_phone: null, division: '', district: '', thana: '', address_line: '', order_count: 0, total_due: null,
  },
];

/** The real product list plus four made-up products (and one size). */
async function withMadeUpProducts(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/products_view\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const rows = (await response.json()) as Record<string, unknown>[];
    const base = rows[0] ?? {};
    const make = (over: Record<string, unknown>) => ({
      ...base,
      image_url: null,
      image_urls: [],
      image_urls_thumb: [],
      is_active: true,
      offer_price: null,
      wholesale_price: null,
      region: '',
      size: '',
      stock_status: 'in_stock',
      ...over,
    });
    rows.unshift(
      make({ id: ID.serum, name: 'B63 Glow Serum with Vitamin C and Hyaluronic Acid 30ml', retail_price: 1500, offer_price: 1250, stock_quantity: 12, image_url: SERUM_FULL, image_urls: [SERUM_FULL], image_urls_thumb: [SERUM_CARD] }),
      make({ id: ID.cream, name: 'B63 Night Cream', retail_price: 900, stock_quantity: 2 }),
      make({ id: ID.lotion, name: 'B63 Sun Lotion', retail_price: 1100, stock_quantity: 0, stock_status: 'out_of_stock' }),
      make({ id: ID.wash, name: 'B63 Body Wash', retail_price: 1250, stock_quantity: 9, size: '250ml', region: 'AU' })
    );
    await route.fulfill({ response, json: rows });
  });
  await page.route(/\/rest\/v1\/product_variants_view\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const rows = (await response.json()) as Record<string, unknown>[];
    rows.push({
      id: ID.washBig, product_id: ID.wash, region: 'AU', size: '1L', retail_price: 2400, offer_price: null, wholesale_price: null,
      has_wholesale: false, in_stock: true, stock_quantity: 5, image_url: null, image_url_thumb: null, note: null,
      source_product_id: null, sort_order: 0, created_at: '2026-11-01T00:00:00Z', keep_selling: false, in_hand: false, is_visible: true,
    });
    await route.fulfill({ response, json: rows });
  });
}

interface Opened {
  creates: Record<string, unknown>[];
}

async function openNewOrder(page: Page, width: number, scheme: 'light' | 'dark' = 'light', createReply?: () => { status?: number; body: unknown }): Promise<Opened> {
  await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
  await page.emulateMedia({ colorScheme: scheme });
  await useSessionInPage(page, admin);
  await withMadeUpProducts(page);
  await mockRpc(page, 'admin_find_customers_v2', (args) => {
    const q = String(args.p_query ?? '').toLowerCase();
    if (q === '') return { body: [] };
    return { body: CUSTOMERS.filter((c) => c.full_name.toLowerCase().includes(q) || c.phone.includes(q.replace(/\D/g, '') || '#')) };
  });
  // The courier's fraud check is never asked for these made-up numbers.
  await page.route(/\/functions\/v1\/steadfast/, (route) => route.fulfill(json({ ok: false })));
  const creates = await mockRpc(
    page,
    'admin_create_order_v2',
    createReply ?? (() => ({ body: [{ order_id: '00000000-0000-4000-8000-0000000063d1', order_number: 'NM-6300' }] }))
  );
  await page.goto('/admin/orders/new');
  await expect(page.getByTestId('new-order-form')).toBeVisible({ timeout: 30_000 });
  return { creates };
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
}

/** Orange (#FF7A45) text or fill anywhere on the page, other than Create
 *  order and the Smart paste orb (an illustration). */
async function orangeThings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    // The brand orange and the admin's own orange (--adm-or).
    const isOrange = (c: string) => /rgba?\((255, 122, 69|242, 89, 42)[,)]/.test(c);
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="new-order-page"] *')) {
      if (el.closest('.nord-create, .adm-fpage__dock-btn, .am-mark, svg')) continue;
      if (el.offsetParent === null) continue;
      const s = getComputedStyle(el);
      if (isOrange(s.color) || isOrange(s.backgroundColor) || isOrange(s.borderTopColor)) out.push(String(el.className || el.tagName));
    }
    return out;
  });
}

/** Scrolls so an element sits just under the top bar. */
async function scrollToTop(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90));
}

async function searchProducts(page: Page, text: string): Promise<void> {
  await page.getByLabel('Search products').fill(text);
  await expect(page.getByTestId('manual-product-results')).toBeVisible();
}

async function addThreeLines(page: Page): Promise<void> {
  await searchProducts(page, 'B63 Glow');
  await page.getByTestId('manual-product-result').first().click();
  await searchProducts(page, 'B63 Night');
  await page.getByTestId('manual-product-result').first().click();
  await searchProducts(page, 'B63 Body');
  await page.getByTestId('manual-product-result').first().click();
  await page.getByTestId('manual-option').first().click();
  await page.getByTestId('manual-pick-add').click();
  await expect(page.getByTestId('new-order-line')).toHaveCount(3);
}

test('Customer search: initials, Account tag, due in amber, New customer row; picking fills the form', async ({ page }) => {
  test.setTimeout(90_000);
  await openNewOrder(page, 390);
  await page.locator('#manual-order-customer').fill('Rahima');
  const list = page.getByTestId('customer-results');
  await expect(list).toBeVisible();
  await expect(list.locator('.nord-drop__label')).toHaveText('Customers');
  const row = list.getByTestId('customer-result').first();
  await expect(row.locator('.nord-av')).toHaveText('RA');
  await expect(row.locator('.nord-tag')).toHaveText('Account');
  await expect(row).toContainText('01711000631 · Mirpur, Dhaka · 4 orders · ৳ 850 due');
  const dueColour = await row.getByTestId('customer-result-due').evaluate((el) => getComputedStyle(el).color);
  const amber = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--adm-amber-text)';
    document.querySelector('.adm')?.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(dueColour).toBe(amber);
  const newRow = list.getByTestId('customer-new');
  await expect(newRow).toContainText('New customer');
  await expect(newRow).toContainText('Named Rahima');
  await expect(newRow.locator('.nord-av--new')).toBeVisible();
  // No name: the last two digits of the phone.
  await page.locator('#manual-order-customer').fill('018110');
  await expect(list.getByTestId('customer-result').filter({ hasText: '01811000642' }).locator('.nord-av')).toHaveText('42');
  await expect(list.getByTestId('customer-new')).toContainText('With phone 018110');
  // Picking fills the form as before.
  await page.locator('#manual-order-customer').fill('Rahima');
  await expect(list.getByTestId('customer-result')).toHaveCount(1);
  await list.getByTestId('customer-result').filter({ hasText: 'Rahima' }).click();
  await expect(page.getByTestId('customer-picked')).toContainText('Rahima Akter Khan');
  await expect(page.locator('#manual-order-name')).toHaveValue('Rahima Akter Khan');
  await expect(page.locator('#manual-order-phone')).toHaveValue('01711000631');
  await expect(page.locator('#manual-order-thana')).toHaveText('Mirpur');
  await expect(page.locator('#manual-order-address')).toHaveValue('House 7, Road 3');
  await noSideScroll(page);
});

test('Product search: small photo, price, struck retail, Only 2 left, Out of stock dimmed but adds, sizes open the sheet', async ({ page }) => {
  test.setTimeout(120_000);
  const lowStock = () => ({
    status: 400,
    body: { code: 'P0001', message: `STOCK_WARNING:${JSON.stringify([{ product_name: 'B63 Sun Lotion', variant_label: null, available: 0, requested: 1 }])}` },
  });
  const { creates } = await openNewOrder(page, 390, 'light', lowStock);
  await searchProducts(page, 'B63');
  const list = page.getByTestId('manual-product-results');
  await expect(list.locator('.nord-drop__label')).toHaveText('Products');
  const serum = list.getByTestId('manual-product-result').filter({ hasText: 'B63 Glow Serum' });
  // The small copy, never the full-size photo.
  await expect(serum.locator('img')).toHaveAttribute('src', SERUM_CARD);
  await expect(serum.locator('img')).toHaveAttribute('loading', 'lazy');
  await expect(serum.getByTestId('manual-product-price')).toContainText('৳ 1,250');
  await expect(serum.locator('s')).toHaveText('৳ 1,500');
  await expect(serum.getByTestId('manual-product-stock')).toHaveText('12 in stock');
  const priceColour = await serum.getByTestId('manual-product-price').evaluate((el) => getComputedStyle(el).color);
  expect(priceColour).not.toBe('rgb(255, 122, 69)');
  const cream = list.getByTestId('manual-product-result').filter({ hasText: 'B63 Night Cream' });
  await expect(cream.locator('.is-low')).toHaveText('Only 2 left');
  await expect(cream.locator('img')).toHaveCount(0);
  await expect(cream.locator('.nord-thumb svg')).toBeVisible();
  await expect(cream.locator('s')).toHaveCount(0);
  const lotion = list.getByTestId('manual-product-result').filter({ hasText: 'B63 Sun Lotion' });
  await expect(lotion.locator('.is-out')).toHaveText('Out of stock');
  await expect(lotion).toHaveClass(/nord-res--out/);
  expect(await lotion.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.5');
  const wash = list.getByTestId('manual-product-result').filter({ hasText: 'B63 Body Wash' });
  await expect(wash).toContainText('2 sizes · from ৳ 1,250');
  await expect(wash.locator('.nord-res__go')).toBeVisible();
  await expect(wash.getByTestId('manual-product-price')).toHaveCount(0);
  // Sizes open the size sheet.
  await wash.click();
  await expect(page.getByTestId('manual-option-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('manual-option-picker')).toHaveCount(0);
  // The sold-out product still adds; Create order asks "sell anyway?".
  await searchProducts(page, 'B63 Sun');
  await page.getByTestId('manual-product-result').first().click();
  await expect(page.getByTestId('new-order-line')).toHaveCount(1);
  await page.getByRole('button', { name: 'WhatsApp' }).click();
  await page.locator('#manual-order-name').fill('E2E B63 Test');
  await page.locator('#manual-order-address').fill('House 1');
  await page.locator('.adm-fpage__dock-btn').click();
  await expect.poll(() => creates.length).toBe(1);
  await expect(page.getByRole('dialog')).toContainText('B63 Sun Lotion: only 0 left, 1 requested');
  await page.getByRole('button', { name: 'Go back' }).click();
});

test('The lists close on Escape and on a tap outside, and open again on typing', async ({ page }) => {
  test.setTimeout(90_000);
  await openNewOrder(page, 390);
  await searchProducts(page, 'B63');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('manual-product-results')).toHaveCount(0);
  await page.getByLabel('Search products').press('Space');
  await expect(page.getByTestId('manual-product-results')).toBeVisible();
  await page.getByRole('heading', { name: 'Items' }).click();
  await expect(page.getByTestId('manual-product-results')).toHaveCount(0);
  await page.getByLabel('Search products').click();
  await expect(page.getByTestId('manual-product-results')).toBeVisible();

  // Tapping the customer box (outside the product list) closes it.
  await page.locator('#manual-order-customer').click();
  await page.locator('#manual-order-customer').fill('Rahima');
  await expect(page.getByTestId('customer-results')).toBeVisible();
  await expect(page.getByTestId('manual-product-results')).toHaveCount(0);
  await page.locator('#manual-order-customer').press('Escape');
  await expect(page.getByTestId('customer-results')).toHaveCount(0);
  await page.locator('#manual-order-customer').pressSequentially(' ');
  await expect(page.getByTestId('customer-results')).toBeVisible();
  await page.getByRole('heading', { name: 'Customer', exact: true }).click();
  await expect(page.getByTestId('customer-results')).toHaveCount(0);
});

test('Smart paste starts collapsed; Paste opens the box with focus; Fill the form still fills both cards', async ({ page }) => {
  test.setTimeout(90_000);
  await openNewOrder(page, 390);
  const card = page.getByTestId('smart-paste');
  await expect(card).toHaveAttribute('data-state', 'collapsed');
  await expect(card).toContainText('Paste the customer\'s message and we fill the form for you');
  await expect(page.getByTestId('smart-paste-text')).toHaveCount(0);
  await page.getByTestId('smart-paste-open').click();
  await expect(card).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('smart-paste-text')).toBeFocused();
  const fill = page.getByTestId('smart-paste-fill');
  expect(await fill.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 122, 69)');
  await page.getByTestId('smart-paste-text').fill('Karim Uddin\nHouse 12, Road 4, Mirpur, Dhaka\n01712345678');
  await fill.click();
  await expect(card).toHaveAttribute('data-state', 'filled', { timeout: 10_000 });
  await expect(page.locator('#manual-order-phone')).toHaveValue('01712345678', { timeout: 10_000 });
  await expect(page.locator('#manual-order-name')).toHaveValue('Karim Uddin');
  const guess = page.locator('.smart-guess');
  await expect(guess).toHaveAttribute('data-guess-name', '');
  // The orange outline shows on the Customer card (name) and the Delivery
  // address card (house / road).
  const outline = (sel: string) => page.locator(sel).evaluate((el) => getComputedStyle(el).borderColor);
  const plain = await outline('#manual-order-phone');
  expect(await outline('#manual-order-name')).not.toBe(plain);
  expect(await outline('#manual-order-address')).not.toBe(plain);
  await expect(page.getByTestId('nord-card-customer').locator('#manual-order-name')).toHaveCount(1);
  await expect(page.getByTestId('nord-card-address').locator('#manual-order-address')).toHaveCount(1);
  // Undo goes back to the open box, never collapsed.
  await page.getByTestId('smart-paste-undo').click();
  await expect(card).toHaveAttribute('data-state', 'idle');
});

test('Create order: in the right card at 1440 px (not the top bar); in the dock at 390 px with the total; disabled until ready', async ({ page }) => {
  test.setTimeout(120_000);
  await openNewOrder(page, 1440);
  const inCard = page.getByTestId('nord-card-pay').getByTestId('nord-create');
  await expect(inCard).toBeVisible();
  await expect(inCard).toBeDisabled();
  await expect(page.getByTestId('nord-card-pay')).toContainText('Nothing is saved until you tap Create order');
  await expect(page.locator('.adm-fpage__bar').getByRole('button', { name: 'Create order' })).toHaveCount(0);
  // The right card is the second column.
  const left = await page.getByTestId('nord-card-customer').boundingBox();
  const right = await page.getByTestId('nord-card-pay').boundingBox();
  expect(right!.x).toBeGreaterThan(left!.x + left!.width);
  expect(Math.round(right!.width)).toBe(380);
  await addThreeLines(page);
  await page.getByRole('button', { name: 'Facebook' }).click();
  await page.locator('#manual-order-name').fill('E2E B63 Test');
  await page.locator('#manual-order-address').fill('House 1');
  await expect(inCard).toBeEnabled();
  expect(await orangeThings(page)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inCard).toBeHidden();
  const dock = page.locator('.adm-fpage__dock-inner--lead');
  await expect(dock.getByTestId('nord-dock-lead')).toContainText('Total · 3 items');
  const total = await page.getByTestId('new-order-total').innerText();
  await expect(dock.getByTestId('nord-dock-lead').locator('b')).toHaveText(total);
  await expect(dock.getByRole('button', { name: 'Create order' })).toBeEnabled();
  await expect(page.getByTestId('nord-items-hint')).toHaveText('3 items');
  await page.getByTestId('new-order-line').nth(2).getByRole('button', { name: 'Remove' }).click();
  await page.getByTestId('new-order-line').nth(1).getByRole('button', { name: 'Remove' }).click();
  await expect(dock.getByTestId('nord-dock-lead')).toContainText('Total · 1 item');
  await expect(page.getByTestId('nord-items-hint')).toHaveText('1 item');
  await noSideScroll(page);
});

test('Under the Total: Paid now, Courier collects (COD), Due after delivery, the same numbers as the payment plan', async ({ page }) => {
  test.setTimeout(90_000);
  await openNewOrder(page, 1440);
  await searchProducts(page, 'B63 Glow');
  await page.getByTestId('manual-product-result').first().click();
  await page.getByTestId('paid-now-input').fill('300');
  const totalText = await page.getByTestId('new-order-total').innerText();
  const total = Number(totalText.replace(/[^\d.]/g, ''));
  const summary = page.getByTestId('payment-summary');
  await expect(summary).toHaveCount(1);
  // Below the Total, not inside PaymentSection.
  await expect(page.getByTestId('payment-section').getByTestId('payment-summary')).toHaveCount(0);
  for (const mode of ['cod', 'pay_later'] as const) {
    if (mode === 'pay_later') await page.getByRole('radio', { name: 'Customer pays later' }).click();
    const plan = planPayment({ total, paidNowInput: '300', mode, formatMoney: formatTaka });
    await expect(summary.getByTestId('summary-paid-now')).toHaveText(formatTaka(plan.paidNow));
    await expect(summary.getByTestId('summary-courier')).toHaveText(formatTaka(plan.courierCollects));
    await expect(summary.getByTestId('summary-due')).toHaveText(formatTaka(plan.dueAfterDelivery));
  }
  await expect(page.getByTestId('payment-section')).toContainText(`The rest ${formatTaka(total - 300)}`);
  const below = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="new-order-totals"]');
    const s = document.querySelector('[data-testid="payment-summary"]');
    return Boolean(t && s && t.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(below).toBe(true);
});

test('Checkout: the address form is exactly as before (field order and labels at 390 px)', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(!E2E_EMAIL || !E2E_PASSWORD, 'Needs the customer test account.');
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsTestCustomer(page);
  await page.goto('/');
  await page.waitForSelector('.product-card');
  await page.getByRole('button', { name: /^Add .* to cart$/ }).first().click();
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/\/checkout\/delivery/);
  const form = page.locator('form').filter({ has: page.locator('[id$="-division"]') }).first();
  const labels = await form.locator('.form-label').allInnerTexts();
  const fields = labels.map((l) => l.replace(/\s*\*\s*$/, '').trim()).filter((l) => ['Full name', 'Phone number', 'Division', 'District', 'Thana / Upazila', 'House / road / landmark'].includes(l));
  expect(fields).toEqual(['Full name', 'Phone number', 'Division', 'District', 'Thana / Upazila', 'House / road / landmark']);
  // District and thana side by side in one row, as before; no New order layout.
  await expect(form.locator('.form-row [id$="-district"]')).toHaveCount(1);
  await expect(form.locator('.form-row [id$="-thana"]')).toHaveCount(1);
  await expect(form.locator('.nord-pair, .nord-trio')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/checkout-address-390.png`, fullPage: true });
  await noSideScroll(page);
});

/* ------------------------------------------------------------ frames */

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 1024, 1440]) {
    test(`Frames ${width} px ${scheme}`, async ({ page }) => {
      test.setTimeout(150_000);
      await openNewOrder(page, width, scheme);
      const name = (what: string) => `${SHOTS}/${what}-${width}-${scheme}.png`;
      await page.waitForTimeout(400);
      await page.screenshot({ path: name('01-empty'), fullPage: true });
      await noSideScroll(page);
      expect(await orangeThings(page)).toEqual([]);

      await page.getByTestId('smart-paste-open').click();
      await page.getByTestId('smart-paste').screenshot({ path: name('02-smart-paste-open') });
      await page.reload();
      await expect(page.getByTestId('smart-paste')).toHaveAttribute('data-state', 'collapsed', { timeout: 30_000 });
      await page.getByTestId('smart-paste').screenshot({ path: name('02-smart-paste-collapsed') });

      await page.locator('#manual-order-customer').fill('01');
      await expect(page.getByTestId('customer-result')).toHaveCount(2);
      await scrollToTop(page, '#manual-order-customer');
      await page.screenshot({ path: name('03-customer-list') });
      expect(await orangeThings(page)).toEqual([]);
      await page.locator('#manual-order-customer').press('Escape');

      await searchProducts(page, 'B63');
      await scrollToTop(page, '[data-testid="nord-card-items"]');
      await page.screenshot({ path: name('04-product-list') });
      expect(await orangeThings(page)).toEqual([]);
      await noSideScroll(page);
      await page.keyboard.press('Escape');

      await addThreeLines(page);
      await page.locator('#manual-order-discount').fill('100');
      await page.getByRole('group', { name: 'Reason for order discount' }).getByRole('button', { name: 'Gift' }).click();
      await page.getByTestId('paid-now-input').fill('500');
      await page.getByRole('button', { name: 'bKash' }).click();
      await page.getByRole('button', { name: 'Facebook' }).click();
      await page.locator('#manual-order-name').fill('Rahima Akter');
      await page.locator('#manual-order-phone').fill('01711000631');
      await page.locator('#manual-order-address').fill('House 7, Road 3');
      await page.waitForTimeout(300);
      await page.screenshot({ path: name('05-three-lines'), fullPage: true });
      await page.getByTestId('nord-card-items').screenshot({ path: name('05-three-lines-items') });
      await page.getByTestId('nord-card-pay').screenshot({ path: name('05-three-lines-pay') });
      await noSideScroll(page);
      expect(await orangeThings(page)).toEqual([]);
    });
  }
}
