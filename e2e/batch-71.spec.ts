import { mkdirSync } from 'node:fs';
import type { Locator, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { passwordSession, select, useSessionInPage } from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './helpers/env';

// Batch 71: the new Home, the Shop tab, the floating bottom bar and
// Naeem's skin tips.
//
// Nothing is written to Supabase: the Home settings (tips, switches,
// concerns, combos, videos) are answered inside the test browser only, a
// combo is answered by a mocked get_combo, YouTube thumbnails get a tiny
// local picture, and no real Storage file is downloaded (./fixtures).

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Dhaka' });

const SHOTS = 'reports/batch-71-screens';

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const COMBO_CODE = 'e2ebmnpq';
const SHORT_URL = 'https://youtube.com/shorts/dQw4w9WgXcQ';
const VIDEO_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const TWO_TIPS = [
  { id: 'e2e-own', text: 'CSM first. Cleanser, Sunscreen, Moisturizer.', accent: 'Cleanser, Sunscreen, Moisturizer.', own: true, active: true },
  { id: 'e2e-tip', text: 'Wear sunscreen, even indoors.', accent: 'sunscreen', own: false, active: true },
];

async function liveProductIds(count: number): Promise<string[]> {
  const res = await select<{ id: string }[]>(null, `products_view?select=id&is_active=eq.true&stock_status=eq.in_stock&order=name.asc&limit=${count}`);
  const ids = (res.data ?? []).map((r) => r.id);
  expect(ids.length).toBe(count);
  return ids;
}

/** The Home's settings rows, answered in this test browser only. */
async function homeSettings(page: Page, values: Record<string, string>): Promise<void> {
  await page.route(/\/rest\/v1\/app_settings\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const rows = ((await res.json()) as { key: string; value: string }[]).filter((r) => !(r.key in values));
    for (const [key, value] of Object.entries(values)) rows.push({ key, value });
    await route.fulfill({ response: res, json: rows });
  });
}

/** Rows on: skin types, concerns, a combo and two videos. */
async function allRowsOn(page: Page): Promise<void> {
  const ids = await liveProductIds(3);
  await homeSettings(page, {
    home_show_skin_types: '1',
    home_show_concerns: '1',
    home_show_combos: '1',
    home_combo_codes: JSON.stringify([COMBO_CODE]),
    home_videos: JSON.stringify([
      { url: VIDEO_URL, title: 'My morning routine in two minutes' },
      { url: SHORT_URL, title: 'Sunscreen, how much?' },
    ]),
  });
  await page.route('**/rest/v1/rpc/get_combo', (route) =>
    route.fulfill({
      json: {
        code: COMBO_CODE,
        name: 'Glow starter',
        note: null,
        preview_url: null,
        items: ids.map((id) => ({ product_id: id, variant_id: null, quantity: 1 })),
      },
    })
  );
}

async function thumbnails(page: Page): Promise<void> {
  await page.route(/^https:\/\/i\.ytimg\.com\//, (route) => route.fulfill({ body: PIXEL, contentType: 'image/png' }));
}

async function openHome(page: Page): Promise<void> {
  await thumbnails(page);
  await page.goto('/');
  await expect(page.getByTestId('home-page')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('best-seller-card').first()).toBeVisible({ timeout: 20_000 });
}

async function top(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return (box as { y: number }).y;
}

async function scrollLeftOf(page: Page): Promise<number> {
  return page.getByTestId('best-sellers').evaluate((el) => el.scrollLeft);
}

/* ------------------------------------------------------------- Home */

test('Home: the sections in order; the three optional rows hidden by default', async ({ page }) => {
  await openHome(page);
  await expect(page.locator('.b71-mark')).toHaveText("NAEEM'S");
  await expect(page.getByTestId('home-skin-types')).toHaveCount(0);
  await expect(page.getByTestId('home-concerns')).toHaveCount(0);
  await expect(page.getByTestId('home-combos')).toHaveCount(0);
  // Signed out: no greeting row.
  await expect(page.getByTestId('home-greeting')).toHaveCount(0);
  await expect(page.getByTestId('home-search')).toHaveText('Search products, brands, concerns');
  const order = ['home-tip', 'home-search', 'home-banner', 'home-browse', 'brand-row', 'home-best', 'home-expert'];
  let last = -1;
  for (const id of order) {
    const y = await top(page.getByTestId(id));
    expect(y, `${id} below the one before`).toBeGreaterThan(last);
    last = y;
  }
  expect(await top(page.locator('.site-footer'))).toBeGreaterThan(last);
  await expect(page.getByTestId('home-expert')).toContainText('Skincare expert');
  await expect(page.getByTestId('home-expert')).toContainText('Talk with Naeem');
  await expect(page.getByTestId('home-expert')).toContainText('Not sure what suits your skin? Ask me.');
  await expect(page.getByTestId('home-expert').getByText('Message')).toBeVisible();
  await expect(page.getByTestId('home-expert').getByText('Book a session')).toBeVisible();
});

test('Home: with the rows on, skin types, concerns, combos and videos sit in their places', async ({ page }) => {
  await allRowsOn(page);
  await openHome(page);
  const skin = page.getByTestId('home-skin-types');
  await expect(skin.locator('.b71-st')).toHaveText(['Normal', 'Oily', 'Combination', 'Dry']);
  await expect(skin.locator('.b71-st').first()).toHaveAttribute('href', '/shop?skin=Normal');
  await expect(page.getByTestId('home-concerns').locator('.b71-cc b')).toHaveText(['Acne', 'Hyperpigmentation', 'Anti aging', 'Sensitive', 'Dehydrated']);
  const combo = page.getByTestId('home-combo-card');
  await expect(combo).toContainText('Glow starter');
  await expect(combo).toContainText(/3 products · ৳ [\d,]+/);
  await expect(combo).toHaveAttribute('href', `/c/${COMBO_CODE}`);
  await expect(page.getByTestId('home-videos').locator('.b71-sec a')).toHaveText('YouTube');
  const order = ['brand-row', 'home-skin-types', 'home-concerns', 'home-best', 'home-combos', 'home-videos', 'home-expert'];
  let last = -1;
  for (const id of order) {
    const y = await top(page.getByTestId(id));
    expect(y, `${id} below the one before`).toBeGreaterThan(last);
    last = y;
  }
  // A skin type tile filters the shop (Batch 72: ?skin=, was a ?q= search).
  await skin.locator('.b71-st').nth(1).click();
  await expect(page).toHaveURL(/\/shop\?skin=Oily$/);
  await expect(page.getByTestId('shop-query')).toContainText('Results for Oily');
  // Let the Shop's pictures settle before the test (and its routes) ends.
  await page.waitForLoadState('networkidle');
});

test('Home: a Shorts card is 9:16, a normal video 16:9, thumbnails from YouTube (no player)', async ({ page }) => {
  await allRowsOn(page);
  await openHome(page);
  const short = page.getByTestId('home-video-short').locator('.b71-yt__img');
  const normal = page.getByTestId('home-video').locator('.b71-yt__img');
  const s = (await short.boundingBox()) as { width: number; height: number };
  const n = (await normal.boundingBox()) as { width: number; height: number };
  expect(Math.round(s.width)).toBe(150);
  expect(Math.abs(s.height / s.width - 16 / 9)).toBeLessThan(0.02);
  expect(Math.round(n.width)).toBe(240);
  expect(Math.abs(n.height / n.width - 9 / 16)).toBeLessThan(0.02);
  await expect(short.locator('img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('Tip: the label and the orange part; a tap shows the other tip; the next visit never repeats the last', async ({ page }) => {
  await homeSettings(page, { home_tips: JSON.stringify(TWO_TIPS) });
  await openHome(page);
  const tip = page.getByTestId('home-tip');
  await expect(tip).toContainText('Tap for another');
  const first = await tip.getAttribute('data-tip-id');
  const expectTip = async (id: string | null) => {
    if (id === 'e2e-own') {
      await expect(page.getByTestId('home-tip-label')).toHaveText("NAEEM'S RULE");
      await expect(tip.locator('em')).toHaveText('Cleanser, Sunscreen, Moisturizer.');
    } else {
      await expect(page.getByTestId('home-tip-label')).toHaveText('SKIN TIP');
      await expect(tip.locator('em')).toHaveText('sunscreen');
    }
    const orange = await tip.locator('em').evaluate((el) => getComputedStyle(el).color);
    expect(orange).toBe('rgb(255, 122, 69)');
  };
  await expectTip(first);
  await tip.click();
  await expect(tip).not.toHaveAttribute('data-tip-id', first ?? '');
  const second = await tip.getAttribute('data-tip-id');
  await expectTip(second);
  await expect(tip).toHaveClass(/b71-tip--swap/);
  // Back to Home in the same visit: the same tip.
  await page.getByRole('link', { name: 'Shop', exact: true }).click();
  await expect(page).toHaveURL(/\/shop$/);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByTestId('home-tip')).toHaveAttribute('data-tip-id', second ?? '');
  // A new visit (page load): never the one shown last.
  for (let i = 0; i < 3; i += 1) {
    const lastShown = await page.getByTestId('home-tip').getAttribute('data-tip-id');
    await page.reload();
    await expect(page.getByTestId('home-tip')).toBeVisible();
    await expect(page.getByTestId('home-tip')).not.toHaveAttribute('data-tip-id', lastShown ?? '');
  }
});

test('Home: the search pill opens Search with the keyboard; See all opens the Shop', async ({ page }) => {
  await openHome(page);
  await page.getByTestId('home-search').click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByRole('combobox', { name: 'Search products' })).toBeFocused();
  await page.goto('/');
  await page.getByTestId('home-best').locator('.b71-sec a').click();
  await expect(page).toHaveURL(/\/shop$/);
  await expect(page.getByTestId('shop-page').locator('.b71-shop__title')).toHaveText('Shop');
});

test('Best sellers: drifts left by itself, stops on a touch; a tap opens the product', async ({ page }) => {
  await openHome(page);
  const row = page.getByTestId('best-sellers');
  await row.scrollIntoViewIfNeeded();
  const a = await scrollLeftOf(page);
  await page.waitForTimeout(2000);
  const b = await scrollLeftOf(page);
  // 0.025 px per ms: about 50 px in 2 s.
  expect(b - a).toBeGreaterThan(25);
  expect(b - a).toBeLessThan(90);
  // A touch pauses it.
  await row.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 10, isPrimary: true });
  const c = await scrollLeftOf(page);
  await page.waitForTimeout(1500);
  expect(Math.abs((await scrollLeftOf(page)) - c)).toBeLessThanOrEqual(1);
  await row.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 10, isPrimary: true });
  // The second copy is hidden from screen readers and the keyboard.
  await expect(row.locator('.b71-marq__copy')).toHaveAttribute('aria-hidden', 'true');
  expect(await row.locator('.b71-marq__copy a').evaluateAll((els) => els.every((e) => e.getAttribute('tabindex') === '-1'))).toBe(true);
  // A tap opens the product.
  const card = page.getByTestId('best-seller-card').first();
  const href = await card.getAttribute('href');
  await card.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
});

test('Best sellers: no drift with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openHome(page);
  await page.getByTestId('best-sellers').scrollIntoViewIfNeeded();
  const a = await scrollLeftOf(page);
  await page.waitForTimeout(2000);
  expect(await scrollLeftOf(page)).toBe(a);
});

test('Best sellers: dropped frames at 4x CPU slowdown (performance check, reported)', async ({ page }) => {
  await openHome(page);
  await page.getByTestId('best-sellers').scrollIntoViewIfNeeded();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const gaps = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const times: number[] = [];
        const step = (t: number) => {
          times.push(t);
          if (times.length < 180) requestAnimationFrame(step);
          else resolve(times.slice(1).map((v, i) => v - times[i]));
        };
        requestAnimationFrame(step);
      })
  );
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const dropped = gaps.filter((g) => g > 25).length;
  const worst = Math.max(...gaps);
  test.info().annotations.push({ type: 'perf', description: `frames 179, over 25 ms: ${dropped}, worst ${worst.toFixed(1)} ms` });
  console.log(`[b71-perf] 4x CPU: ${gaps.length} frames, ${dropped} over 25 ms, worst ${worst.toFixed(1)} ms`);
  expect(gaps.length).toBe(179);
});

/* ------------------------------------------------------- bottom bar */

test('Bottom bar: on Home, Shop, Search, Brands and a brand page; not on product, cart, checkout, account', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByTestId('bottom-nav');
  await expect(nav).toBeVisible({ timeout: 20_000 });
  await expect(nav.locator('a')).toHaveCount(4);
  await expect(nav.locator('a[aria-current="page"]')).toHaveText('Home');
  for (const [path, label] of [
    ['/shop', 'Shop'],
    ['/search', 'Search'],
    ['/brands', 'Shop'],
  ] as const) {
    await page.goto(path);
    await expect(nav, path).toBeVisible({ timeout: 20_000 });
    await expect(nav.locator('a[aria-current="page"]'), path).toHaveText(label);
  }
  await page.locator('a[href^="/brand/"]').first().click();
  await expect(page).toHaveURL(/\/brand\//);
  await expect(nav).toBeVisible();
  // Only the active tab shows its label; no Cart tab.
  await expect(nav.locator('a:not([aria-current]) span')).toHaveCount(0);
  await expect(nav.locator('a[href="/cart"]')).toHaveCount(0);
  const slug = (await select<{ slug: string }[]>(null, 'products_view?select=slug&is_active=eq.true&limit=1')).data?.[0]?.slug;
  for (const path of [`/product/${slug}`, '/cart', '/checkout/delivery', '/account']) {
    await page.goto(path);
    await page.waitForTimeout(800);
    await expect(nav, path).toHaveCount(0);
  }
});

test('Bottom bar: hides on a scroll down, comes back on a scroll up; Shop tab on Shop goes to the top', async ({ page }) => {
  await page.goto('/shop');
  await expect(page.locator('.product-card').nth(6)).toBeVisible({ timeout: 20_000 });
  const nav = page.getByTestId('bottom-nav');
  await expect(nav).not.toHaveClass(/b71-nav--away/);
  await page.mouse.wheel(0, 400);
  await expect(nav).toHaveClass(/b71-nav--away/);
  await page.mouse.wheel(0, -60);
  await expect(nav).not.toHaveClass(/b71-nav--away/);
  await page.mouse.wheel(0, 400);
  await expect(nav).toHaveClass(/b71-nav--away/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(nav).not.toHaveClass(/b71-nav--away/);
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.mouse.wheel(0, -60);
  await expect(nav).not.toHaveClass(/b71-nav--away/);
  await nav.locator('a[data-tab="shop"]').click();
  await page.waitForFunction(() => window.scrollY === 0);
});

test('Bottom bar with reduced motion: no transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const duration = await page.getByTestId('bottom-nav').evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(duration.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
});

/* ------------------------------------------------------------ routes */

test('an old /?cat= link lands on /shop?cat= (replaced, not pushed)', async ({ page }) => {
  const cat = (await select<{ slug: string }[]>(null, 'categories?select=slug&limit=1')).data?.[0]?.slug ?? 'face-care';
  await page.goto('/about');
  await page.goto(`/?cat=${cat}`);
  await expect(page).toHaveURL(new RegExp(`/shop\\?cat=${cat}$`));
  await expect(page.locator('.home-chips .chip--active')).toBeVisible({ timeout: 20_000 });
  await page.goBack();
  await expect(page).toHaveURL(/\/about$/);
});

test('Shop: back from a product keeps the scroll spot and the chosen chip', async ({ page }) => {
  await page.goto('/shop');
  await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 20_000 });
  const chip = page.locator('.home-chips [role="tab"]').nth(1);
  const chipName = ((await chip.textContent()) ?? '').trim();
  await chip.click();
  await expect(page).toHaveURL(/[?&]cat=/);
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollBy(0, 250));
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.scrollY);
  const url = page.url();
  const vh = page.viewportSize()?.height ?? 800;
  const cards = page.locator('.product-card');
  let card = cards.first();
  for (let i = 0; i < (await cards.count()); i += 1) {
    const box = await cards.nth(i).boundingBox();
    if (box && box.y >= 60 && box.y + box.height <= vh - 90) {
      card = cards.nth(i);
      break;
    }
  }
  await card.click();
  await expect(page).toHaveURL(/\/product\//);
  await page.waitForTimeout(600);
  await page.goBack();
  await expect(page).toHaveURL(url);
  await page.waitForTimeout(600);
  await expect(page.locator('.home-chips').getByRole('tab', { name: chipName, exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(5);
  await expect(page.getByTestId('shop-count')).toHaveText(/^\d+ products?$/);
});

/* ---------------------------------------------- hamburger and Account */

test('No hamburger; Account has Dark mode and About and policies; Admin panel only for staff', async ({ browser }) => {
  test.setTimeout(90_000);
  const shopper = await browser.newPage();
  await signInAsTestCustomer(shopper);
  await shopper.goto('/');
  await expect(shopper.getByTestId('home-page')).toBeVisible({ timeout: 20_000 });
  await expect(shopper.getByRole('button', { name: /menu/i })).toHaveCount(0);
  await expect(shopper.getByTestId('home-greeting')).toContainText(/Good (morning|afternoon|evening)/);
  await shopper.goto('/account');
  const more = shopper.getByTestId('account-more');
  await expect(more).toBeVisible({ timeout: 20_000 });
  await expect(more).toContainText('About and policies');
  for (const label of ['About us', 'Delivery info', 'Return policy', 'Terms and conditions', 'Privacy policy']) {
    await expect(more.getByRole('link', { name: label })).toBeVisible();
  }
  await expect(shopper.getByText(/admin panel/i)).toHaveCount(0);
  const dark = shopper.getByTestId('account-dark-mode');
  const was = await dark.getAttribute('aria-checked');
  await dark.click();
  await expect(dark).not.toHaveAttribute('aria-checked', was ?? '');
  await dark.click();
  await shopper.close();

  test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the test admin in .env.e2e.');
  const staff = await browser.newPage();
  await useSessionInPage(staff, await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD));
  await staff.goto('/account');
  await expect(staff.getByRole('link', { name: 'Open admin panel' })).toBeVisible({ timeout: 20_000 });
  await expect(staff.getByTestId('account-dark-mode')).toBeVisible();
  await staff.close();
});

/* -------------------------------------------------------- one orange */

async function oldOrangeButtons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"]'))) {
      const s = getComputedStyle(el);
      for (const v of [s.backgroundColor, s.color, s.borderTopColor]) {
        if (v.replace(/\s/g, '').startsWith('rgb(240,80,32')) out.push(`${el.tagName}.${el.className}`);
      }
    }
    return out;
  });
}

test('one brand orange: no #F05020 on Home, Shop, product, cart or Order Placed', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsTestCustomer(page);
  await openHome(page);
  expect(await oldOrangeButtons(page), 'Home').toEqual([]);
  await page.goto('/shop');
  await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 20_000 });
  expect(await oldOrangeButtons(page), 'Shop').toEqual([]);
  await page.getByRole('button', { name: /^Add .* to cart$/ }).first().click();
  await page.locator('.product-card').first().click();
  await expect(page).toHaveURL(/\/product\//);
  await page.waitForTimeout(800);
  expect(await oldOrangeButtons(page), 'product').toEqual([]);
  await page.goto('/cart');
  await expect(page.getByRole('button', { name: 'Checkout' })).toBeVisible({ timeout: 20_000 });
  expect(await oldOrangeButtons(page), 'cart').toEqual([]);
  await page.evaluate(() => {
    const lastOrder = {
      orderId: '00000000-0000-4000-8000-000000000071',
      orderNumber: 'NM-7101',
      items: [],
      zone: { id: 'inside_dhaka', label: 'Inside Dhaka', fee: 70 },
      address: { fullName: 'Test Customer', phone: '01700000071', division: 'Dhaka', district: 'Dhaka', thana: 'Gulshan', fullAddress: 'Road 1' },
      promo: null,
      subtotal: 1000,
      discount: 0,
      total: 1070,
      paymentMethod: 'cod',
      bkashTrxId: null,
      placedAt: '2026-11-27T04:00:00.000Z',
      advanceDiscount: 0,
      advanceRule: null,
      buysLater: false,
      celebrated: true,
    };
    sessionStorage.setItem('nph_checkout_state', JSON.stringify({ zoneId: 'inside_dhaka', address: lastOrder.address, promo: null, lastOrder }));
    localStorage.setItem('nph_cart', '[]');
  });
  await page.goto('/checkout/success');
  await expect(page.getByTestId('placed-actions')).toBeVisible({ timeout: 20_000 });
  expect(await oldOrangeButtons(page), 'Order Placed').toEqual([]);
  // Keep shopping goes to the Shop.
  await expect(page.getByRole('link', { name: 'Keep shopping' })).toHaveAttribute('href', '/shop');
  // White text on an orange button: bold and at least 15 px.
  const view = await page.getByRole('link', { name: 'View my order' }).evaluate((el) => {
    const s = getComputedStyle(el);
    return { weight: Number(s.fontWeight), size: parseFloat(s.fontSize), bg: s.backgroundColor };
  });
  expect(view.bg.replace(/\s/g, '')).toBe('rgb(255,122,69)');
  expect(view.weight).toBeGreaterThanOrEqual(700);
  expect(view.size).toBeGreaterThanOrEqual(15);
});

/* ------------------------------------------------------- the captures */

for (const size of [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`captures ${size.width}x${size.height} ${theme}: Home, Home rows, Shop, Account`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
      await signInAsTestCustomer(page);
      await allRowsOn(page);
      await homeSettings(page, {
        home_show_skin_types: '1',
        home_show_concerns: '1',
        home_show_combos: '1',
        home_combo_codes: JSON.stringify([COMBO_CODE]),
        home_videos: JSON.stringify([
          { url: VIDEO_URL, title: 'My morning routine in two minutes' },
          { url: SHORT_URL, title: 'Sunscreen, how much?' },
        ]),
        home_tips: JSON.stringify([TWO_TIPS[0]]),
      });
      await openHome(page);
      await page.waitForTimeout(800);
      const name = `${size.width}-${theme}`;
      await page.screenshot({ path: `${SHOTS}/home-top-${name}.png` });
      await page.getByTestId('home-skin-types').scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -20));
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/home-skin-concerns-${name}.png` });
      await page.getByTestId('home-best').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 60));
      await page.mouse.wheel(0, -30);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SHOTS}/home-best-combos-${name}.png` });
      await page.getByTestId('home-videos').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 60));
      await page.mouse.wheel(0, -30);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SHOTS}/home-videos-expert-${name}.png` });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);

      await page.getByRole('link', { name: 'Shop', exact: true }).click();
      await expect(page.locator('.product-card').nth(3)).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SHOTS}/shop-${name}.png` });

      await page.goto('/account');
      await expect(page.getByTestId('account-more')).toBeVisible({ timeout: 20_000 });
      await page.getByTestId('account-more').scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/account-list-${name}.png` });
    });
  }
}

test('captures: admin Home page panels (390 light and dark)', async ({ page }) => {
  test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the test admin in .env.e2e.');
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD));
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
    for (const [dset, testId] of [
      ['home-tips', 'home-tips-panel'],
      ['home-show', 'home-show-panel'],
      ['home-concerns', 'home-concerns-panel'],
      ['home-combos', 'home-combos-panel'],
      ['home-videos', 'home-videos-panel'],
    ] as const) {
      await page.goto(`/admin?tab=design&dset=${dset}`);
      await expect(page.getByTestId(testId)).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/admin-${dset}-390-${theme}.png` });
    }
    // The video field refuses a link that is not YouTube (nothing is saved).
    const panel = page.getByTestId('home-videos-panel');
    await panel.getByRole('button', { name: 'Add video' }).click();
    await panel.getByPlaceholder('https://youtube.com/watch?v=...').last().fill('https://vimeo.com/123');
    await expect(panel.getByRole('alert')).toHaveText('Paste a YouTube or YouTube Shorts link.');
    await expect(panel.getByRole('button', { name: 'Save' })).toBeDisabled();
    await panel.getByPlaceholder('https://youtube.com/watch?v=...').last().fill(SHORT_URL);
    await expect(panel.locator('.b71a-tag').last()).toHaveText('Shorts');
    await page.screenshot({ path: `${SHOTS}/admin-home-videos-shorts-390-${theme}.png` });
  }
});
