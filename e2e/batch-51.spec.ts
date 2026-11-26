import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, select, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 51: keep selling when out of stock, the order limit, delivery
// times, the Shopping list, the Wishlist, the admin glass clock and the
// Steadfast clean-up.
//
// The live shop is never changed. The database rules run in
// e2e/sql/batch-51.sql against today's live functions (Batch 61: no old migration is replayed) inside
// ONE transaction that is always rolled back (Inventory mode is switched
// only inside it). The screens run at 390 px (and the admin home at
// 1440 px), light and dark; every new database call they make (the new
// view columns, cart_cover, wishlist_items, admin_shopping_list) is
// answered in the browser, so nothing is saved and nothing needs the SQL
// to have been run.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-51-screens';
const WIDTH = 390;

let admin: TestSession;
let customer: TestSession;

interface LiveProduct {
  id: string;
  name: string;
  slug: string;
  retail_price: number;
  offer_price: number | null;
  image_url: string | null;
}

/** Three plain products (no options) the screens dress up:
 *  on  = keep selling, none in stock (reads "In Stock", "Get it in 3–5 days")
 *  low = sells only from stock, 2 left ("Only 2 left — order soon")
 *  out = sells only from stock, 0 left ("Sold out") */
let picks: { on: LiveProduct; low: LiveProduct; out: LiveProduct };

test.beforeAll(async () => {
  mkdirSync(`${SHOTS}/pdf`, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  const res = await select<LiveProduct[]>(
    null,
    'products_view?select=id,name,slug,retail_price,offer_price,image_url&is_active=eq.true&image_url=not.is.null&order=name.asc&limit=80'
  );
  const variants = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id');
  const withOptions = new Set((variants.data ?? []).map((v) => v.product_id));
  const plain = (res.data ?? []).filter((p) => !withOptions.has(p.id) && p.slug);
  expect(plain.length, 'three plain products to dress up').toBeGreaterThanOrEqual(3);
  picks = { on: plain[0], low: plain[1], out: plain[2] };
});

/* ------------------------------------------------------ the database rules */

test('database: keep selling, order limit (not for wholesalers), Inventory mode On and Off, Shopping list, wishlist rules, Steadfast "not paid" rule, Money position unchanged (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const fill = (s: string) => s.replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL).replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const before = fill(readFileSync('e2e/sql/batch-51-before.sql', 'utf8'));
  const tests = fill(readFileSync('e2e/sql/batch-51.sql', 'utf8'));
  const output = await runSql(`BEGIN;\n${before}\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(50);
});

/* ------------------------------------------------------- browser answers */

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Row = Record<string, unknown>;

/** What products_view returns to a customer once the SQL is run. */
function dressProduct(row: Row): Row {
  const id = String(row.id);
  if (id === picks.on.id) return { ...row, keep_selling: true, stock_quantity: null, stock_status: 'in_stock', in_hand: false };
  if (id === picks.low.id) return { ...row, keep_selling: false, stock_quantity: 2, stock_status: 'in_stock', in_hand: true };
  if (id === picks.out.id) return { ...row, keep_selling: false, stock_quantity: 0, stock_status: 'out_of_stock', in_hand: false };
  const qty = row.stock_quantity as number | null;
  const inHand = qty === null || qty === undefined ? row.stock_status !== 'out_of_stock' : qty > 0;
  return { ...row, keep_selling: true, stock_quantity: null, stock_status: 'in_stock', in_hand: inHand };
}

interface ShopState {
  wishlist: string[];
}

async function answerShop(page: Page, state: ShopState): Promise<void> {
  await page.route(/\/rest\/v1\/products_view\?/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Row[] | Row;
    const dressed = Array.isArray(body) ? body.map(dressProduct) : body && typeof body === 'object' && 'id' in body ? dressProduct(body) : body;
    await route.fulfill({ response: res, json: dressed });
  });
  await page.route(/\/rest\/v1\/product_variants_view\?/, async (route) => {
    const url = new URL(route.request().url());
    const cols = (url.searchParams.get('select') ?? '').split(',').filter((c) => c !== 'keep_selling' && c !== 'in_hand');
    url.searchParams.set('select', cols.join(','));
    const res = await route.fetch({ url: url.toString() });
    const rows = (await res.json()) as Row[];
    const dressed = Array.isArray(rows)
      ? rows.map((r) => {
          const qty = r.stock_quantity as number | null;
          return { ...r, keep_selling: true, in_stock: true, stock_quantity: null, in_hand: qty === null ? r.in_stock === true : qty > 0 };
        })
      : rows;
    await route.fulfill({ response: res, json: dressed });
  });
  await page.route(/\/rest\/v1\/rpc\/cart_cover/, async (route) => {
    const args = (route.request().postDataJSON() ?? {}) as { p_lines?: { product_id: string; variant_id: string | null }[] };
    await json(
      route,
      (args.p_lines ?? []).map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, covered: l.product_id !== picks.on.id }))
    );
  });
  await page.route(/\/rest\/v1\/wishlist_items/, async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await json(route, state.wishlist.map((id, i) => ({ product_id: id, created_at: new Date(Date.now() - i * 60_000).toISOString() })));
      return;
    }
    if (req.method() === 'POST') {
      const row = (req.postDataJSON() ?? {}) as { product_id?: string };
      if (row.product_id && !state.wishlist.includes(row.product_id)) state.wishlist.unshift(row.product_id);
      await route.fulfill({ status: 201, body: '' });
      return;
    }
    if (req.method() === 'DELETE') {
      const id = new URL(req.url()).searchParams.get('product_id')?.replace(/^eq\./, '');
      state.wishlist = state.wishlist.filter((x) => x !== id);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fallback();
  });
}

async function openShop(page: Page, theme: 'light' | 'dark', session: TestSession | null, path: string): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  if (session) await useSessionInPage(page, session);
  await page.goto(path);
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
}

/** No brand orange (#FF7A45 / #F05020 family) inside the element. */
async function noOrange(page: Page, selector: string): Promise<void> {
  const orange = await page.locator(selector).first().evaluate((root) => {
    const hits: string[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const s = getComputedStyle(el);
      for (const c of [s.color, s.backgroundColor, s.borderTopColor]) {
        const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c);
        if (m && Number(m[1]) > 225 && Number(m[2]) > 75 && Number(m[2]) < 140 && Number(m[3]) < 90) hits.push(`${String(el.className)}: ${c}`);
      }
    }
    return hits;
  });
  expect(orange, 'no orange').toEqual([]);
}

/* ------------------------------------------------------------ the shop */

for (const theme of ['light', 'dark'] as const) {
  test(`shop at 390 px (${theme}): In Stock at stock 0, delivery lines, glass heart, limit popups, cart note`, async ({ page }) => {
    test.setTimeout(120_000);
    const state: ShopState = { wishlist: [] };
    await answerShop(page, state);
    await openShop(page, theme, customer, `/search?q=${encodeURIComponent(picks.on.name)}`);

    // Card at real 2-column width: stock 0 + keep selling reads "In Stock".
    const card = page.locator('.product-card', { hasText: picks.on.name }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.product-card__stock')).toHaveText('In Stock');
    const width = (await card.boundingBox())?.width ?? 0;
    expect(width, 'two cards side by side').toBeGreaterThan(150);
    expect(width).toBeLessThan(195);
    await card.screenshot({ path: `${SHOTS}/${theme}-01-card-stock0-keep-selling.png` });
    await noSidewaysScroll(page);

    // Product page (keep selling, none at home): "Get it in 3–5 days".
    await page.goto(`/product/${picks.on.slug}`);
    await expect(page.getByTestId('stock-chip')).toHaveText('In stock', { timeout: 30_000 });
    await expect(page.getByTestId('pdp-delivery')).toHaveText('Get it in 3 to 5 days');
    // First screen: name, price, stock, delivery line above the buy bar.
    const bar = (await page.getByTestId('buy-bar').boundingBox()) ?? { y: 844 };
    const line = (await page.getByTestId('pdp-delivery').boundingBox()) ?? { y: 9999, height: 0 };
    expect(line.y + line.height, 'delivery line on the first screen, above Add to Cart').toBeLessThan(bar.y);
    await expect(page.getByTestId('add-to-cart')).toBeInViewport();
    await expect(page.getByTestId('wish-heart')).toHaveAttribute('aria-pressed', 'false');
    await page.screenshot({ path: `${SHOTS}/${theme}-02-product-buy-after-heart.png` });

    // Heart: saved, filled, toast with View.
    await page.getByTestId('wish-heart').click();
    await expect(page.getByTestId('wish-heart')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('wish-toast')).toContainText('Saved to your wishlist');
    await expect(page.getByTestId('wish-toast-view')).toHaveText('View');
    expect(state.wishlist).toContain(picks.on.id);
    await page.screenshot({ path: `${SHOTS}/${theme}-03-product-saved-toast.png` });

    // Limit popup: + past 4 → "Limit 4 per order" + WhatsApp link.
    await page.getByTestId('add-to-cart').click();
    for (let i = 0; i < 4; i++) await page.getByTestId('buy-bar-plus').click();
    await expect(page.getByTestId('buy-bar-qty')).toHaveText('4');
    await expect(page.getByTestId('limit-popup-title')).toHaveText('Limit 4 per order');
    await expect(page.getByTestId('limit-popup-whatsapp')).toHaveText('Need more? Chat with us on WhatsApp');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${theme}-04-limit-popup.png` });
    // A tap elsewhere closes it; the page did not move.
    await page.mouse.click(30, 300);
    await expect(page.getByTestId('limit-popup')).toHaveCount(0);

    // Sells only from stock with 2 left: amber line, the in-stock delivery line, "the last 2".
    await page.goto(`/product/${picks.low.slug}`);
    await expect(page.getByTestId('stock-chip')).toHaveText('Only 2 left, order soon', { timeout: 30_000 });
    await expect(page.getByTestId('pdp-delivery')).toHaveText('Get it in 1 to 2 days in Dhaka · 2 to 3 days outside Dhaka');
    await page.getByTestId('add-to-cart').click();
    await page.getByTestId('buy-bar-plus').click();
    await page.getByTestId('buy-bar-plus').click();
    await expect(page.getByTestId('buy-bar-qty')).toHaveText('2');
    await expect(page.getByTestId('limit-popup-title')).toHaveText("You've got the last 2!");
    await expect(page.getByTestId('limit-popup-whatsapp')).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${theme}-05-only-2-left-last-2.png` });
    await page.getByRole('button', { name: 'Close' }).click();

    // Sold out: no delivery line, "Sold out".
    await page.goto(`/product/${picks.out.slug}`);
    await expect(page.getByTestId('stock-chip')).toHaveText('Sold out', { timeout: 30_000 });
    await expect(page.getByTestId('pdp-delivery')).toHaveCount(0);
    await expect(page.getByTestId('buy-bar-out')).toHaveText('Sold out');

    // Cart: the keep-selling line (4, none at home) says "Get it in 3–5 days"; the other says nothing.
    await page.goto('/cart');
    const onRow = page.locator('[data-testid="cart-line"]', { hasText: picks.on.name }).first();
    await expect(onRow.getByTestId('cart-buy-after')).toHaveText('Get it in 3 to 5 days', { timeout: 20_000 });
    await expect(page.locator('[data-testid="cart-line"]', { hasText: picks.low.name }).first().getByTestId('cart-buy-after')).toHaveCount(0);
    await page.getByRole('button', { name: `Increase quantity of ${picks.on.name}` }).click();
    await expect(page.getByTestId('limit-popup-title')).toHaveText('Limit 4 per order');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${theme}-06-cart-buy-after-note.png` });
    await noSidewaysScroll(page);
    await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
  });

  test(`Order Placed at 390 px (${theme}): "Arriving …" from the zone and the slowest item`, async ({ page }) => {
    await openShop(page, theme, customer, '/');
    const snapshot = {
      orderId: '00000000-0000-4000-8000-000000000051',
      orderNumber: 'NM-5101',
      items: [],
      zone: { id: 'inside_dhaka', label: 'Inside Dhaka', fee: 70 },
      address: { fullName: 'Test Customer', phone: '01700000051', division: 'Dhaka', district: 'Dhaka', thana: 'Gulshan', fullAddress: 'Road 1' },
      promo: null,
      subtotal: 2990,
      discount: 0,
      total: 3060,
      paymentMethod: 'cod',
      bkashTrxId: null,
      placedAt: '2026-11-19T04:00:00.000Z',
      advanceDiscount: 0,
      advanceRule: null,
      buysLater: true,
      celebrated: true,
    };
    await page.evaluate((s) => {
      sessionStorage.setItem(
        'nph_checkout_state',
        JSON.stringify({ zoneId: 'inside_dhaka', address: s.address, promo: null, lastOrder: s })
      );
    }, snapshot);
    await page.goto('/checkout/success');
    // Fix 69.1: the words are the label; two date chips are shown.
    await expect(page.getByTestId('placed-arriving')).toHaveAttribute('aria-label', 'Arriving Sun, 22 to Tue, 24 Nov', { timeout: 20_000 });
    await expect(page.getByTestId('placed-arriving').locator('.b69-day')).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/${theme}-07-order-placed-arriving.png` });
    await noSidewaysScroll(page);
  });

  test(`account and wishlist at 390 px (${theme}): Wishlist + Pre-orders, the sheet, the glass list (full and empty)`, async ({ page }) => {
    test.setTimeout(90_000);
    const state: ShopState = { wishlist: [picks.on.id, picks.low.id, picks.out.id] };
    await answerShop(page, state);
    await openShop(page, theme, customer, '/account');

    await expect(page.getByTestId('account-wishlist-count')).toHaveText('3', { timeout: 30_000 });
    await expect(page.getByTestId('account-preorders')).toContainText('COMING SOON');
    await page.screenshot({ path: `${SHOTS}/${theme}-08-account-wishlist-preorders.png` });
    await page.getByTestId('account-preorders').click();
    const sheet = page.getByTestId('preorders-sheet');
    await expect(sheet).toContainText("Soon you can reserve sold-out favourites, and we'll bring them in just for you.");
    await expect(page.getByRole('button', { name: 'Got it' })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${theme}-09-preorders-sheet.png` });
    await page.getByRole('button', { name: 'Got it' }).click();

    await page.getByTestId('account-wishlist').click();
    await expect(page).toHaveURL(/\/wishlist$/);
    await expect(page.getByTestId('wish-count')).toHaveText('3 saved', { timeout: 20_000 });
    const cards = page.getByTestId('wish-card');
    await expect(cards).toHaveCount(3);
    const stock = page.getByTestId('wish-card-stock');
    await expect(stock.nth(0)).toHaveText('In Stock');
    await expect(stock.nth(1)).toHaveText('Only 2 left, order soon');
    await expect(stock.nth(2)).toHaveText('Sold out');
    await expect(cards.nth(2).getByRole('button', { name: 'Sold out' })).toBeDisabled();
    await noOrange(page, '.wish-page');
    await noSidewaysScroll(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-10-wishlist-full.png` });

    // Remove with the heart → "Removed from your wishlist" + Undo puts it back.
    await cards.nth(2).getByTestId('wish-card-heart').click();
    await expect(page.getByTestId('wish-toast')).toContainText('Removed from your wishlist');
    await expect(cards).toHaveCount(2);
    await page.getByTestId('wish-toast-undo').click();
    await expect(cards).toHaveCount(3);

    // Empty.
    state.wishlist = [];
    await page.reload();
    await expect(page.getByTestId('wish-empty')).toContainText('No favourites yet', { timeout: 20_000 });
    await expect(page.getByTestId('wish-empty')).toContainText('Tap the heart on any product to keep it here.');
    await page.screenshot({ path: `${SHOTS}/${theme}-11-wishlist-empty.png` });
  });

  test(`logged out at 390 px (${theme}): the heart asks to log in`, async ({ page }) => {
    await answerShop(page, { wishlist: [] });
    await openShop(page, theme, null, `/product/${picks.on.slug}`);
    await page.getByTestId('wish-heart').click();
    await expect(page.getByText('Log in to save your favourites')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('wish-login').getByRole('button', { name: /Log in/ })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${theme}-12-heart-log-in-sheet.png` });
  });
}

/* ----------------------------------------------------------- the admin */

const SHOPPING = [
  {
    product_id: '00000000-0000-4000-8000-0000000000a1',
    variant_id: null,
    product_name: 'Cancer Council Ultra Sunscreen 110ml',
    option_label: null,
    qty: 3,
    unit: null,
    orders: [
      { id: '00000000-0000-4000-8000-0000000000b1', number: 'NM-5101' },
      { id: '00000000-0000-4000-8000-0000000000b2', number: 'NM-5104' },
    ],
  },
  {
    product_id: '00000000-0000-4000-8000-0000000000a2',
    variant_id: '00000000-0000-4000-8000-0000000000c2',
    product_name: 'Plunketts Aloe Vera Gel',
    option_label: 'AU · 240ml',
    qty: 2,
    unit: null,
    orders: [{ id: '00000000-0000-4000-8000-0000000000b3', number: 'NM-5102' }],
  },
  {
    product_id: '00000000-0000-4000-8000-0000000000a3',
    variant_id: null,
    product_name: 'Blackmores Fish Oil 1000mg',
    option_label: null,
    qty: 1,
    unit: null,
    orders: [{ id: '00000000-0000-4000-8000-0000000000b4', number: 'NM-5103' }],
  },
];

async function openAdmin(page: Page, theme: 'light' | 'dark', width: number, path: string): Promise<void> {
  await page.route(/\/rest\/v1\/rpc\/admin_shopping_list/, (route) => json(route, SHOPPING));
  // The new "not paid by Steadfast" rule (NM-3307 / NM-3319 paid by hand).
  await page.route(/\/rest\/v1\/rpc\/steadfast_unpaid_orders/, (route) => json(route, []));
  await page.setViewportSize({ width, height: width > 1000 ? 900 : 844 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await useSessionInPage(page, admin);
  await page.goto(path);
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [WIDTH, 1440]) {
    test(`admin home at ${width} px (${theme}): greeting, glass clock with seconds, Shopping list tile`, async ({ page }) => {
      await openAdmin(page, theme, width, '/admin');
      await expect(page.locator('.adm-page-header__title')).toHaveText(/^Good (morning|afternoon|evening), /, { timeout: 30_000 });
      const clock = page.getByTestId('admin-clock');
      await expect(clock).toBeVisible();
      const label = (await clock.getAttribute('aria-label')) ?? '';
      expect(label).toMatch(/^(1[0-2]|[1-9]):[0-5]\d$/);
      const s1 = await page.getByTestId('admin-clock-seconds').textContent();
      await page.waitForTimeout(1300);
      expect(await page.getByTestId('admin-clock-seconds').textContent(), 'the seconds tick').not.toBe(s1);
      await expect(page.getByTestId('home-shopping')).toContainText('3 items to buy');
      if (width > 1000) {
        const hero = await page.getByTestId('admin-hero').boundingBox();
        const greet = await page.locator('.adm-hero__greeting').boundingBox();
        const clockBox = await clock.boundingBox();
        expect(greet && clockBox && greet.x < clockBox.x, 'greeting left, clock right').toBe(true);
        expect(hero?.width ?? 0).toBeGreaterThan(900);
      } else {
        const greet = await page.locator('.adm-hero__greeting').boundingBox();
        const clockBox = await clock.boundingBox();
        expect(greet && clockBox && clockBox.y < greet.y, 'clock on top, greeting under it').toBe(true);
        await noSidewaysScroll(page);
      }
      await page.screenshot({ path: `${SHOTS}/${theme}-13-admin-home-${width}.png` });
    });
  }

  test(`Shopping list at 390 px (${theme}): rows, totals, order links, PDF`, async ({ page }) => {
    await openAdmin(page, theme, WIDTH, '/admin?tab=shopping');
    await expect(page.getByTestId('shopping-row')).toHaveCount(3, { timeout: 30_000 });
    await expect(page.getByTestId('shopping-totals')).toContainText('3');
    await expect(page.getByTestId('shopping-totals')).toContainText('6');
    await expect(page.getByTestId('shopping-row').first()).toContainText('Blackmores Fish Oil 1000mg');
    await expect(page.getByTestId('shopping-row').nth(1)).toContainText('Cancer Council Ultra Sunscreen 110ml');
    await expect(page.getByTestId('shopping-row').nth(1)).toContainText('NM-5101, NM-5104');
    await noOrange(page, '.adm-shop');
    await noSidewaysScroll(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-14-shopping-list.png` });
    if (theme === 'light') {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('shopping-pdf').click()]);
      expect(download.suggestedFilename()).toMatch(/^Shopping list .+\.pdf$/);
      await download.saveAs(`${SHOTS}/pdf/shopping-list.pdf`);
    }
  });

  test(`Shopping list empty at 390 px (${theme})`, async ({ page }) => {
    await page.route(/\/rest\/v1\/rpc\/admin_shopping_list/, (route) => json(route, []));
    await page.setViewportSize({ width: WIDTH, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
    await useSessionInPage(page, admin);
    await page.goto('/admin?tab=shopping');
    await expect(page.getByText('Nothing to buy right now.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('shopping-badge')).toHaveCount(0);
  });

  test(`Steadfast payouts at 390 px (${theme}): old payouts read Matched, the balance line agrees, no "not paid" warning`, async ({ page }) => {
    await openAdmin(page, theme, WIDTH, '/admin?tab=payouts');
    const list = page.getByTestId('payouts-list');
    await expect(list).toBeVisible({ timeout: 30_000 });
    await expect(list.locator('.adm-payouts__pill', { hasText: 'Booked on Steadfast' })).toHaveCount(0);
    await expect(page.getByTestId('payouts-overdue')).toHaveCount(0);
    const balance = (await page.getByTestId('payouts-balance').locator('.adm-payouts__big').textContent()) ?? '';
    const line = page.getByTestId('payouts-balance-line');
    if (balance.trim() === '৳0') await expect(line).toContainText('Nothing waiting from Steadfast');
    else await expect(line).not.toContainText('Nothing waiting');
    await page.screenshot({ path: `${SHOTS}/${theme}-15-payouts.png` });
    await noSidewaysScroll(page);
  });
}

test('admin Settings: "Order limit and delivery times" shows the four fields (nothing saved)', async ({ page }) => {
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=settings&sset=order-limit');
  const panel = page.getByTestId('order-limit-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByLabel('Most of one item per order')).toHaveValue('4');
  await expect(panel.getByLabel('Delivery in Dhaka')).toHaveValue('1 to 2 days');
  await expect(panel.getByLabel('Delivery outside Dhaka')).toHaveValue('2 to 3 days');
  await expect(panel.getByLabel('Items we buy after the order')).toHaveValue('3 to 5 days');
  await page.screenshot({ path: `${SHOTS}/light-16-settings-order-limit.png` });
});
