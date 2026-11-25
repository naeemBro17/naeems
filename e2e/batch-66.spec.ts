import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, useSessionInPage, type TestSession } from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 66: Campaigns (timed sales).
//
// The database rules (prices, place_order_core, promo and advance discount
// only on items not on sale, the numbers, who may read what) are tested in
// e2e/sql/batch-66.sql: one transaction, always rolled back.
//
// The screens use a MADE-UP campaign around three MADE-UP products that
// exist only inside the test browser: the shop's product list is answered
// with them added, live_campaigns / admin_campaigns are answered in the
// browser, and placing the order and saving a campaign are answered there
// too. Nothing about this batch is written to Supabase. No real Storage
// file is downloaded (./fixtures).

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-66-screens';
const NAME = 'Summer Fest B66';
const SLUG = 'summer-fest-b66';

const A = { id: randomUUID(), name: 'B66 Aqua Gel Cleanser', retail: 1000, offer: null as number | null };
const B = { id: randomUUID(), name: 'B66 Bright Vitamin Serum', retail: 1000, offer: 700 as number | null };
const C = { id: randomUUID(), name: 'B66 Calm Night Cream', retail: 500, offer: null as number | null };
const FAKES = [A, B, C];

let admin: TestSession;

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
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

/** The shop's product reads, with the three made-up products added (no
 *  photos, so nothing to download). */
async function withFakeProducts(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/products_view(\?|$)/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return route.fulfill({ response, json: body });
    const template = (body[0] ?? {}) as Record<string, unknown>;
    const idFilter = new URL(route.request().url()).searchParams.get('id');
    const rows = FAKES.filter((f) => !idFilter || idFilter.includes(f.id)).map((f) => {
      const row: Record<string, unknown> = { ...template };
      for (const key of Object.keys(row)) {
        if (/image|video|photo/i.test(key)) row[key] = Array.isArray(row[key]) ? [] : null;
      }
      return {
        ...row,
        id: f.id,
        sku: `B66-${f.id.slice(0, 6)}`,
        slug: `b66-${f.id.slice(0, 8)}`,
        name: f.name,
        retail_price: f.retail,
        offer_price: f.offer,
        is_active: true,
        stock_status: 'in_stock',
        stock_quantity: 40,
        keep_selling: false,
        brand_id: null,
        is_featured: false,
      };
    });
    await route.fulfill({ response, json: [...rows, ...body] });
  });
}

function campaignJson(over: Record<string, unknown> = {}) {
  return {
    id: 'b66-campaign',
    name: NAME,
    slug: SLUG,
    style: 'plain',
    discount_mode: 'percent',
    percent: 20,
    starts_at: new Date(Date.now() - 3600_000).toISOString(),
    ends_at: new Date(Date.now() + (2 * 86400 + 4 * 3600) * 1000).toISOString(),
    // Naeem's order: B first, then A.
    items: [
      { product_id: B.id, variant_id: null, campaign_price: null, sort_order: 0 },
      { product_id: A.id, variant_id: null, campaign_price: null, sort_order: 100 },
    ],
    ...over,
  };
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, scheme);
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
}

/** Orange-filled elements on the page (shop #ff7a45, admin --adm-or). */
async function orangeCount(page: Page, root = 'body'): Promise<number> {
  return page.evaluate((sel) => {
    const scope = document.querySelector(sel);
    if (!scope) return -1;
    const orange = ['rgb(255, 122, 69)', 'rgb(242, 89, 42)'];
    return [...scope.querySelectorAll('*')].filter((el) => {
      const bg = getComputedStyle(el).backgroundColor;
      const r = el.getBoundingClientRect();
      return orange.includes(bg) && r.width > 0 && r.height > 0;
    }).length;
  }, root);
}

/** Puts lines in the cart the way the shop saves it. */
async function setCart(page: Page, lines: { id: string; qty: number; price: number; sale: boolean }[]): Promise<void> {
  await page.evaluate((items) => {
    localStorage.setItem(
      'nph_cart',
      JSON.stringify(
        items.map((l) => ({ productId: l.id, variantId: null, variantLabel: null, quantity: l.qty, priceAtAdd: l.price, saleCampaignId: l.sale ? 'b66-campaign' : null }))
      )
    );
  }, lines);
}

async function setAddress(page: Page): Promise<void> {
  await page.evaluate(() => {
    sessionStorage.setItem(
      'nph_checkout_state',
      JSON.stringify({
        zoneId: 'inside_dhaka',
        address: { fullName: 'E2E B66', phone: '01712345678', division: 'Dhaka', district: 'Dhaka', thana: 'Gulshan', fullAddress: 'B66 test road' },
        promo: null,
        lastOrder: null,
      })
    );
  });
}

async function mockPromo(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/promo_codes\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    if (url.searchParams.get('code') !== 'eq.E2E10') return route.fallback();
    await route.fulfill(json({ code: 'E2E10', discount_amount: 10, discount_type: 'percent', max_uses: null, times_used: 0, expires_at: null, active: true }));
  });
}

/* ------------------------------------------------------------- database */

test('database: campaigns, prices, place_order_core, numbers (one rolled-back transaction)', async () => {
  test.setTimeout(240_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  // The migration runs first in the same transaction (safe to run more
  // than once), so this works before and after Naeem has run it.
  const migration = readFileSync('supabase/migration-063-batch66.sql', 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
  const script = readFileSync('e2e/sql/batch-66.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${migration}\n${script}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(45);
});

/* ------------------------------------------------------------- shop */

test('Home card ticks and opens the campaign page; products in Naeem\'s order with -X% tags', async ({ page }) => {
  test.setTimeout(120_000);
  await withFakeProducts(page);
  await mockRpc(page, 'live_campaigns', () => [campaignJson()]);
  await page.goto('/');
  const card = page.getByTestId('campaign-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText(NAME);
  await expect(card).toContainText('Up to 30% off');
  await expect(card).toContainText('Shop now');
  const sec1 = await card.getByTestId('cmp-sec').locator('b').textContent();
  await page.waitForTimeout(1300);
  const sec2 = await card.getByTestId('cmp-sec').locator('b').textContent();
  expect(sec2, 'the seconds tick').not.toBe(sec1);
  await expect(card.getByTestId('cmp-days').locator('b')).toHaveText('02');
  await noSideScroll(page);

  // Product cards elsewhere show the campaign's name in the photo tag.
  const tagOnHome = page.locator('.product-card', { hasText: A.name }).getByTestId('campaign-tag');
  await expect(tagOnHome).toHaveText(NAME);
  const homeCardA = page.locator('.product-card', { hasText: A.name });
  await expect(homeCardA.locator('.product-card__price')).toHaveText('৳ 800');
  await expect(homeCardA.locator('.product-card__strike')).toHaveText('৳ 1,000');
  await expect(homeCardA.locator('.product-card__save')).toHaveText('Save 20%');

  for (const scheme of ['light', 'dark'] as const) {
    await setTheme(page, scheme);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${SHOTS}/home-plain-390-${scheme}.png` });
  }
  await setTheme(page, 'light');

  await card.click();
  await expect(page).toHaveURL(new RegExp(`/campaign/${SLUG}$`));
  await expect(page.getByTestId('campaign-hero')).toBeVisible();
  await expect(page.getByText("Sale prices are already applied. Coupons can't be used on these items.")).toBeVisible();
  await expect(page).toHaveTitle(`${NAME} | NAEEM'S`);
  const names = await page.locator('.cmp-page__grid .product-card__name').allTextContents();
  expect(names).toEqual([B.name, A.name]);
  await expect(page.locator('.product-card', { hasText: B.name }).getByTestId('campaign-tag')).toHaveText('-30%');
  await expect(page.locator('.product-card', { hasText: A.name }).getByTestId('campaign-tag')).toHaveText('-20%');
  expect(await orangeCount(page, '.cmp-page'), 'no orange on the campaign page').toBe(0);
  await noSideScroll(page);
  for (const scheme of ['light', 'dark'] as const) {
    await setTheme(page, scheme);
    await page.screenshot({ path: `${SHOTS}/campaign-page-plain-390-${scheme}.png` });
  }
  await setTheme(page, 'light');

  // Back (inside the hero) goes back to Home.
  await page.getByRole('button', { name: 'Go back' }).first().click();
  await expect(page).toHaveURL(/\/$/);
});

test('cart tag, summary hint and savings row; the order total is the one place_order_core charges', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAsTestCustomer(page);
  await withFakeProducts(page);
  const live = await mockRpc(page, 'live_campaigns', () => [campaignJson()]);
  await mockPromo(page);
  await page.goto(`/campaign/${SLUG}`);
  const cardA = page.locator('.product-card', { hasText: A.name });
  await cardA.getByRole('button', { name: `Add ${A.name} to cart` }).click();
  await cardA.getByRole('button', { name: `One more ${A.name}` }).click();
  // The normal item (not on sale) goes in next to it.
  const cart = await page.evaluate(() => localStorage.getItem('nph_cart'));
  const lines = JSON.parse(cart ?? '[]') as { productId: string; quantity: number; priceAtAdd: number; saleCampaignId: string | null }[];
  expect(lines).toEqual([expect.objectContaining({ productId: A.id, quantity: 2, priceAtAdd: 800, saleCampaignId: 'b66-campaign' })]);
  await setCart(page, [
    { id: A.id, qty: 2, price: 800, sale: true },
    { id: C.id, qty: 1, price: 500, sale: false },
  ]);
  await page.goto('/cart');
  const tag = page.getByTestId('cart-sale-tag');
  await expect(tag).toHaveCount(1);
  await expect(tag).toContainText(`${NAME} · ends in 2d `);
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/cart-390-light.png` });

  await setAddress(page);
  await page.goto('/checkout/summary');
  await page.getByLabel('Promo code').fill('E2E10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('promo-sale-hint')).toHaveText(
    `E2E10 took ৳ 50 off. ${NAME} items already have their sale price, so the code skips them.`
  );
  await expect(page.getByTestId('summary-campaign-savings')).toHaveText(`${NAME} savings−৳ 400`);
  const fee = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.checkout-summary-card__row')].find((r) => r.textContent?.startsWith('Delivery'));
    return Number((row?.lastElementChild?.textContent ?? '').replace(/[^\d.]/g, ''));
  });
  // The same order in e2e/sql/batch-66.sql: place_order_core charges
  // ৳1,600 + ৳500 − ৳50 + delivery.
  const expected = 2050 + fee;
  await expect(page.getByTestId('summary-total').locator('[data-total]')).toHaveAttribute('data-total', String(expected));
  await expect(page.getByTestId('summary-subtotal')).toHaveText('৳ 2,500');
  await noSideScroll(page);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/summary-390-light.png`, fullPage: true });
  await setTheme(page, 'dark');
  await page.screenshot({ path: `${SHOTS}/summary-390-dark.png`, fullPage: true });
  await setTheme(page, 'light');

  const placed = await mockRpc(page, 'place_order', () => [
    { order_id: randomUUID(), order_number: 'B66-0001', total: expected, discount: 50, advance_discount: 0, store_wallet: 0 },
  ]);
  const before = live.length;
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/checkout\/success/);
  expect(live.length, 'the sales were checked again before placing').toBe(before + 1);
  expect(placed).toHaveLength(1);
  expect(placed[0].p_promo_code).toBe('E2E10');
  expect(placed[0].p_items).toEqual([
    { product_id: A.id, variant_id: null, quantity: 2 },
    { product_id: C.id, variant_id: null, quantity: 1 },
  ]);
});

test('every item on sale: the code is not applied, with its own message', async ({ page }) => {
  await signInAsTestCustomer(page);
  await withFakeProducts(page);
  await mockRpc(page, 'live_campaigns', () => [campaignJson()]);
  await mockPromo(page);
  await page.goto('/');
  await setCart(page, [{ id: A.id, qty: 1, price: 800, sale: true }]);
  await setAddress(page);
  await page.goto('/checkout/summary');
  await page.getByLabel('Promo code').fill('E2E10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText("Every item in your cart is already on sale, so this code can't be used.")).toBeVisible();
  await expect(page.locator('.checkout-summary-card__row--discount')).toHaveCount(0);
});

test('a sale that ends: the cart re-prices itself, the page says the sale has ended', async ({ page }) => {
  test.setTimeout(90_000);
  await withFakeProducts(page);
  const endsAt = new Date(Date.now() + 9000).toISOString();
  let ended = false;
  await mockRpc(page, 'live_campaigns', () => (ended ? [] : [campaignJson({ ends_at: endsAt })]));
  await page.goto('/');
  await setCart(page, [{ id: A.id, qty: 1, price: 800, sale: true }]);
  await page.goto('/cart');
  await expect(page.getByTestId('cart-sale-tag')).toBeVisible();
  await expect(page.locator('.checkout-cart__unit-price')).toHaveText('৳ 800');
  await expect(page.getByTestId('cart-sale-tag')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.checkout-cart__unit-price')).toHaveText('৳ 1,000');
  ended = true;
  await page.goto(`/campaign/${SLUG}`);
  await expect(page.getByTestId('campaign-ended')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This sale has ended' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/campaign-ended-390-light.png` });
  await page.getByRole('link', { name: 'Browse all products' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('campaign-card')).toHaveCount(0);
  await expect(page.locator('.product-card', { hasText: A.name }).getByTestId('campaign-tag')).toHaveCount(0);
});

test('glitter style: Home and campaign page, the animation, reduced motion turns it off', async ({ page }) => {
  test.setTimeout(90_000);
  await withFakeProducts(page);
  await mockRpc(page, 'live_campaigns', () => [campaignJson({ style: 'glitter', name: '12.12', slug: SLUG })]);
  await page.goto('/');
  const card = page.getByTestId('campaign-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('Mega sale · Limited time');
  await expect(card.locator('.cmp-sp').first()).toBeAttached();
  for (const scheme of ['light', 'dark'] as const) {
    await setTheme(page, scheme);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${SHOTS}/home-glitter-390-${scheme}.png` });
  }
  for (let i = 1; i <= 3; i++) {
    await card.screenshot({ path: `${SHOTS}/glitter-frame-${i}.png` });
    await page.waitForTimeout(700);
  }
  await expect(page.locator('.product-card', { hasText: A.name }).getByTestId('campaign-tag')).toHaveClass(/cmp-tag--glitter/);
  await card.click();
  await expect(page.getByTestId('campaign-hero')).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await setTheme(page, scheme);
    await page.screenshot({ path: `${SHOTS}/campaign-page-glitter-390-${scheme}.png` });
  }
  await noSideScroll(page);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motion = await page.evaluate(() => {
    const el = document.querySelector('.cmp-sp, .cmp-shine');
    return el ? getComputedStyle(el).animationName : 'missing';
  });
  expect(motion).toBe('none');
});

/* ------------------------------------------------------------- admin */

function adminList() {
  const now = Date.now();
  return [
    {
      ...campaignJson(),
      ends_at: new Date(now + (2 * 86400 + 4 * 3600 + 600) * 1000).toISOString(),
      is_enabled: true,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      items: [
        { product_id: A.id, variant_id: null, campaign_price: null, sort_order: 0 },
        { product_id: B.id, variant_id: null, campaign_price: null, sort_order: 100 },
        { product_id: C.id, variant_id: null, campaign_price: null, sort_order: 200 },
      ],
      orders: 3,
      sold: 4200,
      given_off: 900,
    },
    {
      ...campaignJson({ id: 'b66-later', name: '12.12 B66', slug: '12-12-b66', style: 'glitter', discount_mode: 'own_price', percent: null }),
      starts_at: new Date(now + 3 * 86400_000 + 60_000).toISOString(),
      ends_at: new Date(now + 5 * 86400_000).toISOString(),
      is_enabled: true,
      items: [{ product_id: C.id, variant_id: null, campaign_price: 400, sort_order: 0 }],
      orders: 0,
      sold: 0,
      given_off: 0,
    },
    {
      ...campaignJson({ id: 'b66-past', name: 'Eid B66', slug: 'eid-b66' }),
      starts_at: new Date(now - 9 * 86400_000).toISOString(),
      ends_at: new Date(now - 2 * 86400_000).toISOString(),
      is_enabled: true,
      orders: 0,
      sold: 0,
      given_off: 0,
    },
  ];
}

async function itemNames(page: Page): Promise<string[]> {
  return page.getByTestId('campaign-item-name').allTextContents();
}

async function cdpDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

for (const size of [
  { label: '390', width: 390, height: 844 },
  { label: '1440', width: 1440, height: 900 },
]) {
  test(`admin: list and editor at ${size.label} px (sorting, saving)`, async ({ page }) => {
    test.setTimeout(120_000);
    admin ??= await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
    await page.setViewportSize({ width: size.width, height: size.height });
    await useSessionInPage(page, admin);
    await withFakeProducts(page);
    await mockRpc(page, 'live_campaigns', () => []);
    await mockRpc(page, 'admin_campaigns', () => adminList());
    const saved = await mockRpc(page, 'admin_save_campaign', () => 'b66-campaign');

    await page.goto('/admin/campaigns');
    await expect(page).toHaveURL(/\/admin\?tab=campaigns$/);
    const rows = page.getByTestId('campaign-row');
    await expect(rows).toHaveCount(3, { timeout: 20_000 });
    await expect(rows.nth(0).getByTestId('campaign-status')).toHaveText(/^Live · 2d 4h left$/);
    await expect(rows.nth(1).getByTestId('campaign-status')).toHaveText('Starts in 3 days');
    await expect(rows.nth(2).getByTestId('campaign-status')).toHaveText('Ended');
    await expect(rows.nth(0)).toContainText('20% off · 3 products');
    await expect(rows.nth(1)).toContainText('Own prices · 1 product');
    await expect(rows.nth(0).getByTestId('campaign-stats')).toContainText('Given off');
    await expect(rows.nth(1).getByTestId('campaign-stats')).toHaveCount(0);
    expect(await orangeCount(page, '[data-testid="admin-campaigns"]'), 'one orange: + New').toBe(1);
    await page.locator('.adm-chips').getByRole('button', { name: /^Live/ }).click();
    await expect(rows).toHaveCount(1);
    await page.locator('.adm-chips').getByRole('button', { name: /^All/ }).click();
    await noSideScroll(page);
    for (const scheme of ['dark', 'light'] as const) {
      await setTheme(page, scheme);
      await page.screenshot({ path: `${SHOTS}/admin-list-${size.label}-${scheme}.png`, fullPage: true });
    }

    await rows.nth(0).locator('.cmpa-card__open').click();
    await expect(page).toHaveURL(/\/admin\/campaigns\/b66-campaign\/edit$/);
    await expect(page.getByTestId('campaign-name')).toHaveValue(NAME);
    await expect.poll(() => itemNames(page)).toEqual([A.name, B.name, C.name]);
    await expect(page.getByTestId('campaign-preview')).toContainText(NAME);

    // ↑ ↓
    await page.getByRole('button', { name: `Move ${A.name} down` }).click();
    expect(await itemNames(page)).toEqual([B.name, A.name, C.name]);
    await page.getByRole('button', { name: `Move ${C.name} up` }).click();
    expect(await itemNames(page)).toEqual([B.name, C.name, A.name]);

    // Drag by the handle (mouse on a computer, a finger on a phone).
    const handles = page.getByTestId('campaign-handle');
    const first = await handles.nth(0).boundingBox();
    const last = await page.getByTestId('campaign-item').nth(2).boundingBox();
    if (!first || !last) throw new Error('no handle');
    const from = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
    const to = { x: from.x, y: last.y + last.height - 4 };
    if (size.width < 1024) {
      await cdpDrag(page, from, to);
    } else {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(from.x, from.y + ((to.y - from.y) * i) / 10);
      await page.mouse.up();
    }
    expect(await itemNames(page)).toEqual([C.name, A.name, B.name]);

    if (size.width < 1024) {
      // A finger resting on a row (not the handle) still scrolls the page.
      await page.evaluate(() => window.scrollTo(0, 0));
      const row = await page.getByTestId('campaign-item').nth(1).locator('.cmpa-item__name').boundingBox();
      if (!row) throw new Error('no row');
      const y0 = await page.evaluate(() => window.scrollY);
      const startY = Math.round(Math.min(row.y + 10, size.height - 140));
      await cdpDrag(page, { x: Math.round(row.x + 20), y: startY }, { x: Math.round(row.x + 20), y: startY - 300 });
      await page.waitForTimeout(300);
      const y1 = await page.evaluate(() => window.scrollY);
      expect(y1, 'the page scrolled under the finger').toBeGreaterThan(y0 + 40);
      expect(await itemNames(page), 'scrolling never reorders').toEqual([C.name, A.name, B.name]);
      await page.evaluate(() => window.scrollTo(0, 0));
    }

    await noSideScroll(page);
    for (const scheme of ['dark', 'light'] as const) {
      await setTheme(page, scheme);
      await page.screenshot({ path: `${SHOTS}/admin-editor-${size.label}-${scheme}.png`, fullPage: true });
    }
    expect(await orangeCount(page, '[data-testid="campaign-editor"]'), 'one orange: Save campaign').toBe(1);

    await page.getByRole('button', { name: 'Save campaign' }).filter({ visible: true }).click();
    await expect.poll(() => saved.length).toBe(1);
    const p = saved[0].p as { items: { product_id: string; sort_order: number }[]; discount_mode: string; percent: number; name: string };
    expect(p.name).toBe(NAME);
    expect(p.discount_mode).toBe('percent');
    expect(p.percent).toBe(20);
    expect(p.items.map((i) => i.product_id)).toEqual([C.id, A.id, B.id]);
    expect(p.items.map((i) => i.sort_order)).toEqual([0, 100, 200]);
    await expect(page).toHaveURL(/\/admin\?tab=campaigns$/);
  });
}

test('admin: own price editor shows each price field and refuses a price at retail', async ({ page }) => {
  test.setTimeout(90_000);
  admin ??= await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await useSessionInPage(page, admin);
  await withFakeProducts(page);
  await mockRpc(page, 'live_campaigns', () => []);
  await mockRpc(page, 'admin_campaigns', () => adminList());
  const saved = await mockRpc(page, 'admin_save_campaign', () => 'new-id');
  await page.goto('/admin/campaigns/new');
  await page.getByTestId('campaign-name').fill('Own B66');
  await page.getByTestId('campaign-mode-own_price').click();
  await page.getByTestId('campaign-style-glitter').click();
  await page.getByTestId('campaign-add').click();
  await page.getByTestId('campaign-search').fill('B66 Calm');
  await page.getByTestId('manual-product-result').first().click();
  await expect.poll(() => itemNames(page)).toEqual([C.name]);
  await page.getByTestId('campaign-row-price').fill('500');
  await page.getByRole('button', { name: 'Save campaign' }).filter({ visible: true }).click();
  await expect(page.getByTestId('campaign-error')).toHaveText(`${C.name}: the sale price must be below ৳500.`);
  expect(saved).toHaveLength(0);
  await page.getByTestId('campaign-row-price').fill('400');
  await expect(page.getByTestId('campaign-preview')).toContainText('20% off every item');
  await page.screenshot({ path: `${SHOTS}/admin-editor-own-390-light.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save campaign' }).filter({ visible: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  const p = saved[0].p as { items: { product_id: string; campaign_price: number }[]; style: string; discount_mode: string };
  expect(p.style).toBe('glitter');
  expect(p.discount_mode).toBe('own_price');
  expect(p.items).toEqual([{ product_id: C.id, variant_id: null, campaign_price: 400, sort_order: 0 }]);
});
