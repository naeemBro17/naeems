import { mkdirSync } from 'node:fs';
import type { CDPSession, Locator, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { select } from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';

// Batch 70: the side cart, the draggable cart bubble, fly-to-cart, the
// product page (heart and counter on the photo, in-page Add to Cart, the
// buy bar only once that button is gone, Read more), Kaarbar-style search
// and the Order Placed fixes.
//
// Nothing is written to Supabase: the cart is the browser's own, the
// product list is the live one with test rows added inside the test
// browser only, and the Order Placed page reads a made-up order from the
// browser's session. No real Storage file is downloaded (./fixtures).

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Dhaka' });

const SHOTS = 'reports/batch-70-screens';

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
}

/** Live in-stock products with no options and no stock count (no limit
 *  from stock); the first one has 2+ photos (the "1 / 2" counter shows). */
async function liveProducts(count: number): Promise<LiveProduct[]> {
  const res = await select<LiveProduct[]>(
    null,
    'products_view?select=id,slug,name,image_urls&is_active=eq.true&stock_status=eq.in_stock&stock_quantity=is.null&order=name.asc'
  );
  const variants = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id');
  const withOptions = new Set((variants.data ?? []).map((v) => v.product_id));
  const plain = (res.data ?? []).filter((p) => !withOptions.has(p.id) && p.slug);
  const main = plain.find((p) => (p.image_urls ?? []).length >= 2);
  expect(main, 'a live in-stock product with 2+ photos').toBeTruthy();
  const rest = plain.filter((p) => p.id !== main?.id).slice(0, count - 1);
  return [main as LiveProduct, ...rest];
}

const LONG_ABOUT = Array.from(
  { length: 9 },
  (_, i) => `Line ${i + 1} of a long description that Naeem wrote about this product, long enough to wrap on a phone.`
).join('\n');

const FAKE_ID = '00000000-0000-4000-8000-0000000070a1';
const DECOY_ID = '00000000-0000-4000-8000-0000000070a2';

/** The live product list, with a long "About" on one product and two test
 *  CeraVe rows for the search (inside this test browser only). */
async function patchCatalogue(page: Page, longAboutId: string | null): Promise<void> {
  await page.route('**/rest/v1/products_view*', async (route: Route) => {
    const response = await route.fetch();
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body) || body.length === 0) {
      await route.fulfill({ response });
      return;
    }
    const rows = body as Record<string, unknown>[];
    const patched = rows.map((row) => (row.id === longAboutId ? { ...row, description: LONG_ABOUT } : row));
    const base = rows[0];
    const fake = (id: string, name: string, slug: string) => ({
      ...base,
      id,
      name,
      slug,
      sku: `E2E-B70-${slug}`,
      brand: 'CeraVe',
      brand_id: null,
      is_active: true,
      stock_status: 'in_stock',
      stock_quantity: null,
      image_urls: [],
      image_urls_thumb: [],
      image_urls_card: [],
      region: null,
      size: null,
    });
    patched.push(fake(DECOY_ID, 'CeraVe Hydrating Cleanser 236ml (UK)', 'e2e-b70-cerave-uk'));
    patched.push(fake(FAKE_ID, 'CeraVe Foaming Cleanser 236ml (AUSTRALIA)', 'e2e-b70-cerave-au'));
    await route.fulfill({ response, json: patched });
  });
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

async function seedCart(page: Page, lines: { productId: string; quantity: number }[]): Promise<void> {
  await page.evaluate((list) => {
    window.localStorage.setItem(
      'nph_cart',
      JSON.stringify(list.map((l) => ({ productId: l.productId, variantId: null, variantLabel: null, quantity: l.quantity, priceAtAdd: 100 })))
    );
  }, lines);
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

const panel = (page: Page) => page.getByTestId('side-cart-panel');
const sideCart = (page: Page) => page.getByTestId('side-cart');

async function expectOpen(page: Page): Promise<void> {
  await expect(sideCart(page)).toHaveClass(/b70-cart--open/);
  await expect(panel(page)).toBeInViewport();
}

async function expectClosed(page: Page): Promise<void> {
  await expect(sideCart(page)).not.toHaveClass(/b70-cart--open/);
  await expect(sideCart(page)).toHaveAttribute('aria-hidden', 'true');
  // Slid out: not on screen any more.
  await expect(panel(page)).not.toBeInViewport({ timeout: 3000 });
}

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

/** Every animation running now on this batch's parts (the side cart, the
 *  flying photo, the bubble and its badge) changes only transform or
 *  opacity. */
async function onlyTransformAndOpacity(page: Page): Promise<void> {
  const animated = await page.evaluate(() => {
    const props = new Set<string>();
    for (const a of document.getAnimations()) {
      const effect = a.effect as KeyframeEffect | null;
      const target = effect?.target;
      if (!(target instanceof Element) || !target.closest('.b70-cart, .b70-fly, .glass-cart')) continue;
      for (const frame of effect?.getKeyframes() ?? []) {
        for (const key of Object.keys(frame)) {
          if (!['offset', 'computedOffset', 'easing', 'composite'].includes(key)) props.add(key);
        }
      }
    }
    return [...props];
  });
  expect(animated.filter((prop) => !['transform', 'opacity'].includes(prop))).toEqual([]);
}

/** Counts .b70-fly elements ever added to the page. */
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

const relatedAdd = (page: Page) =>
  page.getByTestId('related-products').getByRole('button', { name: /^Add .* to cart$/ }).first();

/* ------------------------------------------------ the side cart, end to end */

test('first add opens "Added to cart" with the line on top; a second add flies; the bubble opens "Your cart"; + / - / Remove; total = cart page; View cart', async ({ page }) => {
  test.setTimeout(90_000);
  const [main] = await liveProducts(1);
  await freshVisit(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, main.slug);
  await countFlies(page);

  await page.getByTestId('add-to-cart').click();
  await expectOpen(page);
  await expect(page.getByTestId('side-cart-title')).toHaveText('Added to cart');
  const first = page.getByTestId('side-cart-line').first();
  await expect(first).toHaveAttribute('data-highlighted', 'true');
  await expect(first).toHaveClass(/b70-li--new/);
  await expect(first).toContainText(main.name);
  await expect(page.getByTestId('side-cart-total')).toBeVisible();
  // The panel takes focus.
  await expect(panel(page)).toBeFocused();

  await page.getByTestId('side-cart-keep').click();
  await expectClosed(page);
  // Fix 72.1: the in-page button stays Add to Cart (no in-page stepper).
  await expect(page.getByTestId('add-to-cart')).toHaveText(/Add to Cart|Added/);
  await expect(page.getByTestId('pdp-buy-stepper')).toHaveCount(0);

  // Second add, from "You may also like": no panel, it flies, the badge grows.
  const badge = page.getByTestId('glass-cart-badge');
  await expect(badge).toHaveText('1');
  const related = relatedAdd(page);
  await related.scrollIntoViewIfNeeded();
  await related.click();
  await expect(badge).toHaveText('2');
  await page.waitForTimeout(400);
  await expect(sideCart(page)).not.toHaveClass(/b70-cart--open/);
  expect(await flies(page)).toBe(1);
  await expect(page.locator('.b70-fly')).toHaveCount(0, { timeout: 3000 });

  // The bubble opens "Your cart".
  await page.getByTestId('glass-cart').click();
  await expectOpen(page);
  await expect(page.getByTestId('side-cart-title')).toHaveText('Your cart 2 items');
  await expect(page.getByTestId('side-cart-line')).toHaveCount(2);
  await expect(page.getByTestId('side-cart-line').first()).toHaveAttribute('data-highlighted', 'false');

  // + / - / Remove.
  const line = page.getByTestId('side-cart-line').first();
  await line.getByTestId('side-cart-plus').click();
  await expect(line.getByTestId('side-cart-qty')).toHaveText('2');
  await expect(page.locator('.b70-tot span')).toHaveText('Total (3 items)');
  await line.getByTestId('side-cart-minus').click();
  await expect(line.getByTestId('side-cart-qty')).toHaveText('1');
  await page.getByTestId('side-cart-line').nth(1).getByTestId('side-cart-remove').click();
  await expect(page.getByTestId('side-cart-line')).toHaveCount(1);
  await expect(page.getByTestId('undo-toast')).toBeVisible();
  await page.getByTestId('undo-button').click();
  await expect(page.getByTestId('side-cart-line')).toHaveCount(2);
  await page.getByTestId('side-cart-line').first().getByTestId('side-cart-plus').click();
  await expect(page.locator('.b70-tot span')).toHaveText('Total (3 items)');

  const panelTotal = (await page.getByTestId('side-cart-total').textContent())?.trim();
  await page.getByTestId('side-cart-view').click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByTestId('cart-subtotal')).toHaveText(panelTotal ?? 'missing');
  await expect(sideCart(page)).toHaveCount(0);
});

test('Checkout goes to /checkout/delivery the cart page way (sign-in sheet when logged out); Keep shopping, close, dim page, Escape and Back close it', async ({ page }) => {
  test.setTimeout(90_000);
  const [main, other] = await liveProducts(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/shop');
  await seedCart(page, [
    { productId: main.id, quantity: 1 },
    { productId: other.id, quantity: 1 },
  ]);
  await openProduct(page, main.slug);
  const bubble = page.getByTestId('glass-cart');

  await bubble.click();
  await expectOpen(page);
  await page.getByTestId('side-cart-close').click();
  await expectClosed(page);
  await expect(bubble).toBeFocused();

  await bubble.click();
  await expectOpen(page);
  await page.mouse.click(20, 400);
  await expectClosed(page);

  await bubble.click();
  await expectOpen(page);
  await page.keyboard.press('Escape');
  await expectClosed(page);

  // The phone's Back closes it and stays on the product page.
  await bubble.click();
  await expectOpen(page);
  await page.goBack();
  await expectClosed(page);
  await expect(page).toHaveURL(new RegExp(`/product/${main.slug}$`));

  // Logged out: Checkout closes the panel and asks to sign in, as the cart page does.
  await bubble.click();
  await expectOpen(page);
  await page.getByTestId('side-cart-checkout').click();
  await expectClosed(page);
  await expect(page.getByRole('dialog').filter({ hasText: /google/i })).toBeVisible();
});

test('Checkout goes straight to /checkout/delivery when signed in', async ({ page }) => {
  test.setTimeout(90_000);
  const [main] = await liveProducts(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsTestCustomer(page);
  await page.goto('/shop');
  await seedCart(page, [{ productId: main.id, quantity: 1 }]);
  await openProduct(page, main.slug);
  await page.getByTestId('glass-cart').click();
  await expectOpen(page);
  await page.getByTestId('side-cart-checkout').click();
  await expect(page).toHaveURL(/\/checkout\/delivery$/, { timeout: 20_000 });
});

test('swipe: a sideways swipe of 120 px closes it; a vertical swipe does not, and the list scrolls; the page behind never scrolls', async ({ page }) => {
  test.setTimeout(90_000);
  const list = await liveProducts(9);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/shop');
  await seedCart(page, list.map((p) => ({ productId: p.id, quantity: 1 })));
  await openProduct(page, list[0].slug);
  const cdp = await page.context().newCDPSession(page);

  await page.getByTestId('glass-cart').click();
  await expectOpen(page);
  await page.waitForTimeout(400);
  const scroller = page.getByTestId('side-cart-list');
  const before = await page.evaluate(() => window.scrollY);
  const listBox = await box(scroller);
  // Finger on a product photo in the list (never a button).
  const x = listBox.x + 40;
  const y = listBox.y + listBox.height - 60;
  await swipe(cdp, x, y, 0, -260);
  await page.waitForTimeout(600);
  await expect(sideCart(page)).toHaveClass(/b70-cart--open/);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(40);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);

  await swipe(cdp, x, listBox.y + 100, 120, 6);
  await expectClosed(page);

  // A short sideways move springs back.
  await page.getByTestId('glass-cart').click();
  await expectOpen(page);
  await page.waitForTimeout(400);
  await swipe(cdp, x, listBox.y + 100, 40, 0);
  await page.waitForTimeout(500);
  await expect(sideCart(page)).toHaveClass(/b70-cart--open/);
  expect(await panel(page).evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
});

test('vertical page scroll still works with a finger on the product photo', async ({ page }) => {
  test.setTimeout(60_000);
  const [main] = await liveProducts(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, main.slug);
  const cdp = await page.context().newCDPSession(page);
  const photo = await box(page.locator('.product-detail__carousel'));
  await swipe(cdp, photo.x + photo.width / 2, photo.y + photo.height - 40, 0, -300);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
});

test('dragging the bubble to the left edge keeps it there after a reload', async ({ page }) => {
  test.setTimeout(60_000);
  const [main] = await liveProducts(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/shop');
  await seedCart(page, [{ productId: main.id, quantity: 1 }]);
  await page.reload();
  const bubble = page.getByTestId('glass-cart');
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  const start = await box(bubble);
  // A finger from its centre to x 80, 100 px up.
  const cdp = await page.context().newCDPSession(page);
  const cx = start.x + start.width / 2;
  const cy = start.y + start.height / 2;
  await swipe(cdp, cx, cy, 80 - cx, -100);
  await page.waitForTimeout(500);
  await expect(bubble).toHaveAttribute('data-side', 'left');
  await expect(sideCart(page)).not.toHaveClass(/b70-cart--open/);
  const left = await box(bubble);
  expect(left.x).toBeGreaterThanOrEqual(11);
  expect(left.x).toBeLessThanOrEqual(13.5);
  expect(Math.abs(left.y - (start.y - 100))).toBeLessThan(4);
  const stored = await page.evaluate(() => window.localStorage.getItem('naeems.cartBubble'));
  expect(JSON.parse(stored ?? '{}').side).toBe('left');

  await page.reload();
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  const again = await box(bubble);
  expect(again.x).toBeLessThanOrEqual(13.5);
  expect(Math.abs(again.y - left.y)).toBeLessThan(4);

  // On the product page it stays where it was put (clear of the buy bar).
  await openProduct(page, main.slug);
  const pdp = await box(bubble);
  expect(pdp.x).toBeLessThanOrEqual(13.5);
  // A tap (no drag) still opens the side cart.
  await bubble.click();
  await expectOpen(page);
});

/* ------------------------------------------------------------ product page */

test('product page: heart bottom-right of the photo, the "1 / N" pill bottom-left (Fix 72.2), buy bar hidden on the first screen and shown past the in-page button; Read more / Show less', async ({ page }) => {
  test.setTimeout(90_000);
  const [main] = await liveProducts(1);
  await patchCatalogue(page, main.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, main.slug);

  const gallery = await box(page.locator('.product-detail__gallery'));
  const heart = await box(page.getByTestId('photo-heart'));
  const counter = await box(page.getByTestId('image-counter'));
  const overlap = 24;
  const photoBottom = gallery.y + gallery.height - overlap;
  expect(heart.x + heart.width).toBeLessThanOrEqual(gallery.x + gallery.width - 15.5);
  expect(heart.y + heart.height).toBeLessThanOrEqual(photoBottom);
  expect(heart.y + heart.height).toBeGreaterThan(photoBottom - 30);
  expect(heart.width).toBeGreaterThanOrEqual(44);
  expect(Math.round(counter.x - gallery.x)).toBe(12);
  expect(counter.x + counter.width).toBeLessThan(heart.x - 4);
  expect(counter.y + counter.height).toBeGreaterThan(photoBottom - 40);
  await expect(page.getByTestId('pdp-header').getByTestId('wish-heart')).toHaveCount(0);
  await expect(page.getByTestId('pdp-sheet-dots')).toHaveCount(0);
  await expect(page.getByTestId('photo-heart').getByTestId('wish-heart')).toBeVisible();

  // First screen: the in-page button is on screen, the bar is away.
  await expect(page.getByTestId('add-to-cart')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('buy-bar')).toHaveAttribute('data-shown', 'false');

  // Read more.
  const about = page.getByTestId('pdp-about-box');
  const folded = (await box(about)).height;
  const more = page.getByTestId('pdp-read-more');
  await more.scrollIntoViewIfNeeded();
  await expect(more).toHaveText('Read more');
  // Past the in-page button (under the top bar): the bar comes in.
  const buyTop = await page.getByTestId('pdp-buy').evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y), buyTop - 40);
  await expect(page.getByTestId('buy-bar')).toHaveAttribute('data-shown', 'true');
  await more.scrollIntoViewIfNeeded();
  await more.click();
  await expect(more).toHaveText('Show less');
  expect((await box(about)).height).toBeGreaterThan(folded * 1.5);
  expect(await about.evaluate((el) => getComputedStyle(el.querySelector('[data-testid="pdp-about"]') as Element).textAlign)).toMatch(/left|start/);
  await more.click();
  await expect(more).toHaveText('Read more');
  expect(Math.round((await box(about)).height)).toBe(Math.round(folded));

  // Back to the top: the bar goes away again.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByTestId('buy-bar')).toHaveAttribute('data-shown', 'false');
});

for (const size of [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
]) {
  test(`first screen at ${size.width} x ${size.height}: whole photo, brand, name, price, stock, delivery and Add to Cart without scrolling`, async ({ page }) => {
    test.setTimeout(60_000);
    const [main] = await liveProducts(1);
    await page.setViewportSize(size);
    await openProduct(page, main.slug);
    for (const sel of ['.product-detail__name', '.product-detail__price', '[data-testid="stock-chip"]', '[data-testid="add-to-cart"]']) {
      await expect(page.locator(sel).first()).toBeInViewport({ ratio: 1 });
    }
    const delivery = page.getByTestId('pdp-delivery');
    if ((await delivery.count()) > 0) await expect(delivery).toBeInViewport({ ratio: 1 });
    const fit = await page.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>('.product-detail__image');
      if (!img) return null;
      return { fit: getComputedStyle(img).objectFit, bottom: img.getBoundingClientRect().bottom };
    });
    expect(fit?.fit).toBe('contain');
    expect(fit?.bottom ?? Infinity).toBeLessThanOrEqual(size.height);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
}

/* --------------------------------------------------- motion and reduced motion */

test('only transform and opacity animate (panel open, nudge, fly, badge pop)', async ({ page }) => {
  test.setTimeout(60_000);
  const [main] = await liveProducts(1);
  await freshVisit(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, main.slug);
  await page.getByTestId('add-to-cart').click();
  await page.waitForTimeout(120);
  await onlyTransformAndOpacity(page);
  await page.waitForTimeout(500);
  await expect(panel(page)).toHaveClass(/b70-panel--nudge/);
  await onlyTransformAndOpacity(page);
  await page.getByTestId('side-cart-keep').click();
  await expectClosed(page);
  await relatedAdd(page).scrollIntoViewIfNeeded();
  await relatedAdd(page).click();
  await page.waitForTimeout(150);
  await onlyTransformAndOpacity(page);
  await page.waitForTimeout(600);
  await onlyTransformAndOpacity(page);
});

test('reduced motion: no fly, no nudge, and the panel appears with no slide', async ({ page }) => {
  test.setTimeout(60_000);
  const [main] = await liveProducts(1);
  await freshVisit(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, main.slug);
  await countFlies(page);
  await page.getByTestId('add-to-cart').click();
  await expectOpen(page);
  const style = await panel(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return { duration: s.transitionDuration, animation: s.animationName };
  });
  expect(style.duration).toBe('0s');
  expect(style.animation).toBe('none');
  await page.getByTestId('side-cart-keep').click();
  await relatedAdd(page).scrollIntoViewIfNeeded();
  await relatedAdd(page).click();
  await expect(page.getByTestId('glass-cart-badge')).toHaveText('2');
  await page.waitForTimeout(700);
  expect(await flies(page)).toBe(0);
});

/* ------------------------------------------------------------------ search */

test('search: "cerave 236 aus f" shows the Foaming Cleanser (AUSTRALIA) first, not the Hydrating one (UK)', async ({ page }) => {
  test.setTimeout(60_000);
  await patchCatalogue(page, null);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/search');
  const input = page.getByRole('combobox', { name: 'Search products' });
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill('cerave 236 aus f');
  await page.keyboard.press('Enter');
  const names = page.locator('.product-card .product-card__name');
  await expect(names.first()).toHaveText('CeraVe Foaming Cleanser 236ml (AUSTRALIA)', { timeout: 10_000 });
  await expect(page.locator('.product-card', { hasText: 'CeraVe Hydrating Cleanser 236ml (UK)' })).toHaveCount(0);
  await input.fill('aus cerave');
  await page.keyboard.press('Enter');
  await expect(names.first()).toHaveText('CeraVe Foaming Cleanser 236ml (AUSTRALIA)');
});

/* ------------------------------------------------------------ Order Placed */

const ADDRESS = {
  fullName: 'Ashraful Islam',
  phone: '01712345678',
  division: 'Dhaka',
  district: 'Dhaka',
  thana: 'Gulshan',
  fullAddress: '123 Test Road (e2e)',
};

function placedState(celebrated: boolean) {
  return {
    zoneId: 'inside_dhaka',
    address: ADDRESS,
    promo: null,
    lastOrder: {
      orderId: '00000000-0000-4000-8000-000000007001',
      orderNumber: 'NM-7001',
      items: [{ product: { id: 'p', name: 'E2E B70 Serum' }, variantId: null, variantLabel: null, variantImage: null, quantity: 1, unitPrice: 950 }],
      zone: { id: 'inside_dhaka', label: 'Inside Dhaka', fee: 70 },
      address: ADDRESS,
      promo: null,
      subtotal: 950,
      discount: 0,
      total: 1020,
      paymentMethod: 'cod',
      bkashTrxId: null,
      placedAt: new Date().toISOString(),
      advanceDiscount: 0,
      advanceRule: null,
      buysLater: false,
      celebrated,
    },
  };
}

async function openPlaced(page: Page, width: number, height: number, deliveryDhaka: string | null = null): Promise<void> {
  await page.setViewportSize({ width, height });
  // In this test browser only: the delivery days asked for, and a WhatsApp
  // number when the live settings have none (so Need help? shows).
  await page.route('**/rest/v1/app_settings*', async (route) => {
    const response = await route.fetch();
    let rows = (await response.json()) as { key: string; value: string }[];
    if (!rows.some((r) => r.key === 'shop_whatsapp_number' && r.value)) {
      rows = [...rows.filter((r) => r.key !== 'shop_whatsapp_number'), { key: 'shop_whatsapp_number', value: '01700000000' }];
    }
    if (deliveryDhaka !== null) {
      rows = [...rows.filter((r) => r.key !== 'delivery_time_dhaka'), { key: 'delivery_time_dhaka', value: deliveryDhaka }];
    }
    await route.fulfill({ response, json: rows });
  });
  await page.addInitScript((state) => {
    if (window.sessionStorage.getItem('e2e-b70-placed')) return;
    window.sessionStorage.setItem('e2e-b70-placed', '1');
    window.sessionStorage.setItem('nph_checkout_state', state);
  }, JSON.stringify(placedState(true)));
  await page.goto('/checkout/success');
  await expect(page.getByTestId('order-placed')).toBeVisible({ timeout: 20_000 });
  // The shop's settings have arrived (Need help? needs the WhatsApp number).
  await expect(page.getByTestId('placed-need-help')).toBeVisible({ timeout: 20_000 });
}

test('Order Placed: one tap on the sound switch (in the scene) toggles it; nothing covers it', async ({ page }) => {
  test.setTimeout(60_000);
  await openPlaced(page, 390, 844);
  const sound = page.getByTestId('placed-sound');
  await expect(sound).toBeVisible();
  const scene = await box(page.getByTestId('placed-scene'));
  const b = await box(sound);
  expect(b.x + b.width).toBeLessThanOrEqual(scene.x + scene.width);
  expect(b.y).toBeGreaterThan(scene.y + scene.height - 50);
  expect(b.width).toBeGreaterThanOrEqual(44);
  const on = await sound.getAttribute('aria-pressed');
  // A real tap at its centre reaches the button (nothing on top of it).
  const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="placed-sound"]') !== null, {
    x: b.x + b.width / 2,
    y: b.y + b.height / 2,
  });
  expect(top).toBe(true);
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await expect(sound).toHaveAttribute('aria-pressed', on === 'true' ? 'false' : 'true');
  await expect(page.locator('.b69-head [data-testid="placed-sound"]')).toHaveCount(0);
});

test('Order Placed at 360 px: two dates on one line (option C) and four equal buttons, two by two, nothing cut', async ({ page }) => {
  test.setTimeout(60_000);
  await openPlaced(page, 360, 780);
  await expect(page.getByTestId('placed-arriving').locator('.b70-d')).toHaveCount(2);
  await expect(page.getByTestId('placed-arriving').locator('.b70-van')).toHaveCount(1);
  const fit = await page.evaluate(() => {
    const dates = [...document.querySelectorAll('.b70-d b')].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height, text: el.textContent ?? '', cut: (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth };
    });
    const buttons = [...document.querySelectorAll('[data-testid="placed-actions"] > *')].map((el) => {
      const r = el.getBoundingClientRect();
      const h = el as HTMLElement;
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), cut: h.scrollWidth > h.clientWidth };
    });
    return { dates, buttons, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(fit.dates.length).toBe(2);
  expect(Math.abs(fit.dates[0].top - fit.dates[1].top)).toBeLessThan(1);
  for (const d of fit.dates) {
    expect(d.text).toMatch(/^\d{2} [A-Z][a-z]{2}$/);
    expect(d.cut).toBe(false);
    expect(d.height).toBeLessThan(34);
  }
  expect(fit.buttons.length).toBe(4);
  for (const b of fit.buttons) {
    expect(b.height).toBe(52);
    expect(b.cut).toBe(false);
  }
  expect(fit.buttons[0].top).toBe(fit.buttons[1].top);
  expect(fit.buttons[2].top).toBe(fit.buttons[3].top);
  expect(fit.buttons[2].top).toBeGreaterThan(fit.buttons[0].top);
  expect(Math.abs(fit.buttons[0].width - fit.buttons[1].width)).toBeLessThanOrEqual(1);
  expect(fit.overflow).toBeLessThanOrEqual(0);
});

test('Order Placed: a one-day delivery shows one date and no route line', async ({ page }) => {
  test.setTimeout(60_000);
  await openPlaced(page, 390, 844, '1 day');
  const eta = page.getByTestId('placed-arriving');
  await expect(eta.locator('.b70-d')).toHaveCount(1);
  await expect(eta.locator('.b70-line')).toHaveCount(0);
  await expect(eta.locator('.b70-eta__lab')).toHaveText('Arriving on');
  await expect(eta).toHaveAttribute('aria-label', /^Arriving /);
});

/* ---------------------------------------------------------------- captures */

for (const size of [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`captures ${size.width} x ${size.height} ${theme}`, async ({ page }) => {
      test.setTimeout(120_000);
      const [main] = await liveProducts(1);
      const tag = `${size.width}-${theme}`;
      await freshVisit(page);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.setViewportSize(size);
      await page.goto('/shop');
      await page.evaluate(() => window.localStorage.removeItem('naeems.cartBubble'));
      await openProduct(page, main.slug);
      await setTheme(page, theme);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/pdp-first-screen-${tag}.png` });

      await page.getByTestId('add-to-cart').click();
      await expectOpen(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/panel-first-add-${tag}.png` });
      await page.getByTestId('side-cart-keep').click();
      await expectClosed(page);

      await relatedAdd(page).scrollIntoViewIfNeeded();
      await relatedAdd(page).click();
      await expect(page.getByTestId('buy-bar')).toHaveAttribute('data-shown', 'true');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/pdp-scrolled-bar-${tag}.png` });

      await page.getByTestId('glass-cart').click();
      await expectOpen(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/panel-from-bubble-${tag}.png` });
      await page.keyboard.press('Escape');
      await expectClosed(page);

      await page.goto('/shop');
      await setTheme(page, theme);
      const bubble = page.getByTestId('glass-cart');
      await expect(bubble).toBeVisible({ timeout: 20_000 });
      const b = await box(bubble);
      const cdp = await page.context().newCDPSession(page);
      await swipe(cdp, b.x + b.width / 2, b.y + b.height / 2, 60 - (b.x + b.width / 2), 80);
      await expect(bubble).toHaveAttribute('data-side', 'left');
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/bubble-left-${tag}.png` });

      await page.evaluate((state) => window.sessionStorage.setItem('nph_checkout_state', state), JSON.stringify(placedState(true)));
      await page.goto('/checkout/success');
      await expect(page.getByTestId('order-placed')).toBeVisible({ timeout: 20_000 });
      await setTheme(page, theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/order-placed-${tag}.png`, fullPage: true });
    });
  }
}
