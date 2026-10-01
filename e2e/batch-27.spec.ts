import type { Locator, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { select } from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';
import { E2E_EMAIL, E2E_PASSWORD } from './helpers/env';

/**
 * Covers reports/batch-27.txt — product page redesign, glass cart, card
 * stepper, "You may also like", card titles.
 */

interface LiveProduct {
  id: string;
  slug: string;
  name: string;
  stock_quantity: number | null;
  has_wholesale: boolean;
  how_to_use: string | null;
  key_ingredients: string | null;
}

const LIVE_SELECT = 'id,slug,name,stock_quantity,has_wholesale,how_to_use,key_ingredients';

/** A live product without options whose stock is tracked and small (2–9). */
async function smallStockProduct(): Promise<LiveProduct | null> {
  const res = await select<LiveProduct[]>(
    null,
    `products_view?select=${LIVE_SELECT}&is_active=eq.true&stock_quantity=gte.2&stock_quantity=lte.9&order=stock_quantity.asc`
  );
  const variants = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id');
  const withOptions = new Set((variants.data ?? []).map((v) => v.product_id));
  return (res.data ?? []).find((p) => !withOptions.has(p.id)) ?? null;
}

async function emptyCart(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
}

async function cartUnits(page: Page): Promise<number> {
  return page.evaluate(() =>
    (JSON.parse(localStorage.getItem('nph_cart') ?? '[]') as { quantity: number }[]).reduce(
      (sum, line) => sum + line.quantity,
      0
    )
  );
}

async function openFresh(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await emptyCart(page);
  await page.reload();
}

/** Scrolls so `el` sits `offset` px below the top of the screen. */
async function scrollElementTo(el: Locator, offset: number): Promise<void> {
  await el.evaluate((node, off) => {
    window.scrollBy({ top: node.getBoundingClientRect().top - off, behavior: 'instant' });
  }, offset);
  await el.page().waitForTimeout(150);
}

function cardNamed(page: Page, name: string): Locator {
  return page.locator('.product-card', { has: page.locator('.product-card__name', { hasText: name }) }).first();
}


/** Gives one live in-stock product a test option, in this page only (the
 *  database is untouched) — the live catalogue has no products with options
 *  today (Batch 24 split them), and these tests must not depend on that. */
async function seedOption(page: Page): Promise<string> {
  const live = await select<{ id: string; name: string; retail_price: number }[]>(
    null,
    'products_view?select=id,name,retail_price&is_active=eq.true&stock_status=eq.in_stock&stock_quantity=is.null&order=name.asc&limit=1'
  );
  const target = live.data?.[0];
  expect(target).toBeTruthy();
  const t = target as { id: string; name: string; retail_price: number };
  await page.route(/\/rest\/v1\/product_variants_view\?/, async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as unknown[];
    const option = {
      id: '00000000-0000-4000-8000-00000000b027',
      product_id: t.id,
      region: 'Test region',
      size: '999ml',
      retail_price: t.retail_price + 100,
      offer_price: null,
      wholesale_price: null,
      has_wholesale: false,
      in_stock: true,
      stock_quantity: null,
      image_url: null,
      note: null,
      source_product_id: null,
      sort_order: 1,
      created_at: '2026-01-01T00:00:00Z',
    };
    await route.fulfill({ response, json: Array.isArray(body) ? [...body, option] : body });
  });
  return t.name;
}

// ---------------------------------------------------------------------------
// PART 1 — product page
// ---------------------------------------------------------------------------

test.describe('Part 1 — product page', () => {
  test('header cart badge equals the cart count and opens the cart; no theme toggle in the header', async ({ page }) => {
    await page.goto('/product/aveeno-baby-daily-moisture-lightly-scented-wash-shampoo-236ml');
    await page.evaluate(() =>
      localStorage.setItem(
        'nph_cart',
        JSON.stringify([
          { productId: 'x-test-1', variantId: null, variantLabel: null, quantity: 2, priceAtAdd: 100 },
          { productId: 'x-test-2', variantId: null, variantLabel: null, quantity: 1, priceAtAdd: 100 },
        ])
      )
    );
    await page.reload();
    const header = page.getByTestId('pdp-header');
    await expect(header.getByTestId('header-cart-badge')).toHaveText('3');
    await expect(header.getByRole('button', { name: /theme|dark|light/i })).toHaveCount(0);

    await page.getByTestId('add-to-cart').click();
    await expect(header.getByTestId('header-cart-badge')).toHaveText('4');

    await header.getByTestId('header-cart').click();
    await expect(page).toHaveURL(/\/cart$/);
    await emptyCart(page);
  });

  test('the brand link opens the brand page', async ({ page }) => {
    await page.goto('/product/aveeno-baby-daily-moisture-lightly-scented-wash-shampoo-236ml');
    const link = page.getByTestId('product-brand-link');
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/brand\/aveeno$/);
    await expect(page.locator('.brand-page__name')).toHaveText(/aveeno/i);
  });

  test('quantity stepper: min 1, max = stock; Add to Cart adds the chosen quantity', async ({ page }) => {
    const product = await smallStockProduct();
    test.skip(product === null, 'No product with a small tracked stock count today.');
    const p = product as LiveProduct;
    const stock = p.stock_quantity as number;

    await openFresh(page, `/product/${p.slug}`);
    const value = page.getByTestId('qty-value');
    const minus = page.getByRole('button', { name: 'Decrease quantity' });
    const plus = page.getByRole('button', { name: 'Increase quantity' });
    await expect(value).toHaveText('1');
    await expect(minus).toBeDisabled();

    for (let i = 1; i < stock + 2; i++) await plus.click();
    await expect(value).toHaveText(String(stock));
    await expect(page.locator('.toast', { hasText: `Only ${stock} in stock` }).first()).toBeVisible();

    await minus.click();
    await expect(value).toHaveText(String(stock - 1));
    await plus.click();
    await expect(value).toHaveText(String(stock));

    await page.getByTestId('add-to-cart').click();
    await expect.poll(() => cartUnits(page)).toBe(stock);
    await expect(page.getByTestId('header-cart-badge')).toHaveText(String(stock));
    await expect(page.getByTestId('add-to-cart')).toContainText('Added');
    // Everything in stock is now in the cart: nothing more can be added.
    await expect(page.getByTestId('add-to-cart')).toHaveText('All in your cart', { timeout: 3000 });
    await expect(page.getByTestId('add-to-cart')).toBeDisabled();
    await emptyCart(page);
  });

  test('sticky bar shows only once the main button is off screen, hides again, and adds', async ({ page }) => {
    await openFresh(page, '/product/aveeno-baby-daily-moisture-lightly-scented-wash-shampoo-236ml');
    const bar = page.getByTestId('sticky-bar');
    const buyRow = page.getByTestId('buy-row');
    await expect(bar).not.toHaveClass(/pdp-sticky--shown/);

    // Main button on screen → no bar.
    await scrollElementTo(buyRow, 400);
    await expect(bar).not.toHaveClass(/pdp-sticky--shown/);

    // Main button scrolled up out of view → bar.
    await scrollElementTo(buyRow, -200);
    await expect(bar).toHaveClass(/pdp-sticky--shown/);
    await expect(bar).toHaveCSS('opacity', '1');
    await expect(bar.locator('.pdp-sticky__amount')).toHaveText(
      (await page.locator('.product-detail__price').textContent()) ?? ''
    );
    await page.getByTestId('sticky-add').click();
    await expect.poll(() => cartUnits(page)).toBe(1);

    // Back to the main button → bar hides.
    await scrollElementTo(buyRow, 400);
    await expect(bar).not.toHaveClass(/pdp-sticky--shown/);

    // The bar never covers the last content: the page ends with room for it.
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    await scrollElementTo(buyRow, -200);
    const lastContentBottom = await page.evaluate(() => {
      const main = document.querySelector('.pdp-main .product-detail') as HTMLElement;
      return main.getBoundingClientRect().bottom;
    });
    const barTop = (await bar.boundingBox())?.y ?? 0;
    if ((await page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2))) {
      expect(lastContentBottom).toBeLessThanOrEqual(barTop + 1);
    }
    await emptyCart(page);
  });

  test('opening and closing a section keeps its header at the same screen position (±2 px)', async ({ page }) => {
    await page.goto('/product/cerave-hydrating-cleanser');
    const closed = page.locator('.accordion__header[aria-expanded="false"]').first();
    await expect(closed).toBeVisible();
    const title = ((await closed.textContent()) ?? '').trim();
    const header = page.getByRole('button', { name: title, exact: true });
    await scrollElementTo(header, 420);
    const before = (await header.boundingBox())?.y ?? 0;

    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(80);
      expect(Math.abs(((await header.boundingBox())?.y ?? 0) - before)).toBeLessThanOrEqual(2);
    }
    await page.waitForTimeout(400);
    expect(Math.abs(((await header.boundingBox())?.y ?? 0) - before)).toBeLessThanOrEqual(2);

    // A section above it opening must not move it either (it is pinned only
    // while tapped — this checks the tapped one, like a shopper would see).
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(500);
    expect(Math.abs(((await header.boundingBox())?.y ?? 0) - before)).toBeLessThanOrEqual(2);
  });

  test('no tap highlight anywhere on the shop', async ({ page }) => {
    await page.goto('/product/cerave-hydrating-cleanser');
    await expect(page.locator('.accordion__header').first()).toBeVisible();
    const colours = await page.evaluate(() =>
      ['.accordion__header', '[data-testid="add-to-cart"]', '.detail-header__back', '.product-card', 'body'].map(
        (sel) => {
          const el = document.querySelector(sel);
          return el ? getComputedStyle(el).getPropertyValue('-webkit-tap-highlight-color') : 'rgba(0, 0, 0, 0)';
        }
      )
    );
    for (const c of colours) expect(c).toBe('rgba(0, 0, 0, 0)');
    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible();
    const card = await page.locator('.product-card').first().evaluate((el) =>
      getComputedStyle(el).getPropertyValue('-webkit-tap-highlight-color')
    );
    expect(card).toBe('rgba(0, 0, 0, 0)');
  });

  test('video: our own cover before play and after pause; taps never leave the site', async ({ page, context }) => {
    test.setTimeout(60_000);
    const opened: string[] = [];
    context.on('page', (p) => opened.push(p.url()));
    await page.goto('/product/cerave-hydrating-cleanser');
    const header = page.getByRole('button', { name: 'Video review', exact: true });
    await header.click();

    // Before play: thumbnail + our Play + label, and no YouTube frame yet.
    const cover = page.locator('.video-review');
    await cover.scrollIntoViewIfNeeded();
    await expect(cover.locator('.video-cover__img')).toHaveAttribute('src', /i\.ytimg\.com\/vi\/.+\/hqdefault\.jpg$/);
    await expect(cover.locator('.video-cover__play')).toBeVisible();
    await expect(cover.locator('.video-cover__label')).toHaveText('Reviewed on YouTube');
    await expect(page.locator('.video-player iframe')).toHaveCount(0);

    await cover.tap();
    const frame = page.locator('.video-player__frame');
    // Starting: still our cover over the player.
    await expect(frame.getByTestId('video-cover')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause video' })).toBeVisible({ timeout: 15_000 });

    const url = page.url();
    await page.locator('.video-player__surface').tap();
    // Paused: our cover goes up straight away and fills the whole player.
    const poster = frame.getByTestId('video-cover');
    await expect(poster).toBeVisible({ timeout: 300 });
    const fBox = await frame.boundingBox();
    const pBox = await poster.boundingBox();
    expect(fBox && pBox).toBeTruthy();
    expect(Math.abs((pBox?.width ?? 0) - (fBox?.width ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((pBox?.height ?? 0) - (fBox?.height ?? 0))).toBeLessThanOrEqual(1);
    await expect(poster.locator('.video-cover__play')).toBeVisible();
    await expect(poster.locator('.video-cover__label')).toHaveText('Reviewed on YouTube');
    await page.waitForTimeout(1500);
    await expect(poster).toBeVisible();

    expect(page.url()).toBe(url);
    expect(opened).toEqual([]);
  });

  test('the wholesale row is hidden for a normal customer (and a visitor)', async ({ page }) => {
    const res = await select<{ slug: string }[]>(null, 'products_view?select=slug&is_active=eq.true&has_wholesale=eq.true&limit=1');
    const slug = res.data?.[0]?.slug;
    test.skip(!slug, 'No product with a wholesale price today.');
    await page.goto(`/product/${slug}`);
    await expect(page.getByTestId('add-to-cart').or(page.locator('.copy-button--disabled')).first()).toBeVisible();
    await expect(page.locator('.wholesale-row')).toHaveCount(0);

    test.skip(!E2E_EMAIL || !E2E_PASSWORD, 'No test customer in .env.e2e.');
    await signInAsTestCustomer(page);
    await page.goto(`/product/${slug}`);
    await expect(page.getByTestId('add-to-cart').or(page.locator('.copy-button--disabled')).first()).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.locator('.wholesale-row')).toHaveCount(0);
  });

  test('no orange on the product page except the Add to Cart buttons (light and dark)', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.goto('/');
      await page.evaluate((t) => localStorage.setItem('theme', t), theme);
      await page.evaluate(() =>
        localStorage.setItem(
          'nph_cart',
          JSON.stringify([{ productId: 'x-test-1', variantId: null, variantLabel: null, quantity: 1, priceAtAdd: 100 }])
        )
      );
      await page.goto('/product/aveeno-baby-daily-moisture-lightly-scented-wash-shampoo-236ml');
      await expect(page.getByTestId('add-to-cart')).toBeVisible();
      await expect(page.getByTestId('related-products')).toBeVisible();
      await page.waitForTimeout(600);

      const offenders = await page.evaluate(() => {
        const allowed = '[data-testid="add-to-cart"], [data-testid="sticky-add"], .cart-count-badge';
        const isOrange = (value: string): boolean => {
          const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value);
          if (!m) return false;
          const alpha = m[4] === undefined ? 1 : Number(m[4]);
          if (alpha < 0.2) return false;
          const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const l = (max + min) / 2;
          const d = max - min;
          if (d === 0) return false;
          const s = d / (1 - Math.abs(2 * l - 1));
          let h = 0;
          if (max === r) h = 60 * (((g - b) / d) % 6);
          else if (max === g) h = 60 * ((b - r) / d + 2);
          else h = 60 * ((r - g) / d + 4);
          if (h < 0) h += 360;
          return h >= 10 && h <= 40 && s > 0.5 && l > 0.35 && l < 0.75;
        };
        const found: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
          if (el.closest(allowed)) continue;
          if (el.closest('img, svg image, iframe')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          let hidden = false;
          for (let a: HTMLElement | null = el; a; a = a.parentElement) {
            if (getComputedStyle(a).opacity === '0') {
              hidden = true;
              break;
            }
          }
          if (hidden) continue;
          const checks: Array<[string, string]> = [
            ['color', el.childNodes.length > 0 && (el.textContent ?? '').trim() !== '' ? style.color : ''],
            ['background', style.backgroundColor],
          ];
          for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
            if (parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0) {
              checks.push([`border-${side}`, style.getPropertyValue(`border-${side.toLowerCase()}-color`)]);
            }
          }
          for (const [what, value] of checks) {
            if (value && isOrange(value)) found.push(`${el.tagName}.${el.className} ${what} ${value}`);
          }
        }
        return found;
      });
      expect(offenders, `${theme}: ${offenders.join('\n')}`).toEqual([]);
      // The two allowed ones really are orange.
      const addBg = await page.getByTestId('add-to-cart').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(addBg).toBe('rgb(255, 122, 69)');
    }
    await emptyCart(page);
    await page.evaluate(() => localStorage.removeItem('theme'));
  });
});

// ---------------------------------------------------------------------------
// PART 2 — glass cart
// ---------------------------------------------------------------------------

test.describe('Part 2 — glass cart button', () => {
  test('hidden when empty, appears after the first add, counts, opens the cart, and goes when emptied', async ({ page }) => {
    await openFresh(page, '/');
    await expect(page.locator('.product-card').first()).toBeVisible();
    const glass = page.getByTestId('glass-cart');
    await expect(glass).toHaveCount(0);

    const firstAdd = page.getByRole('button', { name: /^Add .* to cart$/ }).first();
    const name = ((await firstAdd.getAttribute('aria-label')) ?? '').replace(/^Add /, '').replace(/ to cart$/, '');
    await scrollElementTo(firstAdd, 160);
    await firstAdd.click();
    await expect(glass).toBeVisible();
    await expect(glass.getByTestId('glass-cart-badge')).toHaveText('1');
    await expect(glass.locator('.glass-cart__inner')).toHaveClass(/cart-bump--enter/);

    // Middle of the right edge, round, 56–62 px, clear of the bottom nav.
    const box = await glass.boundingBox();
    const vw = page.viewportSize()?.width ?? 0;
    const vh = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    const b = box as { x: number; y: number; width: number; height: number };
    expect(b.width).toBeGreaterThanOrEqual(56);
    expect(b.width).toBeLessThanOrEqual(62);
    expect(Math.abs(b.y + b.height / 2 - vh / 2)).toBeLessThanOrEqual(2);
    expect(vw - (b.x + b.width)).toBeLessThanOrEqual(16);
    const navTop = (await page.locator('.bottom-nav').boundingBox())?.y ?? vh;
    expect(b.y + b.height).toBeLessThan(navTop);

    // A later add pulses and counts.
    const card = cardNamed(page, name);
    await card.getByRole('button', { name: `One more ${name}` }).click();
    await expect(glass.getByTestId('glass-cart-badge')).toHaveText('2');
    await expect(glass.locator('.glass-cart__inner')).toHaveClass(/cart-bump--pulse/);

    // Emptying the cart makes it go.
    await card.getByRole('button', { name: `One less ${name}` }).click();
    await card.getByRole('button', { name: `Remove ${name} from cart` }).click();
    await expect(glass).toHaveCount(0);

    // Tap opens the cart.
    await page.getByRole('button', { name: /^Add .* to cart$/ }).first().click();
    await glass.click();
    await expect(page).toHaveURL(/\/cart$/);
    await emptyCart(page);
  });

  test('shown on Search and brand pages, never on the product page, cart, checkout or admin', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() =>
      localStorage.setItem(
        'nph_cart',
        JSON.stringify([{ productId: 'x-test-1', variantId: null, variantLabel: null, quantity: 1, priceAtAdd: 100 }])
      )
    );
    const glass = page.getByTestId('glass-cart');
    for (const path of ['/', '/search', '/brands', '/brand/aveeno']) {
      await page.goto(path);
      await expect(glass, path).toBeVisible();
    }
    for (const path of [
      '/product/aveeno-baby-daily-moisture-lightly-scented-wash-shampoo-236ml',
      '/cart',
      '/checkout/delivery',
      '/admin',
      '/account',
    ]) {
      await page.goto(path);
      await page.waitForTimeout(600);
      // A visitor opening /admin is sent Home (where it rightly shows);
      // the rule for /admin itself is covered by GlassCartButton.test.ts.
      if (new URL(page.url()).pathname !== path) continue;
      await expect(glass, path).toHaveCount(0);
    }
    await emptyCart(page);
  });

  test('sits below open sheets: an open option picker covers it', async ({ page }) => {
    const optionName = await seedOption(page);
    await page.goto('/');
    await page.evaluate(() =>
      localStorage.setItem(
        'nph_cart',
        JSON.stringify([{ productId: 'x-test-1', variantId: null, variantLabel: null, quantity: 1, priceAtAdd: 100 }])
      )
    );
    await page.reload();
    const options = page.getByRole('button', { name: `Choose options for ${optionName}` });
    await expect(options).toBeVisible();
    await scrollElementTo(options, 160);
    await options.click();
    await expect(page.getByRole('dialog', { name: 'Choose options' })).toBeVisible();
    const z = await page.evaluate(() => {
      const glass = document.querySelector('[data-testid="glass-cart"]') as HTMLElement;
      const r = glass.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top ? Boolean(top.closest('[data-testid="glass-cart"]')) : false;
    });
    expect(z).toBe(false);
    await page.keyboard.press('Escape');
    await emptyCart(page);
  });
});

// ---------------------------------------------------------------------------
// PART 3 — card stepper
// ---------------------------------------------------------------------------

test.describe('Part 3 — card cart button becomes a stepper', () => {
  test('add → stepper; + and − change it; at 0 the button comes back; no brand line on cards', async ({ page }) => {
    await openFresh(page, '/');
    const firstAdd = page.getByRole('button', { name: /^Add .* to cart$/ }).first();
    const name = ((await firstAdd.getAttribute('aria-label')) ?? '').replace(/^Add /, '').replace(/ to cart$/, '');
    const card = cardNamed(page, name);
    await scrollElementTo(card, 120);

    // Neutral (not orange) button before.
    const bg = await card.locator('.cart-button').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgb(255, 122, 69)');
    await expect(page.locator('.product-card__brand')).toHaveCount(0);

    await card.locator('.cart-button').click();
    const qty = card.getByTestId('card-stepper-qty');
    await expect(qty).toHaveText('1');
    await card.getByRole('button', { name: `One more ${name}` }).click();
    await expect(qty).toHaveText('2');
    expect(await cartUnits(page)).toBe(2);
    await card.getByRole('button', { name: `One less ${name}` }).click();
    await expect(qty).toHaveText('1');
    await card.getByRole('button', { name: `Remove ${name} from cart` }).click();
    await expect(card.getByTestId('card-stepper')).toHaveCount(0);
    await expect(card.locator('.cart-button')).toBeVisible();
    expect(await cartUnits(page)).toBe(0);
    // The stepper taps never opened the product.
    await expect(page).toHaveURL(/\/$/);
  });

  test('stays in sync with the cart page and the product page', async ({ page }) => {
    await openFresh(page, '/');
    const firstAdd = page.getByRole('button', { name: /^Add .* to cart$/ }).first();
    const name = ((await firstAdd.getAttribute('aria-label')) ?? '').replace(/^Add /, '').replace(/ to cart$/, '');
    await scrollElementTo(firstAdd, 160);
    await firstAdd.click();
    const card = cardNamed(page, name);
    await card.getByRole('button', { name: `One more ${name}` }).click();

    // Cart page shows 2; change it to 3 there.
    await page.goto('/cart');
    const row = page.locator('.checkout-cart__row', { hasText: name }).first();
    await expect(row.locator('.checkout-cart__step-count')).toHaveText('2');
    await page.getByRole('button', { name: `Increase quantity of ${name}` }).click();
    await expect(row.locator('.checkout-cart__step-count')).toHaveText('3');

    await page.goto('/');
    await expect(cardNamed(page, name).getByTestId('card-stepper-qty')).toHaveText('3');

    // Add 2 more on the product page → the card shows 5.
    await cardNamed(page, name).locator('.product-card__image-wrap').click();
    await expect(page.getByTestId('add-to-cart')).toBeVisible();
    await expect(page.getByTestId('header-cart-badge')).toHaveText('3');
    await page.getByRole('button', { name: 'Increase quantity' }).click();
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('header-cart-badge')).toHaveText('5');
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(cardNamed(page, name).getByTestId('card-stepper-qty')).toHaveText('5');
    await emptyCart(page);
  });

  test('the stock limit works on a card', async ({ page }) => {
    const product = await smallStockProduct();
    test.skip(product === null, 'No product with a small tracked stock count today.');
    const p = product as LiveProduct;
    const stock = p.stock_quantity as number;
    await openFresh(page, `/search?q=${encodeURIComponent(p.name)}`);
    const card = cardNamed(page, p.name);
    await expect(card).toBeVisible();
    await scrollElementTo(card, 120);
    await card.locator('.cart-button').click();
    const plus = card.getByRole('button', { name: `One more ${p.name}` });
    for (let i = 1; i < stock + 2; i++) await plus.click();
    await expect(card.getByTestId('card-stepper-qty')).toHaveText(String(stock));
    await expect(page.locator('.toast', { hasText: `Only ${stock} in stock` }).first()).toBeVisible();
    expect(await cartUnits(page)).toBe(stock);
    await emptyCart(page);
  });

  test('a product with options opens the picker; after adding, the card shows that option\'s quantity', async ({ page }) => {
    const name = await seedOption(page);
    await openFresh(page, '/');
    const options = page.getByRole('button', { name: `Choose options for ${name}` });
    await expect(options).toBeVisible();
    await scrollElementTo(options, 160);
    await options.click();
    const sheet = page.getByRole('dialog', { name: 'Choose options' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Add to Cart' }).click();
    await expect(sheet).toBeHidden();
    const card = cardNamed(page, name);
    await expect(card.getByTestId('card-stepper-qty')).toHaveText('1');
    await card.getByRole('button', { name: `One more ${name}` }).click();
    await expect(card.getByTestId('card-stepper-qty')).toHaveText('2');
    const lines = await page.evaluate(() => (JSON.parse(localStorage.getItem('nph_cart') ?? '[]') as unknown[]).length);
    expect(lines).toBe(1);
    await emptyCart(page);
  });
});

// ---------------------------------------------------------------------------
// PART 4 — You may also like
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string; name: string; slug: string };

/** Serves the real catalogue with a few products rewritten into a known
 *  arrangement, so the order rules can be checked exactly. */
async function seedCatalogue(page: Page): Promise<{ current: Row; expected: string[]; excluded: string[] }> {
  const live = await select<Row[]>(null, 'products_view?select=*,category:categories(id,name,slug)&is_active=eq.true&order=name.asc');
  const variants = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id');
  const withOptions = new Set((variants.data ?? []).map((v) => v.product_id));
  const rows = (live.data ?? []).filter((r) => !withOptions.has(r.id));
  expect(rows.length).toBeGreaterThan(10);
  const [current, sameBoth1, sameBoth2, sameCat, outOfStock, hidden, sameBrand] = rows;

  const base = { offer_price: null, stock_status: 'in_stock', stock_quantity: null, is_active: true };
  const seeded = new Map<string, Partial<Row>>([
    [current.id, { ...base, category_id: 'seed-cat', brand_id: 'seed-brand', brand: 'Seed', retail_price: 1000 }],
    [sameBoth1.id, { ...base, category_id: 'seed-cat', brand_id: 'seed-brand', brand: 'Seed', retail_price: 1300 }],
    [sameBoth2.id, { ...base, category_id: 'seed-cat', brand_id: 'seed-brand', brand: 'Seed', retail_price: 1050 }],
    [sameCat.id, { ...base, category_id: 'seed-cat', brand_id: 'other-brand', brand: 'Other', retail_price: 990 }],
    [outOfStock.id, { ...base, category_id: 'seed-cat', brand_id: 'seed-brand', brand: 'Seed', stock_quantity: 0 }],
    [hidden.id, { ...base, category_id: 'seed-cat', brand_id: 'seed-brand', brand: 'Seed', is_active: false }],
    [sameBrand.id, { ...base, category_id: 'seed-other', brand_id: 'seed-brand', brand: 'Seed', retail_price: 1000 }],
  ]);

  await page.route(/\/rest\/v1\/products_view\?/, async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Row[] | Row;
    if (!Array.isArray(body)) {
      await route.fulfill({ response });
      return;
    }
    const patched = body.map((r) =>
      seeded.has(r.id)
        ? { ...r, ...seeded.get(r.id) }
        : { ...r, category_id: null, brand_id: null, brand: null, created_at: '2000-01-01T00:00:00Z' }
    );
    await route.fulfill({ response, json: patched });
  });

  return {
    current,
    expected: [sameBoth2.name, sameBoth1.name, sameCat.name, sameBrand.name],
    excluded: [current.name, outOfStock.name, hidden.name],
  };
}

test.describe('Part 4 — You may also like', () => {
  test('follows the order rules and excludes the current, hidden and out-of-stock products', async ({ page }) => {
    const seed = await seedCatalogue(page);
    await page.goto(`/product/${seed.current.slug}`);
    const row = page.getByTestId('related-products');
    await expect(row).toBeVisible();
    await expect(row.getByRole('heading', { name: 'You may also like' })).toBeVisible();
    const names = await row.locator('.product-card__name').allInnerTexts();
    expect(names.map((n) => n.trim())).toEqual(seed.expected);
    for (const name of seed.excluded) expect(names).not.toContain(name);
    // Part 3 rules on these cards: no brand line, neutral cart button.
    await expect(row.locator('.product-card__brand')).toHaveCount(0);
    await expect(row.locator('.cart-button').first()).toBeVisible();
  });

  test('tapping a card opens it; Back (phone and ←) returns to the previous product at the same scroll position', async ({ page }) => {
    for (const kind of ['phone', 'in-app'] as const) {
      await page.goto('/');
      await expect(page.locator('.product-card').first()).toBeVisible();
      await page.goto('/product/aveeno-baby-daily-moisture-lightly-scented-wash-shampoo-236ml');
      const row = page.getByTestId('related-products');
      await expect(row).toBeVisible();
      await scrollElementTo(row, 200);
      const y = await page.evaluate(() => window.scrollY);
      const firstUrl = page.url();
      const target = row.locator('.product-card').first();
      const targetName = (await target.locator('.product-card__name').textContent())?.trim() ?? '';
      await target.locator('.product-card__image-wrap').click();
      await expect(page).not.toHaveURL(firstUrl);
      await expect(page.locator('.product-detail__name')).toHaveText(targetName);
      await page.waitForTimeout(500);
      if (kind === 'phone') await page.goBack();
      else await page.getByRole('button', { name: 'Go back' }).click();
      await expect(page).toHaveURL(firstUrl);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y - 3);
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - y)).toBeLessThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// PART 5 — card titles
// ---------------------------------------------------------------------------

test.describe('Part 5 — card titles use the full card width', () => {
  for (const width of [360, 390, 412]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${width}px ${theme}: title box = card content width, first line filled before wrapping`, async ({ page }) => {
        await page.setViewportSize({ width, height: 840 });
        await page.goto('/');
        await page.evaluate((t) => localStorage.setItem('theme', t), theme);
        await page.goto('/search?q=aveeno');
        await expect(page.locator('.product-card').first()).toBeVisible();
        const results = await page.evaluate(() => {
          const out: { name: string; titleW: number; innerW: number; twoLines: boolean; firstLineFull: boolean }[] = [];
          for (const card of Array.from(document.querySelectorAll('.product-card')).slice(0, 12)) {
            const title = card.querySelector('.product-card__name') as HTMLElement;
            const body = card.querySelector('.product-card__body') as HTMLElement;
            const cs = getComputedStyle(body);
            const innerW = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
            const titleW = title.getBoundingClientRect().width;
            const text = title.firstChild as Text;
            const words: { start: number; end: number }[] = [];
            const re = /\S+/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text.data))) words.push({ start: m.index, end: m.index + m[0].length });
            const range = document.createRange();
            const rectOf = (s: number, e: number) => {
              range.setStart(text, s);
              range.setEnd(text, e);
              return range.getBoundingClientRect();
            };
            const firstTop = rectOf(words[0].start, words[0].end).top;
            const secondLineWord = words.find((w) => rectOf(w.start, w.end).top > firstTop + 2);
            let firstLineFull = true;
            if (secondLineWord) {
              const prev = words[words.indexOf(secondLineWord) - 1];
              const line1 = rectOf(words[0].start, prev.end);
              const nextWord = rectOf(secondLineWord.start, secondLineWord.end);
              // The width of a normal space (the one at the break collapses).
              const space = words.length > 1 ? rectOf(words[0].end, words[1].start).width : 0;
              const titleLeft = title.getBoundingClientRect().left;
              // The next word really would not have fitted on line 1.
              firstLineFull = line1.right - titleLeft + space + nextWord.width > titleW - 0.5;
            }
            out.push({ name: text.data, titleW, innerW, twoLines: Boolean(secondLineWord), firstLineFull });
          }
          return out;
        });
        expect(results.length).toBeGreaterThan(3);
        for (const r of results) {
          expect(Math.abs(r.titleW - r.innerW), `${r.name}: title ${r.titleW} vs content ${r.innerW}`).toBeLessThanOrEqual(1);
          expect(r.firstLineFull, `${r.name}: first line not filled`).toBe(true);
        }
        // Every title box is exactly two lines tall, so prices line up.
        const heights = await page.locator('.product-card__name').evaluateAll((els) =>
          els.slice(0, 12).map((el) => Math.round(el.getBoundingClientRect().height))
        );
        expect(new Set(heights).size).toBe(1);
        await page.evaluate(() => localStorage.removeItem('theme'));
      });
    }
  }
});
