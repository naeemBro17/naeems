import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { signInAsTestCustomer } from './helpers/auth';

// Batch 67: the Cart and Order Summary redesign.
//
// Only the look changed, so these screens use MADE-UP products that exist
// only inside the test browser (the shop's product list is answered with
// them added), a made-up campaign, promo code, shop number and wallet, and
// placing the order is answered in the browser too. Nothing is written to
// Supabase. No real Storage file is downloaded (./fixtures).

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_EMAIL || !E2E_PASSWORD, 'Needs the test account in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-67-screens';
const WIDTH = 390;
const SHOP_NUMBER = '01711000067';
const CAMPAIGN = 'Winter Glow B67';

// A: in the campaign (20% off 1,000). B: own offer price. C: no discount,
// a long name. D: only 2 in stock (for the limit popup).
const A = { id: randomUUID(), name: 'B67 Aqua Gel Cleanser', retail: 1000, offer: null as number | null, stock: 40 };
const B = { id: randomUUID(), name: 'B67 Bright Vitamin C Serum', retail: 1600, offer: 1350 as number | null, stock: 40 };
const C = {
  id: randomUUID(),
  name: 'B67 Calm Night Repair Cream with Ceramides and Australian Botanicals 50 ml',
  retail: 500,
  offer: null as number | null,
  stock: 40,
};
const D = { id: randomUUID(), name: 'B67 Daily Sun Fluid SPF 50', retail: 900, offer: null as number | null, stock: 2 };
const FAKES = [A, B, C, D];

const ADDRESS = { fullName: 'Ayesha B67', phone: '01712345678', division: 'Dhaka', district: 'Dhaka', thana: 'Dhanmondi', fullAddress: 'House 32, Road 7' };

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

/** The shop's product reads with the made-up products added (no photos). */
async function withFakeProducts(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/products_view(\?|$)/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    // A page that has already closed drops the answer.
    let response: Awaited<ReturnType<Route['fetch']>>;
    let body: unknown;
    try {
      response = await route.fetch();
      body = await response.json();
    } catch {
      return;
    }
    if (!Array.isArray(body)) return route.fulfill({ response, json: body }).catch(() => undefined);
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
        sku: `B67-${f.id.slice(0, 6)}`,
        slug: `b67-${f.id.slice(0, 8)}`,
        name: f.name,
        retail_price: f.retail,
        offer_price: f.offer,
        is_active: true,
        stock_status: 'in_stock',
        stock_quantity: f.stock,
        keep_selling: false,
        brand_id: null,
        is_featured: false,
      };
    });
    await route.fulfill({ response, json: [...rows, ...body] }).catch(() => undefined);
  });
}

/** The shop number and a 0.5% advance discount, answered in the browser. */
async function withShopSettings(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/app_settings\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    let response: Awaited<ReturnType<Route['fetch']>>;
    let all: { key: string; value: string }[];
    try {
      response = await route.fetch();
      all = (await response.json()) as { key: string; value: string }[];
    } catch {
      return;
    }
    const rows = all.filter((r) => r.key !== 'shop_bkash_number' && !r.key.startsWith('advance_discount_'));
    rows.push(
      { key: 'shop_bkash_number', value: SHOP_NUMBER },
      { key: 'advance_discount_enabled', value: 'true' },
      { key: 'advance_discount_type', value: 'percent' },
      { key: 'advance_discount_value', value: '0.5' }
    );
    await route.fulfill({ response, json: rows }).catch(() => undefined);
  });
}

function campaignJson(style: 'plain' | 'glitter') {
  return {
    id: 'b67-campaign',
    name: CAMPAIGN,
    slug: 'winter-glow-b67',
    style,
    discount_mode: 'percent',
    percent: 20,
    starts_at: new Date(Date.now() - 3600_000).toISOString(),
    ends_at: new Date(Date.now() + (2 * 86400 + 4 * 3600) * 1000).toISOString(),
    items: [{ product_id: A.id, variant_id: null, campaign_price: null, sort_order: 0 }],
  };
}

async function mockPromo(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/promo_codes\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    if (url.searchParams.get('code') !== 'eq.SAVE10') return route.fallback();
    await route.fulfill(json({ code: 'SAVE10', discount_amount: 10, discount_type: 'percent', max_uses: null, times_used: 0, expires_at: null, active: true }));
  });
}

type Line = { id: string; qty: number; price: number; sale?: boolean };

/** Seeds the cart (and the delivery address) once, before the first page. */
async function seed(page: Page, lines: Line[]): Promise<void> {
  const cart = lines.map((l) => ({
    productId: l.id,
    variantId: null,
    variantLabel: null,
    quantity: l.qty,
    priceAtAdd: l.price,
    saleCampaignId: l.sale ? 'b67-campaign' : null,
  }));
  await page.addInitScript(
    ([c, s]) => {
      if (window.sessionStorage.getItem('e2e-b67-seeded')) return;
      window.sessionStorage.setItem('e2e-b67-seeded', '1');
      window.localStorage.setItem('nph_cart', c);
      window.sessionStorage.setItem('nph_checkout_state', s);
    },
    [JSON.stringify(cart), JSON.stringify({ zoneId: 'inside_dhaka', address: ADDRESS, promo: null, lastOrder: null })]
  );
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

/** Orange-filled elements on the page (--color-primary #F05020, and the
 *  brand #FF7A45 in case it is ever used directly). */
async function orangeCount(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return ['rgb(240, 80, 32)', 'rgb(255, 122, 69)'].includes(getComputedStyle(el).backgroundColor) && r.width > 0 && r.height > 0;
      })
      .map((el) => el.textContent?.trim() ?? el.className)
  );
}

/** Scrolled to the bottom, the last card ends above the fixed bar. */
async function barNeverCovers(page: Page, bar: string, last: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(200);
  const [barTop, lastBottom] = await page.evaluate(
    ([b, l]) => {
      const els = document.querySelectorAll(l);
      return [document.querySelector(b)?.getBoundingClientRect().top ?? 0, els[els.length - 1]?.getBoundingClientRect().bottom ?? 0];
    },
    [bar, last] as const
  );
  expect(lastBottom, 'the bar never covers the last card').toBeLessThanOrEqual(barTop);
}

async function openCart(page: Page, lines: Line[], style: 'plain' | 'glitter' | null = 'plain'): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await withFakeProducts(page);
  await mockRpc(page, 'live_campaigns', () => (style ? [campaignJson(style)] : []));
  await seed(page, lines);
  await page.goto('/cart');
  await expect(page.getByTestId('cart-line').first()).toBeVisible({ timeout: 30_000 });
}

const taka = (n: number) => `৳ ${n.toLocaleString('en-US')}`;

/* ------------------------------------------------------------------ cart */

test('Cart: piece count, struck retail, "each", You save, one orange (Checkout), no sideways scroll at 390 and 360, light and dark', async ({ page }) => {
  test.setTimeout(120_000);
  await openCart(page, [
    { id: A.id, qty: 2, price: 800, sale: true },
    { id: B.id, qty: 1, price: 1350 },
    { id: C.id, qty: 1, price: 500 },
  ]);
  await expect(page.getByTestId('cart-line')).toHaveCount(3);
  await expect(page.getByTestId('cart-count')).toHaveText('4 items');
  // The stepper: three bars, the first one dark (Cart is the current step).
  const bars = await page.locator('.checkout-stepper__step').evaluateAll((els) =>
    els.map((el) => {
      const before = getComputedStyle(el, '::before');
      return { width: parseFloat(before.width) || 0, height: before.height, bg: before.backgroundColor };
    })
  );
  expect(bars).toHaveLength(3);
  for (const bar of bars) {
    expect(bar.width).toBeGreaterThan(80);
    expect(bar.height).toBe('3px');
  }
  expect(bars[0].bg).not.toBe(bars[1].bg);

  const a = page.getByTestId('cart-line').filter({ hasText: A.name });
  await expect(a.getByTestId('cart-line-total')).toHaveText(taka(1600));
  await expect(a.getByTestId('cart-unit-price')).toHaveText(`${taka(800)} each ${taka(1000)}`);
  await expect(a.getByTestId('cart-unit-price').locator('s')).toHaveText(taka(1000));
  await expect(a.getByTestId('cart-sale-tag')).toContainText(`${CAMPAIGN} · ends in 2d `);
  const b = page.getByTestId('cart-line').filter({ hasText: B.name });
  await expect(b.getByTestId('cart-line-total')).toHaveText(taka(1350));
  await expect(b.locator('.b67-price s')).toHaveText(taka(1600));
  await expect(b.getByTestId('cart-unit-price')).toHaveCount(0);
  // No discount: no strike, no gap.
  const c = page.getByTestId('cart-line').filter({ hasText: C.name });
  await expect(c.locator('s')).toHaveCount(0);
  // The long name wraps to two lines and is cut only past two.
  const nameLines = await c.locator('.b67-name').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(nameLines).toBe(2);

  // − at 1 is a bin; at 2 it is a minus.
  await expect(b.getByTestId('cart-minus')).toHaveAttribute('aria-label', `Remove ${B.name}`);
  await expect(a.getByTestId('cart-minus')).toHaveAttribute('aria-label', `Decrease quantity of ${A.name}`);

  const bar = page.getByTestId('cart-bar');
  await expect(bar).toContainText('Subtotal');
  await expect(page.getByTestId('cart-subtotal')).toHaveText(taka(1600 + 1350 + 500));
  // (1,000 − 800) × 2 + (1,600 − 1,350) = 650.
  await expect(page.getByTestId('cart-you-save')).toHaveText(`You save ${taka(650)}`);
  await expect(page.getByTestId('cart-trust')).toHaveText("100% authentic, imported by Naeem's.");
  expect(await orangeCount(page)).toEqual(['Checkout']);
  // Green only for money saved.
  expect(await page.getByTestId('cart-you-save').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(31, 138, 71)');
  await noSideScroll(page);
  await barNeverCovers(page, '[data-testid="cart-bar"]', '.b67-main > *');

  for (const scheme of ['light', 'dark'] as const) {
    await setTheme(page, scheme);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/cart-390-${scheme}.png`, fullPage: true });
  }
  expect(await orangeCount(page)).toEqual(['Checkout']);
  await setTheme(page, 'light');

  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(300);
  await noSideScroll(page);
  await barNeverCovers(page, '[data-testid="cart-bar"]', '.b67-main > *');
  const barFits = await bar.evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(barFits, 'the bar fits at 360 px').toBe(true);
  await page.screenshot({ path: `${SHOTS}/cart-360-light.png`, fullPage: true });

  // Checkout still goes on (signed out: the login sheet).
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('Cart: a glitter campaign line has the gold tag with the star; a plain one is black', async ({ page }) => {
  await openCart(page, [{ id: A.id, qty: 1, price: 800, sale: true }, { id: C.id, qty: 1, price: 500 }], 'glitter');
  const tag = page.getByTestId('cart-sale-tag');
  await expect(tag).toHaveClass(/cmp-linetag--glitter/);
  await expect(tag.locator('svg')).toHaveCount(1);
  await expect(tag.locator('b')).toHaveText(/^2d /);
  expect(await tag.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(243, 213, 138)');
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/cart-390-glitter.png`, fullPage: true });

  const plain = await page.context().newPage();
  await openCart(plain, [{ id: A.id, qty: 1, price: 800, sale: true }], 'plain');
  const plainTag = plain.getByTestId('cart-sale-tag');
  await expect(plainTag).not.toHaveClass(/cmp-linetag--glitter/);
  await expect(plainTag.locator('svg')).toHaveCount(0);
  expect(await plainTag.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(20, 20, 20)');
  await plain.close();
});

test('Cart: empty cart, its words and one orange (Browse products)', async ({ page }) => {
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await page.addInitScript(() => window.localStorage.setItem('nph_cart', '[]'));
  await page.goto('/cart');
  await expect(page.getByText('Your cart is empty')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Find something your skin will love.')).toBeVisible();
  await expect(page.getByTestId('cart-bar')).toHaveCount(0);
  await expect(page.getByTestId('checkout-stepper')).toHaveCount(0);
  expect(await orangeCount(page)).toEqual(['Browse products']);
  await noSideScroll(page);
  for (const scheme of ['light', 'dark'] as const) {
    await setTheme(page, scheme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/cart-empty-390-${scheme}.png`, fullPage: true });
  }
  await setTheme(page, 'light');
  await page.getByRole('link', { name: 'Browse products' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('Cart: + at the limit shows the limit popup at the stepper', async ({ page }) => {
  await openCart(page, [{ id: D.id, qty: 2, price: 900 }, { id: C.id, qty: 1, price: 500 }], null);
  const d = page.getByTestId('cart-line').filter({ hasText: D.name });
  await expect(d.getByTestId('cart-plus')).toHaveClass(/b67-qty__btn--max/);
  await d.getByTestId('cart-plus').click();
  const pop = page.getByTestId('limit-popup');
  await expect(pop).toBeVisible();
  await expect(d.getByTestId('cart-qty')).toHaveText('2');
  await page.waitForTimeout(400);
  const [popBox, stepBox] = await Promise.all([pop.boundingBox(), d.getByTestId('cart-stepper').boundingBox()]);
  expect(popBox && stepBox).toBeTruthy();
  if (popBox && stepBox) {
    // Right next to the stepper (above or below it), inside the screen.
    const gap = Math.min(Math.abs(popBox.y + popBox.height - stepBox.y), Math.abs(stepBox.y + stepBox.height - popBox.y));
    expect(gap).toBeLessThanOrEqual(24);
    expect(popBox.x).toBeGreaterThanOrEqual(0);
    expect(popBox.x + popBox.width).toBeLessThanOrEqual(WIDTH);
  }
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/cart-limit-popup-390.png`, fullPage: true });
});

test('Cart: − at 1 removes with "Removed · Undo", the toast clear of the bar; Undo puts it back', async ({ page }) => {
  // A sale line stays, so the bar keeps its taller "You save" line.
  await openCart(page, [{ id: B.id, qty: 1, price: 1350 }, { id: A.id, qty: 1, price: 800, sale: true }, { id: C.id, qty: 2, price: 500 }]);
  await page.getByTestId('cart-line').filter({ hasText: B.name }).getByTestId('cart-minus').click();
  const toast = page.getByTestId('undo-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Removed');
  await expect(page.getByTestId('cart-line')).toHaveCount(2);
  await expect(page.getByTestId('cart-count')).toHaveText('3 items');
  await expect(page.getByTestId('cart-you-save')).toBeVisible();
  await page.waitForTimeout(400);
  const [t, bar] = await Promise.all([toast.boundingBox(), page.getByTestId('cart-bar').boundingBox()]);
  expect(t && bar && t.y + t.height <= bar.y, 'the toast sits above the bar').toBe(true);
  await page.screenshot({ path: `${SHOTS}/cart-removed-undo-390.png` });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('cart-line')).toHaveCount(3);
  await expect(page.getByTestId('cart-count')).toHaveText('4 items');
});

/* --------------------------------------------------------------- summary */

interface Placed {
  fn: string;
  body: Record<string, unknown>;
}

async function openSummary(page: Page, lines: Line[], balance = 0): Promise<Placed[]> {
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await signInAsTestCustomer(page);
  await withFakeProducts(page);
  await withShopSettings(page);
  await mockPromo(page);
  await mockRpc(page, 'live_campaigns', () => []);
  await mockRpc(page, 'store_wallet_my', () => ({ available: true, open: true, balance, due: 0, waiting: [], results: [], history: [] }));
  const placed: Placed[] = [];
  await page.route(/\/rest\/v1\/rpc\/place_order(_wallet)?(\?|$)/, async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const fn = route.request().url().includes('place_order_wallet') ? 'place_order_wallet' : 'place_order';
    placed.push({ fn, body });
    const left = Number(await page.getByTestId('summary-total').locator('[data-total]').getAttribute('data-total'));
    await route.fulfill(
      json([{ order_id: randomUUID(), order_number: 'B67-0001', total: left + Number(body.p_store_wallet ?? 0), discount: 0, advance_discount: 0, store_wallet: body.p_store_wallet ?? 0 }])
    );
  });
  await seed(page, lines);
  await page.goto('/checkout/summary');
  await expect(page.getByRole('button', { name: 'Place order' })).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  return placed;
}

/** The bar's total and the bill's total say the same, and match data-total. */
async function totalsAgree(page: Page): Promise<number> {
  const target = Number(await page.getByTestId('summary-total').locator('[data-total]').getAttribute('data-total'));
  await expect(page.getByTestId('summary-total').locator('b')).toHaveText(taka(target));
  await expect(page.getByTestId('summary-bar-total')).toHaveText(taka(target));
  return target;
}

const SUMMARY_LINES: Line[] = [
  { id: B.id, qty: 1, price: 1350 },
  { id: C.id, qty: 3, price: 500 },
];

test('Summary: address, items, the promo row (tap, apply, SAVE10 applied), the bill, one orange, place a COD order', async ({ page }) => {
  test.setTimeout(120_000);
  const placed = await openSummary(page, SUMMARY_LINES);
  const address = page.getByTestId('summary-address');
  await expect(address).toContainText('Delivering to');
  await expect(address).toContainText(ADDRESS.fullName);
  await expect(address).toContainText('House 32, Road 7, Dhanmondi, Dhaka');
  await expect(address).toContainText('Inside Dhaka');
  await expect(page.getByText('Your order · 4 items')).toBeVisible();
  await expect(page.getByTestId('summary-item')).toHaveCount(2);
  await expect(page.getByTestId('summary-item-qty').nth(1)).toHaveText('3');

  // The promo field opens from its row; a bad code gets the one message.
  const promo = page.getByTestId('summary-promo');
  await expect(page.getByLabel('Promo code')).toHaveCount(0);
  await promo.getByRole('button', { name: 'Add a promo code' }).click();
  await expect(page.getByLabel('Promo code')).toHaveAttribute('placeholder', 'Enter code');
  await page.getByLabel('Promo code').fill('NOPE67');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(promo.getByRole('alert')).toHaveText('Invalid or expired code');
  await page.getByLabel('Promo code').fill('SAVE10');
  await page.getByRole('button', { name: 'Apply' }).click();
  // 10% of 2,850 = 285. The row says it and closes the field.
  await expect(promo).toContainText('SAVE10 applied');
  await expect(promo).toContainText('Tap to change');
  await expect(promo).toContainText(`−${taka(285)}`);
  await expect(page.getByLabel('Promo code')).toHaveCount(0);
  await expect(page.getByTestId('summary-promo-row')).toHaveText(`Promo (SAVE10)−${taka(285)}`);
  expect(await page.getByTestId('summary-promo-row').evaluate((el) => getComputedStyle(el.lastElementChild as Element).color)).toBe('rgb(31, 138, 71)');

  await expect(page.getByTestId('summary-subtotal')).toHaveText(taka(2850));
  await expect(page.getByTestId('summary-total')).toContainText('Pay on delivery');
  await expect(page.getByTestId('summary-bar')).toContainText('Pay on delivery');
  await expect(page.getByTestId('pay-option-cod')).toContainText('Pay the rider when it arrives');
  await expect(page.getByTestId('pay-advance-group')).toContainText('Pay in advance');
  await expect(page.getByTestId('advance-badge')).toHaveText('0.5% OFF');
  await totalsAgree(page);
  expect(await orangeCount(page)).toEqual(['Place order']);
  await noSideScroll(page);
  await barNeverCovers(page, '[data-testid="summary-bar"]', '.b67-main > *');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/summary-cod-promo-390-light.png`, fullPage: true });
  // What the phone shows: the top, and the bottom with the bar.
  await page.screenshot({ path: `${SHOTS}/summary-cod-promo-390-light-top.png` });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/summary-cod-promo-390-light-bottom.png` });

  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(300);
  await noSideScroll(page);
  await barNeverCovers(page, '[data-testid="summary-bar"]', '.b67-main > *');
  await page.screenshot({ path: `${SHOTS}/summary-cod-promo-360-light.png`, fullPage: true });

  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/checkout\/success/, { timeout: 20_000 });
  expect(placed).toHaveLength(1);
  expect(placed[0].fn).toBe('place_order');
  expect(placed[0].body.p_payment_method).toBe('cod');
  expect(placed[0].body.p_promo_code).toBe('SAVE10');
});

test('Summary: bKash steps open under bKash (Copy copies the shop number); Nagad under Nagad in its colours; a bKash order is placed', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const placed = await openSummary(page, SUMMARY_LINES);

  await page.getByTestId('pay-option-bkash').click();
  const box = page.getByTestId('wallet-box');
  await expect(box).toContainText('Pay with bKash');
  await expect(box).toContainText(`Send Money ${taka(await totalsAgree(page))} to this number`);
  await expect(box).toContainText('Enter the details below');
  await expect(box.getByLabel('Transaction ID *')).toBeVisible();
  await expect(box.getByLabel('Your bKash number *')).toBeVisible();
  await expect(page.getByTestId('summary-advance')).toBeVisible();
  await expect(page.getByTestId('summary-total')).toContainText('Total payment');
  const [bk, steps, ng] = await Promise.all([
    page.getByTestId('pay-option-bkash').boundingBox(),
    box.boundingBox(),
    page.getByTestId('pay-option-nagad').boundingBox(),
  ]);
  expect(bk && steps && ng && steps.y >= bk.y + bk.height && steps.y + steps.height <= ng.y, 'between bKash and Nagad').toBe(true);

  await box.getByTestId('wallet-copy').click();
  await expect(box.getByTestId('wallet-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SHOP_NUMBER);
  await expect(box.getByTestId('wallet-copy')).toHaveText('Copy', { timeout: 4000 });

  // The fields are still required.
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText('Transaction ID is required')).toBeVisible();
  await expect(page.getByText('Your bKash number is required')).toBeVisible();
  expect(placed).toHaveLength(0);
  expect(await orangeCount(page)).toEqual(['Place order']);
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/summary-bkash-390-light.png`, fullPage: true });
  await page.screenshot({ path: `${SHOTS}/summary-bkash-390-light-screen.png` });

  await page.getByTestId('pay-option-nagad').click();
  await expect(box).toContainText('Pay with Nagad');
  await expect(box.getByLabel('Your Nagad number *')).toBeVisible();
  await expect(box).toHaveClass(/b67-pay--nagad/);
  const [ng2, steps2] = await Promise.all([page.getByTestId('pay-option-nagad').boundingBox(), box.boundingBox()]);
  expect(ng2 && steps2 && steps2.y >= ng2.y + ng2.height, 'under Nagad').toBe(true);
  expect(await box.locator('.b67-pay__step i').first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(236, 28, 36)');
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/summary-nagad-390-light.png`, fullPage: true });
  await page.screenshot({ path: `${SHOTS}/summary-nagad-390-light-screen.png` });

  await page.getByTestId('pay-option-bkash').click();
  await page.locator('#wallet-trx-id').fill('9ak2xyz1ab');
  await page.locator('#wallet-sender').fill('01812345678');
  await totalsAgree(page);
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/checkout\/success/, { timeout: 20_000 });
  expect(placed).toHaveLength(1);
  expect(placed[0].body.p_payment_method).toBe('bkash');
  expect(placed[0].body.p_bkash_trx_id).toBe('9AK2XYZ1AB');
});

test('Summary: wallet on shows the split (dark); a wallet that covers everything hides the payment methods and places the order', async ({ page }) => {
  test.setTimeout(120_000);
  const placed = await openSummary(page, SUMMARY_LINES, 500);
  const card = page.getByTestId('checkout-use-wallet');
  await expect(card).toContainText('Use wallet balance');
  await expect(card).toContainText(`You have ${taka(500)}`);
  await card.getByRole('switch', { name: 'Use wallet balance' }).click();
  const split = page.getByTestId('checkout-wallet-split');
  await expect(split).toContainText('From wallet');
  await expect(split).toContainText(taka(500));
  await expect(split).toContainText('On delivery');
  await expect(page.getByTestId('summary-store-wallet')).toContainText('Paid from wallet');
  await totalsAgree(page);
  await setTheme(page, 'dark');
  await page.waitForTimeout(400);
  expect(await orangeCount(page)).toEqual(['Place order']);
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/summary-wallet-390-dark.png`, fullPage: true });
  await page.screenshot({ path: `${SHOTS}/summary-wallet-390-dark-screen.png` });
  await setTheme(page, 'light');

  const full = await page.context().newPage();
  const fullPlaced = await openSummary(full, SUMMARY_LINES, 50_000);
  await full.getByTestId('checkout-use-wallet').getByRole('switch', { name: 'Use wallet balance' }).click();
  await expect(full.getByTestId('checkout-wallet-full')).toHaveText('Fully paid from your wallet');
  await expect(full.locator('.cf-pay')).toHaveCount(0);
  await expect(full.getByTestId('summary-total')).toContainText('Left to pay');
  await expect(full.getByTestId('summary-bar')).toContainText('Left to pay');
  expect(await totalsAgree(full)).toBe(0);
  await full.getByRole('button', { name: 'Place order' }).click();
  await expect(full).toHaveURL(/\/checkout\/success/, { timeout: 20_000 });
  expect(fullPlaced).toHaveLength(1);
  expect(fullPlaced[0].fn).toBe('place_order_wallet');
  await full.close();
  expect(placed).toHaveLength(0);
});

test('Summary: reduced motion turns the row animations off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSummary(page, SUMMARY_LINES);
  await page.getByTestId('summary-promo').getByRole('button', { name: 'Add a promo code' }).click();
  expect(await page.locator('.b67-promo-form').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.getByTestId('pay-option-bkash').click();
  expect(await page.getByTestId('wallet-box').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
