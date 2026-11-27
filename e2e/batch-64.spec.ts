import { mkdirSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, useSessionInPage, type TestSession } from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';
import { waitForViewTransitionsToFinish } from './helpers/animations';

// Batch 64. Part 2: Back from a product lands exactly where the grid was.
// Part 3: the empty photo tile in dark mode. Part 4: "Your wallet is open"
// (the test customer's wallet is answered in the browser, as in the Batch
// 60/62 wallet tests; nothing is written to the database). Part 6: arrow
// keys in New order's lists and the draft kept on this device. Made-up
// customers and products are answered in the browser; Create order is
// never sent to the database.

test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-64-screens';

const ID = {
  cream: '00000000-0000-4000-8000-0000000064a1',
  wash: '00000000-0000-4000-8000-0000000064a2',
  washBig: '00000000-0000-4000-8000-0000000064b1',
};

const CUSTOMERS = [
  {
    customer_key: 'b64-k1', profile_id: null, full_name: 'Rahima B64 Akter', phone: '01711000641',
    alt_phone: null, division: 'Dhaka', district: 'Dhaka', thana: 'Mirpur', address_line: 'House 7, Road 3', order_count: 2, total_due: null,
  },
];

let admin: TestSession | null = null;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  if (E2E_ADMIN_EMAIL && E2E_ADMIN_PASSWORD) admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) };
}

async function mockRpc(page: Page, fn: string, reply: (args: Record<string, unknown>) => unknown): Promise<Record<string, unknown>[]> {
  const calls: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push(args);
    await route.fulfill(json(reply(args)));
  });
  return calls;
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
}

/* ------------------------------------------------------------- Part 2 */

for (const kind of ['phone', 'in-app'] as const) {
  test(`Part 2: Back (${kind}) from a product lands within 1 px of where the grid was, 390 px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/shop');
    await expect(page.locator('.product-card').nth(8)).toBeVisible({ timeout: 30_000 });
    const card = page.locator('.product-card').nth(6);
    await card.scrollIntoViewIfNeeded();
    // A spot that is not a card's edge, then let it settle.
    await page.evaluate(() => window.scrollBy({ top: 117, behavior: 'instant' }));
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => ({
      y: window.scrollY,
      top: document.querySelectorAll('.product-card')[6].getBoundingClientRect().top,
    }));
    await card.click({ position: { x: 40, y: 60 } });
    await expect(page).toHaveURL(/\/product\//);
    await waitForViewTransitionsToFinish(page);
    expect(await page.evaluate(() => window.scrollY), 'a product opens at the top').toBe(0);
    if (kind === 'phone') await page.goBack();
    else await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL(/\/shop$/);
    await waitForViewTransitionsToFinish(page);
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => ({
      y: window.scrollY,
      top: document.querySelectorAll('.product-card')[6].getBoundingClientRect().top,
    }));
    expect(Math.abs(after.y - before.y), `scrollY ${before.y} → ${after.y}`).toBeLessThanOrEqual(1);
    expect(Math.abs(after.top - before.top), `card top ${before.top} → ${after.top}`).toBeLessThanOrEqual(1);
  });
}

/* --------------------------------------------------- Admin New order */

/** The real product list plus two made-up products (one with a size). */
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
      make({ id: ID.cream, name: 'B64 Night Cream', retail_price: 900, stock_quantity: 7 }),
      make({ id: ID.wash, name: 'B64 Body Wash', retail_price: 1250, stock_quantity: 9, size: '250ml', region: 'AU' })
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

async function openNewOrder(page: Page, width: number, scheme: 'light' | 'dark' = 'light'): Promise<Record<string, unknown>[]> {
  if (!admin) throw new Error('no admin session');
  await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
  await page.emulateMedia({ colorScheme: scheme });
  await useSessionInPage(page, admin);
  await withMadeUpProducts(page);
  await mockRpc(page, 'admin_find_customers_v2', (args) => {
    const q = String(args.p_query ?? '').toLowerCase();
    return q === '' ? [] : CUSTOMERS.filter((c) => c.full_name.toLowerCase().includes(q));
  });
  await page.route(/\/functions\/v1\/steadfast/, (route) => route.fulfill(json({ ok: false })));
  const creates = await mockRpc(page, 'admin_create_order_v2', () => [{ order_id: '00000000-0000-4000-8000-0000000064d1', order_number: 'NM-6400' }]);
  // Reloading with unsaved typing asks "Leave site?": always leave.
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/admin/orders/new');
  await expect(page.getByTestId('new-order-form')).toBeVisible({ timeout: 30_000 });
  return creates;
}

async function searchProducts(page: Page, text: string): Promise<void> {
  // Cleared first: typing the same text again would change nothing.
  await page.getByLabel('Search products').fill('');
  await page.getByLabel('Search products').fill(text);
  await expect(page.getByTestId('manual-product-results')).toBeVisible();
}

/* ------------------------------------------------------------- Part 3 */

test.describe('Part 3: the empty photo tile', () => {
  test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the admin test account in .env.e2e.');

  for (const width of [390, 1440]) {
    test(`dark at ${width} px: a dark tile, the bottle still visible; light exactly as before`, async ({ page }) => {
      test.setTimeout(90_000);
      await openNewOrder(page, width, 'dark');
      await searchProducts(page, 'B64');
      const tile = page.getByTestId('manual-product-result').filter({ hasText: 'B64 Night Cream' }).locator('.nord-thumb');
      await expect(tile.locator('svg')).toBeVisible();
      expect(await tile.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('linear-gradient(160deg, rgb(42, 49, 58), rgb(30, 36, 43))');
      await tile.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'instant' }));
      await page.screenshot({ path: `${SHOTS}/part3-tile-dark-${width}.png` });

      // The app wrote the theme on <html> when it opened; light is set the same way.
      await page.emulateMedia({ colorScheme: 'light' });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'light';
      });
      expect(await tile.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('linear-gradient(160deg, rgb(255, 255, 255), rgb(221, 230, 239))');
      if (width === 390) await page.screenshot({ path: `${SHOTS}/part3-tile-light-${width}.png` });
    });
  }
});

/* ------------------------------------------------------------- Part 6 */

test.describe('Part 6: New order', () => {
  test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the admin test account in .env.e2e.');

  for (const width of [390, 1440]) {
    test(`6a at ${width} px: arrow keys move the highlight, Enter picks, typing goes back to the first row`, async ({ page }) => {
      test.setTimeout(90_000);
      await openNewOrder(page, width);
      const customer = page.locator('#manual-order-customer');
      await customer.fill('Rahima');
      const list = page.getByTestId('customer-results');
      await expect(list).toBeVisible();
      await expect(customer).toHaveAttribute('role', 'combobox');
      await expect(customer).toHaveAttribute('aria-expanded', 'true');
      await expect(list).toHaveAttribute('role', 'listbox');
      const rows = list.getByRole('option');
      await expect(rows).toHaveCount(2);
      const activeId = () => customer.getAttribute('aria-activedescendant');
      expect(await activeId()).toBe(await rows.nth(0).getAttribute('id'));
      await customer.press('ArrowDown');
      expect(await activeId()).toBe(await rows.nth(1).getAttribute('id'));
      await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'false');
      // Stops at the last row.
      await customer.press('ArrowDown');
      expect(await activeId()).toBe(await rows.nth(1).getAttribute('id'));
      // The ring shows (keyboard mode).
      expect(await rows.nth(1).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      await page.screenshot({ path: `${SHOTS}/part6a-customer-highlight-${width}.png` });
      await customer.press('ArrowUp');
      await customer.press('ArrowUp');
      expect(await activeId()).toBe(await rows.nth(0).getAttribute('id'));
      await customer.press('ArrowDown');
      // Typing puts it back on the first row.
      await customer.pressSequentially(' ');
      expect(await activeId()).toBe(await rows.nth(0).getAttribute('id'));
      await customer.fill('Rahima');
      await customer.press('Enter');
      await expect(page.getByTestId('customer-picked')).toContainText('Rahima B64 Akter');

      // Products: Enter adds the highlighted one; a product with sizes opens the sheet.
      const search = page.getByLabel('Search products');
      await searchProducts(page, 'B64');
      await expect(search).toHaveAttribute('role', 'combobox');
      const products = page.getByTestId('manual-product-results').getByRole('option');
      const names = await products.allTextContents();
      const creamIndex = names.findIndex((n) => n.includes('B64 Night Cream'));
      const washIndex = names.findIndex((n) => n.includes('B64 Body Wash'));
      expect(creamIndex).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < creamIndex; i += 1) await search.press('ArrowDown');
      await expect(products.nth(creamIndex)).toHaveAttribute('aria-selected', 'true');
      await products.nth(creamIndex).evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: `${SHOTS}/part6a-product-highlight-${width}.png` });
      await search.press('Enter');
      await expect(page.getByTestId('new-order-line')).toHaveCount(1);
      await expect(page.getByTestId('new-order-line')).toContainText('B64 Night Cream');
      await searchProducts(page, 'B64');
      for (let i = 0; i < washIndex; i += 1) await search.press('ArrowDown');
      await search.press('Enter');
      await expect(page.getByTestId('manual-option-picker')).toBeVisible();
      await page.keyboard.press('Escape');
      // Escape still closes the list.
      await searchProducts(page, 'B64');
      await search.press('Escape');
      await expect(page.getByTestId('manual-product-results')).toHaveCount(0);
      await expect(search).toHaveAttribute('aria-expanded', 'false');
      await noSideScroll(page);
    });
  }

  test('6a: a tap still picks a row, and shows no keyboard ring', async ({ page }) => {
    test.setTimeout(90_000);
    await openNewOrder(page, 390);
    await searchProducts(page, 'B64 Night');
    const row = page.getByTestId('manual-product-result').first();
    await expect(row).toHaveClass(/is-active/);
    await page.getByLabel('Search products').click();
    expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
    await row.click();
    await expect(page.getByTestId('new-order-line')).toHaveCount(1);
  });

  for (const width of [390, 1440]) {
    test(`6b at ${width} px: a reload keeps the half-typed order; Restore fills it back, Discard removes it`, async ({ page }) => {
      test.setTimeout(120_000);
      await openNewOrder(page, width);
      const key = `naeems.newOrderDraft.${admin?.userId ?? ''}`;
      await page.getByRole('button', { name: 'WhatsApp' }).click();
      await page.locator('#manual-order-name').fill('E2E B64 Draft');
      await page.locator('#manual-order-phone').fill('01799000641');
      await page.locator('#manual-order-address').fill('House 64, Road 1');
      await searchProducts(page, 'B64 Night');
      await page.getByTestId('manual-product-result').first().click();
      await expect(page.getByTestId('new-order-line')).toHaveCount(1);
      await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), key), { timeout: 5_000 }).toContain('E2E B64 Draft');

      await page.reload();
      await expect(page.getByTestId('new-order-form')).toBeVisible({ timeout: 30_000 });
      const bar = page.getByTestId('new-order-draft-bar');
      await expect(bar).toBeVisible({ timeout: 20_000 });
      await expect(bar).toContainText(/^You have an unsaved order from \d{1,2}:\d{2} (AM|PM)\./);
      // Nothing is filled until Restore.
      await expect(page.locator('#manual-order-name')).toHaveValue('');
      await page.screenshot({ path: `${SHOTS}/part6b-draft-bar-${width}.png` });
      await bar.getByRole('button', { name: 'Restore' }).click();
      await expect(bar).toHaveCount(0);
      await expect(page.locator('#manual-order-name')).toHaveValue('E2E B64 Draft');
      await expect(page.locator('#manual-order-phone')).toHaveValue('01799000641');
      await expect(page.locator('#manual-order-address')).toHaveValue('House 64, Road 1');
      await expect(page.getByRole('button', { name: 'WhatsApp' })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('new-order-line')).toContainText('B64 Night Cream');

      // Discard on the bar removes it for good.
      await page.reload();
      await expect(page.getByTestId('new-order-draft-bar')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('new-order-draft-bar').getByRole('button', { name: 'Discard' }).click();
      await expect(page.getByTestId('new-order-draft-bar')).toHaveCount(0);
      await expect(page.locator('#manual-order-name')).toHaveValue('');
      await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), key), { timeout: 5_000 }).toBeNull();
      await page.reload();
      await expect(page.getByTestId('new-order-form')).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      await expect(page.getByTestId('new-order-draft-bar')).toHaveCount(0);
    });
  }

  test('6b: "Discard changes?" → Discard deletes the draft; Create order deletes it too; a gone product is left out', async ({ page }) => {
    test.setTimeout(120_000);
    const creates = await openNewOrder(page, 390);
    const key = `naeems.newOrderDraft.${admin?.userId ?? ''}`;
    await page.locator('#manual-order-name').fill('E2E B64 Leave');
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), key), { timeout: 5_000 }).toContain('E2E B64 Leave');
    await page.getByRole('button', { name: 'Back to orders' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByTestId('new-order-page')).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBeNull();

    // A draft with a product that no longer exists.
    await page.evaluate(
      ([k, cream]) => {
        const address = { fullName: 'E2E B64 Gone', phone: '01799000642', division: '', district: '', thana: '', fullAddress: 'House 1' };
        const line = (productId: string) => ({ productId, variantId: null, quantity: 1, soldUnit: null, soldPriceInput: '850', reason: null, reasonNote: '' });
        const data = {
          source: 'whatsapp', address, altPhone: '', pickedCustomer: null, customerQuery: '', lines: [line(cream), line('00000000-0000-4000-8000-00000000dead')],
          zone: 'inside_dhaka', zoneTouched: false, zoneFromSource: false, feeInput: '70', orderDiscountInput: '0', discountReason: null, discountNote: '',
          paidNowInput: '', paidMethod: null, paidTrxId: '', collectMode: 'cod', markDelivered: false, adminNote: 'B64 note',
        };
        localStorage.setItem(k, JSON.stringify({ v: 1, savedAt: Date.now() - 60_000, data }));
      },
      [key, ID.cream]
    );
    await page.goto('/admin/orders/new');
    await page.getByTestId('new-order-draft-bar').getByRole('button', { name: 'Restore' }).click();
    await expect(page.locator('.toast').first()).toContainText('1 item was left out because it is no longer available.');
    await expect(page.getByTestId('new-order-line')).toHaveCount(1);
    // His typed price is kept.
    await expect(page.getByTestId('new-order-line').locator('.manual-order-line__price-input')).toHaveValue('850');
    await page.locator('.adm-fpage__dock-btn').click();
    await expect.poll(() => creates.length).toBe(1);
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), key), { timeout: 5_000 }).toBeNull();
  });
});

/* ------------------------------------------------------------- Part 4 */

function myWallet(over: Partial<Record<string, unknown>> = {}) {
  return { available: true, open: true, balance: 0, due: 0, waiting: [], results: [], history: [], ...over };
}

test.describe('Part 4: "Your wallet is open"', () => {
  test.skip(!E2E_EMAIL || !E2E_PASSWORD, 'Needs the test customer in .env.e2e.');

  test('shows once on Account; Later closes it for good on this device (light, 390 px)', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await mockRpc(page, 'store_wallet_my', () => myWallet({ balance: 0 }));
    await signInAsTestCustomer(page, { walletNoteSeen: false });
    await page.goto('/account');
    const note = page.getByTestId('wallet-open-note');
    await expect(note).toBeVisible({ timeout: 20_000 });
    await expect(note).toContainText('Your wallet is open');
    await expect(note).toContainText('You can now save with us for the products you love. Add any amount and use it on your next order.');
    // Card order on the page is unchanged (the note is outside it).
    expect(await page.evaluate(() => document.querySelector('.b68-tiles')?.nextElementSibling?.getAttribute('data-testid'))).toBe('account-wallet');
    // One orange element: the main button.
    const main = note.getByRole('button', { name: 'Open my wallet' });
    const later = note.getByRole('button', { name: 'Later' });
    expect(await main.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    expect(await later.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    const box = await note.boundingBox();
    expect(box && box.x >= 11 && box.x + box.width <= 390 - 11).toBe(true);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/part4-note-light-390.png` });
    await noSideScroll(page);

    await later.click();
    await expect(note).toHaveCount(0);
    const seenKey = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith('naeems.walletOpenSeen.p:')) ?? '');
    expect(await page.evaluate((k) => localStorage.getItem(k), seenKey)).toBe('1');
    await page.reload();
    await expect(page.getByTestId('account-wallet')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('wallet-open-note')).toHaveCount(0);
    await page.goto('/shop');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await expect(page.getByTestId('wallet-open-note')).toHaveCount(0);
  });

  test('dark, 390 px: on Home (above the bottom nav) from the wallet the app already loaded; Open my wallet goes there', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const calls = await mockRpc(page, 'store_wallet_my', () => myWallet({ balance: 1200 }));
    await signInAsTestCustomer(page, { walletNoteSeen: false });
    // The Wallet page loads (and keeps) her wallet; it shows no note.
    await page.goto('/wallet');
    await expect.poll(() => calls.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(800);
    await expect(page.getByTestId('wallet-open-note')).toHaveCount(0);
    const before = calls.length;
    await page.goto('/shop');
    const note = page.getByTestId('wallet-open-note');
    await expect(note).toBeVisible({ timeout: 30_000 });
    expect(calls.length, 'Home asks the database for nothing new').toBe(before);
    const noteBox = await note.boundingBox();
    const navBox = await page.locator('.b71-nav').boundingBox();
    expect(noteBox && navBox && noteBox.y + noteBox.height <= navBox.y).toBe(true);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/part4-note-dark-390.png` });
    await note.getByRole('button', { name: 'Open my wallet' }).click();
    await expect(page).toHaveURL(/\/wallet$/);
    await page.goto('/shop');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await expect(page.getByTestId('wallet-open-note')).toHaveCount(0);
  });

  test('a closed wallet never shows it', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await mockRpc(page, 'store_wallet_my', () => myWallet({ open: false }));
    await signInAsTestCustomer(page, { walletNoteSeen: false });
    await page.goto('/account');
    await expect(page.getByTestId('account-wallet')).toHaveAttribute('data-open', 'false', { timeout: 20_000 });
    await page.waitForTimeout(800);
    await expect(page.getByTestId('wallet-open-note')).toHaveCount(0);
  });
});
