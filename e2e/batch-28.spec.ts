import { PNG } from 'pngjs';
import type { Locator, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { select } from './helpers/api';

// The site's service worker fetches Supabase data and photos itself, and
// page.route can't see requests a service worker makes — so whether the
// pretend option / test photos were used depended on how fast the worker
// took over the page (a flaky race). Off for this file; nothing here tests
// the offline worker.
test.use({ serviceWorkers: 'block' });

/**
 * Covers reports/batch-28.txt — product page remaster: crystal glass header
 * buttons, rounded info sheet, glass buy bar (the only place to buy) and its
 * scroll behaviour, the floating cart on every shop page, cart page stock
 * limit.
 */

const PDP = '/product/cerave-hydrating-cleanser';

interface LiveProduct {
  id: string;
  slug: string;
  name: string;
  stock_quantity: number | null;
}

/** A live product without options whose stock is tracked and small (2–9). */
async function smallStockProduct(): Promise<LiveProduct | null> {
  const res = await select<LiveProduct[]>(
    null,
    'products_view?select=id,slug,name,stock_quantity&is_active=eq.true&stock_quantity=gte.2&stock_quantity=lte.9&order=stock_quantity.asc'
  );
  const variants = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id');
  const withOptions = new Set((variants.data ?? []).map((v) => v.product_id));
  return (res.data ?? []).find((p) => !withOptions.has(p.id)) ?? null;
}

async function emptyCart(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
}

async function cartLines(page: Page): Promise<{ productId: string; variantId: string | null; quantity: number }[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('nph_cart') ?? '[]'));
}

async function cartUnits(page: Page): Promise<number> {
  return (await cartLines(page)).reduce((sum, line) => sum + line.quantity, 0);
}

async function openFresh(page: Page, path: string, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.goto('/');
  await page.evaluate((t) => {
    localStorage.setItem('nph_cart', '[]');
    localStorage.setItem('theme', t);
  }, theme);
  await page.goto(path);
}

async function box(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox();
  expect(b).not.toBeNull();
  return b as { x: number; y: number; width: number; height: number };
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** A plain one-colour PNG, served instead of every product photo. */
function solidPng(r: number, g: number, b: number): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function usePhotoColour(page: Page, rgb: [number, number, number]): Promise<void> {
  const body = solidPng(...rgb);
  await page.route(/\/storage\/v1\/object\/public\/product-images\//, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body })
  );
}


/** Waits until the first photo has really loaded and decoded (so pixel
 *  checks measure the photo, not the empty frame behind it). */
async function photoPainted(page: Page): Promise<void> {
  await page
    .locator('.product-detail__image')
    .first()
    .evaluate(async (img) => {
      const image = img as HTMLImageElement;
      if (!image.complete) await new Promise((resolve) => image.addEventListener('load', resolve, { once: true }));
      await image.decode();
    });
  await page.waitForTimeout(300);
}
function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The brand-orange zone: same rule as the Batch 27 "no orange" test. */
function isOrange(r: number, g: number, b: number): boolean {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === R) h = 60 * (((G - B) / d) % 6);
  else if (max === G) h = 60 * ((B - R) / d + 2);
  else h = 60 * ((R - G) / d + 4);
  if (h < 0) h += 360;
  return h >= 10 && h <= 40 && s > 0.5 && l > 0.35 && l < 0.75;
}

/** Contrast (WCAG ratio) between the icon (brightest pixels) and the
 *  button's own glass around it (the median pixel of the button). */
async function iconContrast(page: Page, button: Locator): Promise<number> {
  const b = await box(button);
  const shot = PNG.sync.read(await page.screenshot({ clip: b }));
  const lums: number[] = [];
  const cx = shot.width / 2;
  const cy = shot.height / 2;
  const radius = Math.min(cx, cy) - 3;
  for (let y = 0; y < shot.height; y++) {
    for (let x = 0; x < shot.width; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
      const i = (y * shot.width + x) * 4;
      lums.push(luminance(shot.data[i], shot.data[i + 1], shot.data[i + 2]));
    }
  }
  lums.sort((p, q) => p - q);
  const median = lums[Math.floor(lums.length / 2)];
  const icon = lums[Math.floor(lums.length * 0.995)];
  return (icon + 0.05) / (median + 0.05);
}

/** Gives one live in-stock product a test option, in this page only (the
 *  database is untouched) — the live catalogue has no products with options
 *  today, and these tests must not depend on that. */
async function seedOption(page: Page): Promise<{ id: string; slug: string; name: string; retail: number }> {
  const live = await select<{ id: string; slug: string; name: string; retail_price: number }[]>(
    null,
    'products_view?select=id,slug,name,retail_price&is_active=eq.true&stock_status=eq.in_stock&stock_quantity=is.null&order=name.asc&limit=1'
  );
  const target = live.data?.[0];
  expect(target).toBeTruthy();
  const t = target as { id: string; slug: string; name: string; retail_price: number };
  await page.route(/\/rest\/v1\/product_variants_view\?/, async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as unknown[];
    const option = {
      id: '00000000-0000-4000-8000-00000000b028',
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
  return { id: t.id, slug: t.slug, name: t.name, retail: t.retail_price + 100 };
}

async function scrollToSolidHeader(page: Page): Promise<void> {
  // Just past the point where the photo goes under the bar: the bar turns
  // solid while the photo's last pixels are still right behind it.
  await page.evaluate(() => {
    const gallery = document.querySelector('.product-detail__gallery') as HTMLElement;
    const bottom = gallery.getBoundingClientRect().bottom + window.scrollY;
    window.scrollTo({ top: bottom - 56 + 6, behavior: 'instant' });
  });
  await expect(page.getByTestId('pdp-header')).toHaveClass(/pdp-header--solid/);
  await page.waitForTimeout(450);
}

// ---------------------------------------------------------------------------
// PART 1 — header
// ---------------------------------------------------------------------------

test.describe('Part 1 — crystal glass header', () => {
  test('only ← and Share; no cart button in the header', async ({ page }) => {
    await openFresh(page, PDP);
    await page.evaluate(() =>
      localStorage.setItem(
        'nph_cart',
        JSON.stringify([{ productId: 'x-test-1', variantId: null, variantLabel: null, quantity: 1, priceAtAdd: 100 }])
      )
    );
    await page.reload();
    const header = page.getByTestId('pdp-header');
    await expect(header.getByRole('button', { name: 'Go back' })).toBeVisible();
    await expect(header.getByRole('button', { name: /^Share / })).toBeVisible();
    await expect(header.getByRole('button')).toHaveCount(2);
    await expect(header.getByTestId('header-cart')).toHaveCount(0);
    await expect(header.getByRole('button', { name: /cart/i })).toHaveCount(0);
    await emptyCart(page);
  });

  test('crystal glass: low-alpha background and a backdrop blur', async ({ page }) => {
    await openFresh(page, PDP);
    for (const name of ['Go back', /^Share /] as const) {
      const style = await page
        .getByTestId('pdp-header')
        .getByRole('button', { name })
        .evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, blur: s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter') };
        });
      const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(style.bg)?.[1] ?? '1');
      expect(alpha, style.bg).toBeLessThanOrEqual(0.3);
      expect(style.blur).toContain('blur(12px)');
    }
  });

  for (const [label, rgb, min] of [
    ['a white photo', [255, 255, 255], 1.9],
    ['a very light photo', [244, 242, 238], 2.0],
    ['a dark photo', [20, 20, 22], 4.5],
  ] as const) {
    test(`icons stay visible on ${label}`, async ({ page }) => {
      await usePhotoColour(page, [...rgb]);
      await openFresh(page, PDP);
      await expect(page.locator('.product-detail__image').first()).toBeVisible();
      await photoPainted(page);
      await page.waitForTimeout(500);
      const header = page.getByTestId('pdp-header');
      for (const name of ['Go back', /^Share /] as const) {
        const contrast = await iconContrast(page, header.getByRole('button', { name }));
        expect(contrast, `${label}: ${String(name)}`).toBeGreaterThanOrEqual(min);
      }
    });
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`no orange in the scrolled top bar (${theme}), even over an orange photo`, async ({ page }) => {
      await usePhotoColour(page, [255, 122, 69]);
      await openFresh(page, PDP, theme);
      await expect(page.locator('.product-detail__image').first()).toBeVisible();
      await photoPainted(page);
      await scrollToSolidHeader(page);
      const vw = page.viewportSize()?.width ?? 390;
      const shot = PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 0, width: vw, height: 56 } }));
      let orange = 0;
      for (let i = 0; i < shot.data.length; i += 4) {
        if (isOrange(shot.data[i], shot.data[i + 1], shot.data[i + 2])) orange++;
      }
      expect(orange).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// PART 2 — sheet
// ---------------------------------------------------------------------------

test.describe('Part 2 — rounded info sheet', () => {
  test('rounded top corners, overlaps the photo by 20–24 px, notch present', async ({ page }) => {
    await openFresh(page, PDP);
    const sheet = page.getByTestId('pdp-sheet');
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(800);
    const radius = await sheet.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    expect(radius).toBeGreaterThanOrEqual(24);
    expect(radius).toBeLessThanOrEqual(28);
    const right = await sheet.evaluate((el) => parseFloat(getComputedStyle(el).borderTopRightRadius));
    expect(right).toBe(radius);
    const gallery = await box(page.locator('.product-detail__gallery'));
    const s = await box(sheet);
    const overlap = gallery.y + gallery.height - s.y;
    expect(overlap).toBeGreaterThanOrEqual(20);
    expect(overlap).toBeLessThanOrEqual(24.5);
    // Edge to edge, so the rounded corners show the photo behind them.
    expect(Math.abs(s.width - (page.viewportSize()?.width ?? 0))).toBeLessThanOrEqual(1);
    const notch = page.getByTestId('pdp-sheet-notch');
    await expect(notch).toBeVisible();
    const n = await box(notch);
    expect(Math.abs(n.x + n.width / 2 - (s.x + s.width / 2))).toBeLessThanOrEqual(1);
    expect(n.y - s.y).toBeLessThanOrEqual(16);
  });

  test('no gradient anywhere over the photo', async ({ page }) => {
    await openFresh(page, PDP);
    await expect(page.locator('.product-detail__image').first()).toBeVisible();
    await photoPainted(page);
    await page.waitForTimeout(600);
    const found = await page.evaluate(() => {
      const g = (document.querySelector('.product-detail__gallery') as HTMLElement).getBoundingClientRect();
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right <= g.left || r.left >= g.right || r.bottom <= g.top || r.top >= g.bottom) continue;
        for (const pseudo of [null, '::before', '::after']) {
          const bg = getComputedStyle(el, pseudo).backgroundImage;
          if (bg && bg.includes('gradient')) out.push(`${el.tagName}.${el.className}${pseudo ?? ''}: ${bg}`);
        }
      }
      return out;
    });
    expect(found).toEqual([]);
  });

  test('order: brand → name → price → chips → (options) → trust plate; one plate with 3 items; no Add to Cart in the page', async ({ page }) => {
    await openFresh(page, PDP);
    await expect(page.getByTestId('trust-plate')).toBeVisible();
    const parts = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.pdp-sheet [data-sheet-part]')).map((el) => ({
        part: el.dataset.sheetPart,
        top: el.getBoundingClientRect().top,
      }))
    );
    expect(parts.map((p) => p.part)).toEqual(['brand', 'name', 'price', 'chips', 'trust']);
    for (let i = 1; i < parts.length; i++) expect(parts[i].top).toBeGreaterThan(parts[i - 1].top);

    // The price row: big price, struck-through old price and a soft pill.
    const price = page.locator('.pdp-sheet [data-sheet-part="price"]');
    await expect(price.locator('.product-detail__price')).toBeVisible();
    const save = price.locator('.pdp-save');
    if ((await save.count()) > 0) {
      const bg = await save.evaluate((el) => getComputedStyle(el).backgroundColor);
      const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(bg)?.[1] ?? '1');
      expect(alpha, bg).toBeLessThan(0.3);
    }
    await expect(page.getByTestId('stock-chip')).toHaveText(/In stock|Out of stock/);

    // Trust plate: one element, three items, texts from Site texts.
    const plate = page.getByTestId('trust-plate');
    await expect(plate).toHaveCount(1);
    await expect(plate.locator('li')).toHaveCount(3);
    await expect(page.locator('.trust-box')).toHaveCount(0);

    // No buying controls inside the page — only in the buy bar.
    const main = page.locator('.pdp-main');
    await expect(main.getByText('Add to Cart', { exact: true })).toHaveCount(0);
    await expect(main.getByTestId('add-to-cart')).toHaveCount(0);
    await expect(main.getByRole('button', { name: /^Add CeraVe Hydrating Cleanser to cart$/ })).toHaveCount(0);
    await expect(page.getByTestId('qty-value')).toHaveCount(0);
    await expect(page.getByTestId('sticky-bar')).toHaveCount(0);
  });

  test('options sit between the chips and the trust plate (with 2+ options)', async ({ page }) => {
    const seeded = await seedOption(page);
    await openFresh(page, `/product/${seeded.slug}`);
    await expect(page.locator('.pdp-sheet [data-sheet-part="options"]')).toBeVisible();
    const parts = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.pdp-sheet [data-sheet-part]')).map((el) => el.dataset.sheetPart)
    );
    expect(parts.slice(-3)).toEqual(['chips', 'options', 'trust']);
  });
});

// ---------------------------------------------------------------------------
// PART 3 — buy bar
// ---------------------------------------------------------------------------

test.describe('Part 3 — glass buy bar', () => {
  test('visible on load, real glass, only the price on the left', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      await openFresh(page, PDP, theme);
      const bar = page.getByTestId('buy-bar');
      await expect(bar).toBeVisible();
      await expect(bar).toHaveAttribute('data-shown', 'true');
      const style = await bar.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, blur: s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter') };
      });
      expect(style.blur).toContain('blur(22px)');
      const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(style.bg)?.[1] ?? '1');
      expect(alpha, style.bg).toBeLessThan(0.7);

      // Left: only the price. No thumbnail, no label.
      await expect(bar.locator('img')).toHaveCount(0);
      await expect(page.getByTestId('buy-bar-price')).toHaveText(
        (await page.locator('.pdp-sheet .product-detail__price').textContent()) ?? ''
      );
      const text = ((await bar.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      const priceText = ((await page.getByTestId('buy-bar-price').textContent()) ?? '').trim();
      expect(text).toBe(`${priceText}Add to Cart`.replace(/\s+/g, ' '));

      // Floats 12 px from the sides, ~14 px above the bottom, 64–68 px tall.
      const b = await box(bar);
      const vw = page.viewportSize()?.width ?? 0;
      const vh = page.viewportSize()?.height ?? 0;
      expect(Math.abs(b.x - 12)).toBeLessThanOrEqual(1);
      expect(Math.abs(vw - (b.x + b.width) - 12)).toBeLessThanOrEqual(1);
      expect(Math.abs(vh - (b.y + b.height) - 14)).toBeLessThanOrEqual(1);
      expect(b.height).toBeGreaterThanOrEqual(64);
      expect(b.height).toBeLessThanOrEqual(68);
    }
    await page.evaluate(() => localStorage.removeItem('theme'));
  });

  test('add → stepper (same box); + up to stock; − to 0 brings Add to Cart back', async ({ page }) => {
    const product = await smallStockProduct();
    test.skip(product === null, 'No product with a small tracked stock count today.');
    const p = product as LiveProduct;
    const stock = p.stock_quantity as number;
    await openFresh(page, `/product/${p.slug}`);

    const add = page.getByTestId('add-to-cart');
    await expect(add).toBeVisible();
    await expect(add).toHaveCSS('background-color', 'rgb(255, 122, 69)');
    const before = await box(add);
    await add.click();
    const stepper = page.getByTestId('buy-bar-stepper');
    await expect(stepper).toBeVisible();
    // Measured once its short pop-in (scale) has finished.
    await stepper.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const after = await box(stepper);
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(1);
    // Not orange: a dark pill in light mode.
    expect(await stepper.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 122, 69)');

    const qty = page.getByTestId('buy-bar-qty');
    await expect(qty).toHaveText('1');
    expect(await cartUnits(page)).toBe(1);
    for (let i = 1; i < stock + 2; i++) await page.getByTestId('buy-bar-plus').click();
    await expect(qty).toHaveText(String(stock));
    await expect(page.locator('.toast', { hasText: `Only ${stock} in stock` }).first()).toBeVisible();
    expect(await cartUnits(page)).toBe(stock);

    for (let i = stock; i > 0; i--) await page.getByTestId('buy-bar-minus').click();
    await expect(page.getByTestId('add-to-cart')).toBeVisible();
    await expect(page.getByTestId('buy-bar-stepper')).toHaveCount(0);
    expect(await cartUnits(page)).toBe(0);
    const back = await box(page.getByTestId('add-to-cart'));
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(back[k] - before[k])).toBeLessThanOrEqual(1);
  });

  test('stays after a reload, never flips back by itself, and matches the cart page and the cards', async ({ page }) => {
    test.setTimeout(60_000);
    await openFresh(page, PDP);
    await page.getByTestId('add-to-cart').click();
    await page.getByTestId('buy-bar-plus').click();
    await expect(page.getByTestId('buy-bar-qty')).toHaveText('2');
    await page.waitForTimeout(4000);
    await expect(page.getByTestId('buy-bar-qty')).toHaveText('2');
    await expect(page.getByTestId('add-to-cart')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('buy-bar-qty')).toHaveText('2');
    await expect(page.getByTestId('glass-cart-badge')).toHaveText('2');

    await page.goto('/cart');
    const row = page.locator('.checkout-cart__row', { hasText: 'CeraVe Hydrating Cleanser' }).first();
    await expect(row.locator('.checkout-cart__step-count')).toHaveText('2');
    await page.getByRole('button', { name: 'Increase quantity of CeraVe Hydrating Cleanser' }).click();
    await expect(row.locator('.checkout-cart__step-count')).toHaveText('3');

    await page.goto('/search?q=CeraVe%20Hydrating%20Cleanser');
    const card = page.locator('.product-card', {
      has: page.locator('.product-card__name', { hasText: /^CeraVe Hydrating Cleanser$/ }),
    }).first();
    await expect(card.getByTestId('card-stepper-qty')).toHaveText('3');
    await expect(page.getByTestId('glass-cart-badge')).toHaveText('3');

    await page.goto(PDP);
    await expect(page.getByTestId('buy-bar-qty')).toHaveText('3');
    await emptyCart(page);
  });

  test('out of stock: a disabled grey pill', async ({ page }) => {
    const res = await select<{ slug: string }[]>(
      null,
      'products_view?select=slug&is_active=eq.true&or=(stock_quantity.eq.0,stock_status.eq.out_of_stock)&limit=1'
    );
    const slug = res.data?.[0]?.slug;
    test.skip(!slug, 'No out-of-stock product today.');
    await openFresh(page, `/product/${slug}`);
    const out = page.getByTestId('buy-bar-out');
    await expect(out).toBeVisible();
    await expect(out).toBeDisabled();
    await expect(out).toHaveText('Out of stock');
    expect(await out.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 122, 69)');
    await expect(page.getByTestId('add-to-cart')).toHaveCount(0);
  });

  test('options: the bar shows the selected option\'s price and its own cart quantity', async ({ page }) => {
    const seeded = await seedOption(page);
    await openFresh(page, `/product/${seeded.slug}`);
    const price = page.getByTestId('buy-bar-price');
    await expect(page.locator('.pdp-sheet [data-sheet-part="options"]')).toBeVisible();
    const basePrice = ((await price.textContent()) ?? '').trim();

    // Pick the seeded option (by region + size chips, or the one flat chip).
    const region = page.locator('.pdp-sheet .chip-select', { hasText: /^Test region$/ });
    if ((await region.count()) > 0) await region.click();
    await page.locator('.pdp-sheet .chip-select', { hasText: '999ml' }).first().click();
    await expect(price).not.toHaveText(basePrice);
    await expect(price).toHaveText(await page.locator('.pdp-sheet .product-detail__price').textContent() ?? '');

    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('buy-bar-qty')).toHaveText('1');
    const lines = await cartLines(page);
    expect(lines).toEqual([expect.objectContaining({ productId: seeded.id, variantId: '00000000-0000-4000-8000-00000000b028', quantity: 1 })]);

    // Back to the other option: not in the cart → Add to Cart, base price.
    const chips = page.locator('.pdp-sheet .chip-select:not(.chip-select--on)');
    await chips.first().click();
    await expect(page.getByTestId('add-to-cart')).toBeVisible();
    await expect(price).toHaveText(basePrice);
    await emptyCart(page);
  });
});

// ---------------------------------------------------------------------------
// PART 4 — scroll behaviour
// ---------------------------------------------------------------------------

test.describe('Part 4 — buy bar scroll behaviour', () => {
  test('down hides, up shows, bottom shows, a cart change shows; never covers the last content', async ({ page }) => {
    await openFresh(page, PDP);
    const bar = page.getByTestId('buy-bar');
    await expect(bar).toHaveAttribute('data-shown', 'true');
    await expect(page.getByTestId('related-products')).toBeVisible();

    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'instant' }));
    await page.waitForTimeout(120);
    await expect(bar).toHaveAttribute('data-shown', 'false');
    await expect(bar).toHaveCSS('opacity', '0');

    // Tiny jitter does nothing.
    await page.evaluate(() => window.scrollBy({ top: -4, behavior: 'instant' }));
    await page.waitForTimeout(120);
    await page.waitForTimeout(100);
    await expect(bar).toHaveAttribute('data-shown', 'false');

    await page.evaluate(() => window.scrollBy({ top: -20, behavior: 'instant' }));
    await page.waitForTimeout(120);
    await expect(bar).toHaveAttribute('data-shown', 'true');
    await expect(bar).toHaveCSS('opacity', '1');

    // Hidden again, then a cart change (a "You may also like" card) brings it back.
    await page.evaluate(() => window.scrollBy({ top: 60, behavior: 'instant' }));
    await page.waitForTimeout(120);
    await expect(bar).toHaveAttribute('data-shown', 'false');
    await page
      .getByTestId('related-products')
      .getByRole('button', { name: /^Add .* to cart$/ })
      .first()
      .dispatchEvent('click');
    await expect(bar).toHaveAttribute('data-shown', 'true');

    // The very bottom: shown, and the last content ends above it.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(120);
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'instant' }));
    await page.waitForTimeout(120);
    await expect(bar).toHaveAttribute('data-shown', 'false');
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    await page.waitForTimeout(120);
    await expect(bar).toHaveAttribute('data-shown', 'true');
    await page.waitForTimeout(400);
    const related = await box(page.getByTestId('related-products'));
    const b = await box(bar);
    expect(related.y + related.height).toBeLessThanOrEqual(b.y);
    await emptyCart(page);
  });

  test('top of the page: shown', async ({ page }) => {
    await openFresh(page, PDP);
    const bar = page.getByTestId('buy-bar');
    await expect(page.getByTestId('related-products')).toBeVisible();
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'instant' }));
    await page.waitForTimeout(120);
    await expect(bar).toHaveAttribute('data-shown', 'false');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(120);
    await expect(bar).toHaveAttribute('data-shown', 'true');
  });
});

// ---------------------------------------------------------------------------
// PART 5 — floating cart
// ---------------------------------------------------------------------------

test.describe('Part 5 — one floating cart', () => {
  test('product page: hidden when empty, appears after the first add, counts and pulses, opens the cart', async ({ page }) => {
    await openFresh(page, PDP);
    const glass = page.getByTestId('glass-cart');
    await expect(page.getByTestId('add-to-cart')).toBeVisible();
    await expect(glass).toHaveCount(0);

    await page.getByTestId('add-to-cart').click();
    await expect(glass).toBeVisible();
    await expect(glass.getByTestId('glass-cart-badge')).toHaveText('1');
    await expect(glass.locator('.glass-cart__inner')).toHaveClass(/cart-bump--enter/);

    await page.getByTestId('buy-bar-plus').click();
    await expect(glass.getByTestId('glass-cart-badge')).toHaveText('2');
    await expect(glass.locator('.glass-cart__inner')).toHaveClass(/cart-bump--pulse/);
    // A remove pulses too (on the product page).
    await page.getByTestId('buy-bar-minus').click();
    await expect(glass.getByTestId('glass-cart-badge')).toHaveText('1');
    await expect(glass.locator('.glass-cart__inner')).toHaveClass(/cart-bump--pulse/);

    // Crystal glass, smaller on this page.
    const style = await glass.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, blur: s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter') };
    });
    expect(style.blur).toContain('blur(');
    const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(style.bg)?.[1] ?? '1');
    expect(alpha).toBeLessThan(0.5);
    const b = await box(glass);
    expect(b.width).toBeGreaterThanOrEqual(50);
    expect(b.width).toBeLessThanOrEqual(54);

    await glass.click();
    await expect(page).toHaveURL(/\/cart$/);
    await emptyCart(page);
  });

  for (const size of [
    { width: 390, height: 844 },
    { width: 360, height: 640 },
  ]) {
    test(`never overlaps the buy bar or the top buttons (${size.width}×${size.height})`, async ({ page }) => {
      await page.setViewportSize(size);
      await openFresh(page, PDP);
      await page.getByTestId('add-to-cart').click();
      const glass = page.getByTestId('glass-cart');
      await expect(glass).toBeVisible();
      await page.waitForTimeout(600);
      const g = await box(glass);
      const bar = await box(page.getByTestId('buy-bar'));
      expect(overlaps(g, bar)).toBe(false);
      const header = page.getByTestId('pdp-header');
      for (const name of ['Go back', /^Share /] as const) {
        expect(overlaps(g, await box(header.getByRole('button', { name })))).toBe(false);
      }
      // Middle of the right edge.
      expect(Math.abs(g.y + g.height / 2 - size.height / 2)).toBeLessThanOrEqual(2);
      expect(size.width - (g.x + g.width)).toBeLessThanOrEqual(16);
      await emptyCart(page);
    });
  }

  test('Home: appears after the first add; absent on cart, checkout, account', async ({ page }) => {
    await openFresh(page, '/');
    const glass = page.getByTestId('glass-cart');
    const firstAdd = page.getByRole('button', { name: /^Add .* to cart$/ }).first();
    await expect(firstAdd).toBeVisible();
    await expect(glass).toHaveCount(0);
    await firstAdd.evaluate((el) => window.scrollBy({ top: el.getBoundingClientRect().top - 160, behavior: 'instant' }));
    await firstAdd.click();
    await expect(glass).toBeVisible();
    await expect(glass.getByTestId('glass-cart-badge')).toHaveText('1');
    for (const path of ['/cart', '/checkout/delivery', '/account']) {
      await page.goto(path);
      await page.waitForTimeout(500);
      if (new URL(page.url()).pathname !== path) continue;
      await expect(glass, path).toHaveCount(0);
    }
    await emptyCart(page);
  });
});

// ---------------------------------------------------------------------------
// PART 6 — cart page stock limit
// ---------------------------------------------------------------------------

test.describe('Part 6 — cart page', () => {
  test('+ stops at the stock count with "Only N in stock"', async ({ page }) => {
    const product = await smallStockProduct();
    test.skip(product === null, 'No product with a small tracked stock count today.');
    const p = product as LiveProduct;
    const stock = p.stock_quantity as number;
    await page.goto('/');
    await page.evaluate(
      ([id, qty]) =>
        localStorage.setItem(
          'nph_cart',
          JSON.stringify([{ productId: id, variantId: null, variantLabel: null, quantity: qty - 1, priceAtAdd: 100 }])
        ),
      [p.id, stock] as const
    );
    await page.goto('/cart');
    const row = page.locator('.checkout-cart__row', { hasText: p.name }).first();
    const count = row.locator('.checkout-cart__step-count');
    await expect(count).toHaveText(String(stock - 1));
    const plus = page.getByRole('button', { name: `Increase quantity of ${p.name}` });
    await plus.click();
    await expect(count).toHaveText(String(stock));
    await plus.click();
    await plus.click();
    await expect(count).toHaveText(String(stock));
    await expect(page.locator('.toast', { hasText: `Only ${stock} in stock` }).first()).toBeVisible();
    expect(await cartUnits(page)).toBe(stock);
    await emptyCart(page);
  });
});
