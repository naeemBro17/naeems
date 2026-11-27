import { mkdirSync } from 'node:fs';
import type { CDPSession, Locator, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { select } from './helpers/api';
import { arrivalRange, orderLimit } from '../src/lib/sellRules';

// Fix 72.1: the product page's first screen as Naeem approved it: the
// photo always full width (no blurred side bands), dots instead of "1 / N",
// the brand capsule, the rolling price, one sideways line of options per
// group, quantity + Add to Cart with "Added", the 2 x 2 info block, and
// the cart bubble's first place under the Share button.
//
// Nothing is written to Supabase: the cart is the browser's own and any
// changed prices exist inside this test browser only. No real Storage
// file is downloaded (./fixtures).

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Dhaka' });

const SHOTS = 'reports/fix-72-1-screens';

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

interface LiveProduct {
  id: string;
  slug: string;
  name: string;
  image_urls: string[] | null;
  stock_status: string;
  stock_quantity: number | null;
  in_hand: boolean | null;
}

interface LiveVariant {
  id: string;
  product_id: string;
  region: string;
  size: string;
}

async function catalogue(): Promise<{ products: LiveProduct[]; variants: LiveVariant[] }> {
  const res = await select<LiveProduct[]>(
    null,
    'products_view?select=id,slug,name,image_urls,stock_status,stock_quantity,in_hand&is_active=eq.true&order=name.asc'
  );
  const vars = await select<LiveVariant[]>(null, 'product_variants_view?select=id,product_id,region,size');
  return { products: (res.data ?? []).filter((p) => p.slug), variants: vars.data ?? [] };
}

/** The Nivea body wash (two option groups, 4 options in one) if it is
 *  live, else any product with a Region and a Size row. */
async function optionsProduct(): Promise<LiveProduct> {
  const { products, variants } = await catalogue();
  const withRows = products.filter((p) => variants.filter((v) => v.product_id === p.id).length >= 2 && p.stock_status === 'in_stock');
  const nivea = withRows.find((p) => /nivea/i.test(p.name) && /wash/i.test(p.name));
  const pick = nivea ?? withRows[0];
  expect(pick, 'a live product with options').toBeTruthy();
  return pick as LiveProduct;
}

/** In stock, no options, no stock count (so only the order limit stops
 *  adds), with 2+ photos (the dots show). */
async function plainProduct(): Promise<LiveProduct> {
  const { products, variants } = await catalogue();
  const withOptions = new Set(variants.map((v) => v.product_id));
  const pick = products.find(
    (p) => !withOptions.has(p.id) && p.stock_status === 'in_stock' && p.stock_quantity === null && (p.image_urls ?? []).length >= 2
  );
  expect(pick, 'a plain live in-stock product with 2+ photos').toBeTruthy();
  return pick as LiveProduct;
}

async function longestNameProduct(): Promise<LiveProduct> {
  const { products } = await catalogue();
  return [...products].sort((a, b) => b.name.length - a.name.length)[0];
}

async function liveSettings(): Promise<Record<string, string>> {
  const res = await select<{ key: string; value: string }[]>(null, 'app_settings?select=key,value');
  return Object.fromEntries((res.data ?? []).map((r) => [r.key, r.value]));
}

/** This visit starts fresh: the first add opens the side cart (the other
 *  specs start as "already shown", see ./fixtures). Once per tab. */
async function freshVisit(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem('e2e.b70.started')) return;
    window.sessionStorage.setItem('e2e.b70.started', '1');
    window.sessionStorage.setItem('e2e.b70.fresh', '1');
    window.sessionStorage.removeItem('naeems.sideCartShown');
  });
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, scheme);
}

async function box(el: Locator) {
  const b = await el.boundingBox();
  expect(b).not.toBeNull();
  return b as { x: number; y: number; width: number; height: number };
}

async function openProduct(page: Page, slug: string): Promise<void> {
  await page.goto(`/product/${slug}`);
  await expect(page.getByTestId('pdp-buy')).toBeVisible({ timeout: 20_000 });
}

const cartCount = (page: Page) =>
  page.evaluate(() =>
    (JSON.parse(window.localStorage.getItem('nph_cart') ?? '[]') as { quantity: number }[]).reduce((n, l) => n + l.quantity, 0)
  );

async function countFlies(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __flies: number };
    w.__flies = 0;
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => n instanceof HTMLElement && n.classList.contains('b70-fly') && (w.__flies += 1));
    }).observe(document.body, { childList: true });
  });
}

const flies = (page: Page) => page.evaluate(() => (window as unknown as { __flies: number }).__flies);

/** A real finger (CDP touch events), so the browser's own scrolling runs. */
async function swipe(cdp: CDPSession, x: number, y: number, dx: number, dy: number): Promise<void> {
  const steps = 12;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Add to Cart fully on the first screen; when it is not, the buy bar must
 *  already show. Returns which it was (for the report). */
async function firstScreenBuy(page: Page): Promise<'in-page' | 'buy-bar'> {
  await page.waitForTimeout(400);
  const fits = await page.getByTestId('add-to-cart').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  if (fits) {
    await expect(page.getByTestId('buy-bar')).toHaveAttribute('data-shown', 'false');
    return 'in-page';
  }
  await expect(page.getByTestId('buy-bar')).toHaveAttribute('data-shown', 'true');
  await expect(page.getByTestId('buy-bar')).toBeInViewport({ ratio: 1 });
  return 'buy-bar';
}

/* ------------------------------------------------------------ frame captures */

for (const size of [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`screens: options product at ${size.width} x ${size.height} (${theme})`, async ({ page }) => {
      test.setTimeout(60_000);
      const product = await optionsProduct();
      await page.setViewportSize(size);
      await openProduct(page, product.slug);
      await setTheme(page, theme);
      const where = await firstScreenBuy(page);
      console.log(`[fix-72-1] ${product.name} ${size.width}x${size.height} ${theme}: Add to Cart ${where}`);
      await page.screenshot({ path: `${SHOTS}/options-${size.width}-${theme}.png` });
    });
  }
}

test('screens: the longest name at 360 x 780, and a product with no options', async ({ page }) => {
  test.setTimeout(60_000);
  const long = await longestNameProduct();
  await page.setViewportSize({ width: 360, height: 780 });
  await openProduct(page, long.slug);
  await setTheme(page, 'light');
  const where = await firstScreenBuy(page);
  console.log(`[fix-72-1] longest name (${long.name.length} chars) 360x780: Add to Cart ${where}`);
  await page.screenshot({ path: `${SHOTS}/long-name-360-light.png` });

  const plain = await plainProduct();
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, plain.slug);
  await setTheme(page, 'light');
  const plainWhere = await firstScreenBuy(page);
  console.log(`[fix-72-1] no options 390x844: Add to Cart ${plainWhere}`);
  await expect(page.locator('.pdp-main .variant-row')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/no-options-390-light.png` });
});

/* ------------------------------------------------------------------ photo */

for (const width of [360, 390, 430]) {
  test(`photo at ${width} px: full width, a square, no side bands; dots; the bubble clear of Share and the heart`, async ({ page }) => {
    test.setTimeout(60_000);
    const plain = await plainProduct();
    // One line in the cart, so the bubble shows (it hides when empty).
    await page.addInitScript((id) => {
      window.localStorage.setItem(
        'nph_cart',
        JSON.stringify([{ productId: id, variantId: null, variantLabel: null, quantity: 1, priceAtAdd: 100 }])
      );
    }, plain.id);
    await page.setViewportSize({ width, height: 860 });
    await openProduct(page, plain.slug);
    const img = await box(page.locator('.product-detail__image').first());
    expect(Math.round(img.x)).toBe(0);
    expect(Math.round(img.width)).toBe(width);
    expect(Math.round(img.height)).toBe(width);
    await expect(page.locator('.product-detail__backdrop, [data-testid="photo-backdrop"]')).toHaveCount(0);
    // The page no longer sets a measured photo height on the gallery.
    expect(await page.locator('.product-detail__gallery').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--b70-photo'))).toBe('');

    // 2 to 7 photos: dots, centred at the bottom of the photo; no "1 / N".
    const count = (plain.image_urls ?? []).length;
    if (count <= 7) {
      const dots = page.getByTestId('image-dots');
      await expect(dots.locator('i')).toHaveCount(count);
      await expect(dots.locator('i.is-on')).toHaveCount(1);
      const d = await box(dots);
      expect(Math.abs(d.x + d.width / 2 - width / 2)).toBeLessThan(1.5);
      expect(d.y + d.height).toBeLessThanOrEqual(img.y + img.height);
      expect(d.y + d.height).toBeGreaterThan(img.y + img.height - 30);
      await expect(page.getByTestId('image-counter')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('image-counter')).toHaveText(`1 / ${count}`);
    }

    // The bubble (never moved): right edge, under Share, over the photo,
    // touching neither Share nor the heart.
    const bubble = await box(page.getByTestId('glass-cart'));
    const share = await box(page.locator('.pdp-header__share'));
    const heart = await box(page.getByTestId('photo-heart'));
    expect(bubble.y).toBeGreaterThanOrEqual(share.y + share.height + 4);
    expect(bubble.y + bubble.height).toBeLessThanOrEqual(heart.y - 4);
    expect(bubble.x + bubble.width).toBeGreaterThan(width - 80);
    expect(bubble.y + bubble.height).toBeLessThan(img.y + img.height);
    await page.screenshot({ path: `${SHOTS}/bubble-${width}-light.png` });
  });
}

test('3 photos: three dots centred at the bottom, the bar moves with a swipe', async ({ page }) => {
  test.setTimeout(60_000);
  const plain = await plainProduct();
  // This product with only its first 3 photos, inside this test browser only.
  await page.route('**/rest/v1/products_view*', async (route: Route) => {
    const response = await route.fetch();
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) {
      await route.fulfill({ response });
      return;
    }
    const cut = (v: unknown) => (Array.isArray(v) ? v.slice(0, 3) : v);
    const rows = (body as Record<string, unknown>[]).map((row) =>
      row.id === plain.id
        ? { ...row, image_urls: cut(row.image_urls), image_urls_thumb: cut(row.image_urls_thumb), image_urls_card: cut(row.image_urls_card) }
        : row
    );
    await route.fulfill({ response, json: rows });
  });
  test.skip((plain.image_urls ?? []).length < 3, 'this product has fewer than 3 photos');
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, plain.slug);
  const dots = page.getByTestId('image-dots');
  await expect(dots.locator('i')).toHaveCount(3);
  await expect(page.getByTestId('image-counter')).toHaveCount(0);
  const d = await box(dots);
  expect(Math.abs(d.x + d.width / 2 - 195)).toBeLessThan(1.5);
  await expect(dots.locator('i').nth(0)).toHaveClass('is-on');
  expect(Math.round((await box(dots.locator('i').nth(0))).width)).toBe(16);
  await page.locator('.product-detail__carousel').evaluate((el) => el.scrollTo({ left: el.clientWidth, behavior: 'instant' as ScrollBehavior }));
  await expect(dots.locator('i').nth(1)).toHaveClass('is-on');
  await expect(dots.locator('i.is-on')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/dots-390-light.png` });
});

test('a 9-photo product shows the quiet "1 / 9" text, not dots', async ({ page }) => {
  test.setTimeout(60_000);
  const { products } = await catalogue();
  const many = products.find((p) => (p.image_urls ?? []).length > 7);
  test.skip(!many, 'no live product with more than 7 photos');
  const product = many as LiveProduct;
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, product.slug);
  const counter = page.getByTestId('image-counter');
  await expect(counter).toHaveText(`1 / ${(product.image_urls ?? []).length}`);
  await expect(page.getByTestId('image-dots')).toHaveCount(0);
  // No pill: no background, no border.
  const look = await counter.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, border: s.borderTopWidth };
  });
  expect(look.bg).toBe('rgba(0, 0, 0, 0)');
  expect(look.border).toBe('0px');
});

/* ---------------------------------------------------------------- options */

test('options: label above, one sideways line per group (never wraps), first chip lines up with the name, a finger on them still scrolls the page', async ({ page }) => {
  test.setTimeout(60_000);
  const product = await optionsProduct();
  await page.setViewportSize({ width: 360, height: 780 });
  await openProduct(page, product.slug);
  const rows = page.locator('.pdp-main .variant-row');
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
  const nameX = (await box(page.locator('.product-detail__name'))).x;

  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    const label = row.locator('.variant-row__label');
    const chips = row.locator('.variant-row__chips');
    // Label above the line.
    if ((await label.count()) > 0) expect((await box(label)).y + (await box(label)).height).toBeLessThanOrEqual((await box(chips)).y + 1);
    // One line: every chip on the same top; the line runs edge to edge.
    const tops = await chips.locator('.chip-select').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    const line = await box(chips);
    expect(Math.round(line.x)).toBe(0);
    expect(Math.round(line.width)).toBe(360);
    const first = await box(chips.locator('.chip-select').first());
    expect(Math.abs(first.x - nameX)).toBeLessThan(1.5);
  }
  // No "Region · Pink" text after a label.
  const labels = await page.locator('.pdp-main .variant-row__label').allTextContents();
  for (const text of labels) expect(text).not.toContain('·');

  // A finger resting on the options and moving up scrolls the page.
  const chips = rows.first().locator('.variant-row__chips');
  const c = await box(chips);
  const cdp = await page.context().newCDPSession(page);
  const before = await page.evaluate(() => window.scrollY);
  await swipe(cdp, 120, c.y + c.height / 2, 0, -260);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 100);

  // Sideways, a line wider than the screen scrolls on its own.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const wide = await chips.evaluate((el) => el.scrollWidth > el.clientWidth + 2);
  if (wide) {
    const at = await box(chips);
    await swipe(cdp, 300, at.y + at.height / 2, -220, 0);
    await page.waitForTimeout(400);
    expect(await chips.evaluate((el) => el.scrollLeft)).toBeGreaterThan(20);
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(5);
  }
  await page.screenshot({ path: `${SHOTS}/options-scrolled-360-light.png` });
});

test('switching option rolls the price (transform and opacity only) and updates Save %', async ({ page }) => {
  test.setTimeout(60_000);
  const product = await optionsProduct();
  // Different prices per option, inside this test browser only.
  const prices = new Map<string, { retail: number; offer: number }>();
  await page.route('**/rest/v1/product_variants_view*', async (route: Route) => {
    const response = await route.fetch();
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) {
      await route.fulfill({ response });
      return;
    }
    let n = 0;
    const rows = (body as Record<string, unknown>[]).map((row) => {
      if (row.product_id !== product.id) return row;
      n += 1;
      const retail = 1000 + n * 100;
      const offer = Math.round(retail * (0.9 - n * 0.05));
      prices.set(String(row.id), { retail, offer });
      return { ...row, retail_price: retail, offer_price: offer };
    });
    await route.fulfill({ response, json: rows });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, product.slug);
  const price = page.getByTestId('pdp-price');
  const firstText = (await price.textContent()) ?? '';

  // Pick the last chip of the first row (a different option).
  const chip = page.locator('.pdp-main .variant-row').first().locator('.chip-select').last();
  await chip.click();
  await expect(page.locator('.f721-roll__in')).toHaveCount(1);
  const animated = await page.evaluate(() => {
    const props = new Set<string>();
    for (const a of document.getAnimations()) {
      const effect = a.effect as KeyframeEffect | null;
      const target = effect?.target;
      if (!(target instanceof Element) || !target.closest('.f721-roll')) continue;
      for (const frame of effect?.getKeyframes() ?? []) {
        for (const key of Object.keys(frame)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(key)) props.add(key);
      }
    }
    return [...props];
  });
  expect(animated.filter((p) => !['transform', 'opacity'].includes(p))).toEqual([]);
  // The old number leaves, then only the new one is there.
  await expect(page.locator('.f721-roll__out')).toHaveCount(0, { timeout: 2000 });
  const selectedId = new URL(page.url()).searchParams.get('variant') ?? '';
  const chosen = prices.get(selectedId);
  expect(chosen, 'the picked option is one of the re-priced rows').toBeTruthy();
  const { retail, offer } = chosen as { retail: number; offer: number };
  await expect(price).not.toHaveText(firstText);
  await expect(price).toContainText(offer.toLocaleString('en-US'));
  await expect(page.locator('.pdp-save')).toHaveText(`Save ${Math.round(((retail - offer) / retail) * 100)}%`);
  // The Save pill is green (not orange).
  const fg = await page.locator('.pdp-save').evaluate((el) => getComputedStyle(el).color);
  expect(fg).toBe('rgb(30, 122, 67)');
});

/* ------------------------------------------------------- quantity and add */

test('quantity 2 + Add puts 2 in the cart; "Added" for about 1.3 s; first add opens the side cart, later adds fly; adds on top up to the limit, then the limit message', async ({ page }) => {
  test.setTimeout(90_000);
  const plain = await plainProduct();
  const limit = orderLimit({ order_limit_per_item: (await liveSettings()).order_limit_per_item });
  expect(limit, 'room for 2 + more').toBeGreaterThanOrEqual(3);
  await freshVisit(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, plain.slug);
  await countFlies(page);

  const value = page.getByTestId('pdp-qty-value');
  const minus = page.getByTestId('pdp-qty-minus');
  const plus = page.getByTestId('pdp-qty-plus');
  const add = page.getByTestId('add-to-cart');
  await expect(value).toHaveText('1');
  await expect(minus).toBeDisabled();
  await plus.click();
  await expect(value).toHaveText('2');
  await expect(minus).toBeEnabled();

  await add.click();
  const addedAt = Date.now();
  await expect(add).toHaveText('Added');
  await expect(value).toHaveText('1');
  expect(await cartCount(page)).toBe(2);
  // First add of the visit: the side cart opens (no fly).
  await expect(page.getByTestId('side-cart')).toHaveClass(/b70-cart--open/);
  expect(await flies(page)).toBe(0);
  await page.screenshot({ path: `${SHOTS}/added-side-cart-390-light.png` });
  await page.getByTestId('side-cart-keep').click();
  await expect(page.getByTestId('side-cart')).not.toHaveClass(/b70-cart--open/);
  await expect(add).toHaveText('Add to Cart', { timeout: 3000 });
  const back = Date.now() - addedAt;
  expect(back).toBeGreaterThan(1000);
  expect(back).toBeLessThan(2600);

  // Already in the cart: + stops at what may still be added.
  for (let i = 0; i < limit + 2; i++) if (await plus.isEnabled()) await plus.click();
  await expect(value).toHaveText(String(limit - 2));
  await expect(plus).toBeDisabled();
  await add.click();
  await expect(add).toHaveText('Added');
  expect(await cartCount(page)).toBe(limit);
  // A later add flies to the bubble.
  await expect.poll(() => flies(page)).toBe(1);
  await expect(page.getByTestId('side-cart')).not.toHaveClass(/b70-cart--open/);
  await expect(page.getByTestId('glass-cart-badge')).toHaveText(String(limit));

  // At the limit: the limit message, nothing added.
  await expect(add).toHaveText('Add to Cart', { timeout: 3000 });
  await add.click();
  await expect(page.getByTestId('limit-popup')).toBeVisible();
  await expect(page.getByTestId('limit-popup-title')).toHaveText(`Limit ${limit} per order`);
  expect(await cartCount(page)).toBe(limit);
  await page.screenshot({ path: `${SHOTS}/limit-390-light.png` });
});

/* ----------------------------------------------------------- the info block */

test('Arrives by: with the clock at Fri 27 Nov 2026, 10:00 Dhaka, the same last day as the Order Placed page for an outside-Dhaka order', async ({ page }) => {
  test.setTimeout(60_000);
  const NOW = '2026-11-27T04:00:00.000Z';
  await page.clock.setFixedTime(new Date(NOW));
  const plain = await plainProduct();
  const settings = await liveSettings();
  const inHand = plain.in_hand ?? true;
  const range = arrivalRange(NOW, 'outside_dhaka', !inHand, settings);
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, plain.slug);
  const line = page.getByTestId('pdp-delivery');
  if (range) {
    const last = range.to ?? range.from;
    const day = `${last.weekday.charAt(0)}${last.weekday.slice(1).toLowerCase()}, ${last.day} ${last.month}`;
    console.log(`[fix-72-1] Arrives by at Fri 27 Nov 10:00 (in hand: ${inHand}): ${day}`);
    await expect(line).toHaveText(`Arrives by ${day}`);
  } else {
    await expect(line).not.toContainText('Arrives by');
  }

  // The 2 x 2 block: stock, delivery, authentic, cash on delivery; two per row.
  const info = page.getByTestId('pdp-info');
  await expect(info.locator('li')).toHaveCount(4);
  await expect(page.getByTestId('stock-chip')).toHaveText('In stock');
  const cells = await info.locator('li').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  }));
  expect(cells[0].y).toBe(cells[1].y);
  expect(cells[2].y).toBe(cells[3].y);
  expect(cells[0].x).toBe(cells[2].x);
  expect(cells[1].x).toBe(cells[3].x);
  // It sits under the buy row; the old stock row and trust plate are gone.
  expect((await box(info)).y).toBeGreaterThan((await box(page.getByTestId('pdp-buy'))).y);
  await expect(page.locator('.pdp-stock, .trust-plate, [data-testid="trust-delivery"], [data-testid="pdp-buy-stepper"]')).toHaveCount(0);
});

/* ------------------------------------------------------ card quick-add sheet */

test("the card's quick-add sheet options look exactly as before (pills that wrap)", async ({ page }) => {
  test.setTimeout(60_000);
  const product = await optionsProduct();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/search?q=${encodeURIComponent(product.name)}`);
  const card = page.locator('.product-card', { hasText: product.name }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.locator('.cart-button').tap();
  const sheet = page.getByRole('dialog', { name: 'Choose options' });
  await expect(sheet).toBeVisible();
  const look = await sheet.locator('.chip-select').first().evaluate((el) => {
    const s = getComputedStyle(el);
    const row = getComputedStyle(el.parentElement as Element);
    return { height: s.height, radius: s.borderTopLeftRadius, wrap: row.flexWrap, overflow: row.overflowX };
  });
  expect(look).toEqual({ height: '32px', radius: '999px', wrap: 'wrap', overflow: 'visible' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/quick-add-sheet-390-light.png` });
});
