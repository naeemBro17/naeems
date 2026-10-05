import { PNG } from 'pngjs';
import type { Locator, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { select } from './helpers/api';

// The site's offline helper (service worker) fetches data and pictures by
// itself, out of reach of page.route — off for this file (as in Batch 27/28);
// nothing here tests offline mode.
test.use({ serviceWorkers: 'block' });

/**
 * Covers reports/batch-29.txt — crystal photo buttons, stock + note group,
 * floating cart above the buy bar, "Removed · Undo", brand logo clean-up,
 * brand video still picture, and the fast-Home loading rules. Nothing here
 * writes to the database: test pictures and pretend data exist only inside
 * the test browser, and the cart is the browser's own.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LiveProduct {
  id: string;
  slug: string;
  name: string;
  retail_price: number;
  offer_price: number | null;
  image_urls: string[] | null;
}

async function box(el: Locator): Promise<Box> {
  const b = await el.boundingBox();
  expect(b).not.toBeNull();
  return b as Box;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** A live, in-stock product with 2+ photos and no Region/Size label or
 *  options — so the counter pill shows and nothing sits between the note and
 *  the trust plate. */
async function multiPhotoProduct(): Promise<LiveProduct> {
  const res = await select<(LiveProduct & { region: string | null; size: string | null })[]>(
    null,
    'products_view?select=id,slug,name,retail_price,offer_price,image_urls,region,size&is_active=eq.true&stock_status=eq.in_stock&order=name.asc'
  );
  const variants = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id');
  const withOptions = new Set((variants.data ?? []).map((v) => v.product_id));
  const found = (res.data ?? []).find(
    (p) => (p.image_urls ?? []).length >= 2 && !p.region && !p.size && !withOptions.has(p.id)
  );
  expect(found, 'a live product with 2+ photos').toBeTruthy();
  return found as LiveProduct;
}

/** Any live in-stock product without options (for cart lines). */
async function plainProducts(count: number): Promise<LiveProduct[]> {
  const res = await select<LiveProduct[]>(
    null,
    'products_view?select=id,slug,name,retail_price,offer_price,image_urls&is_active=eq.true&stock_status=eq.in_stock&stock_quantity=is.null&order=name.asc'
  );
  const variants = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id');
  const withOptions = new Set((variants.data ?? []).map((v) => v.product_id));
  const list = (res.data ?? []).filter((p) => !withOptions.has(p.id)).slice(0, count);
  expect(list.length).toBe(count);
  return list;
}

interface CartLine {
  productId: string;
  variantId: string | null;
  variantLabel: string | null;
  quantity: number;
  priceAtAdd: number;
}

function lineFor(p: LiveProduct, quantity: number): CartLine {
  return { productId: p.id, variantId: null, variantLabel: null, quantity, priceAtAdd: p.offer_price ?? p.retail_price };
}

async function openWith(page: Page, path: string, opts: { theme?: 'light' | 'dark'; cart?: CartLine[] } = {}): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    ({ theme, cart }) => {
      localStorage.setItem('nph_cart', JSON.stringify(cart));
      localStorage.setItem('theme', theme);
    },
    { theme: opts.theme ?? 'light', cart: opts.cart ?? [] }
  );
  await page.goto(path);
}

async function cartLines(page: Page): Promise<CartLine[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('nph_cart') ?? '[]'));
}

/** Changes one product's note in every products_view answer (this page only). */
async function patchNote(page: Page, productId: string, note: string | null): Promise<void> {
  await page.route(/\/rest\/v1\/products_view\?/, async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as unknown;
    const patch = (row: { id?: string; note?: string | null }) => (row.id === productId ? { ...row, note } : row);
    const json = Array.isArray(body) ? body.map(patch) : patch(body as { id?: string });
    await route.fulfill({ response, json });
  });
}

function parseRgba(value: string): [number, number, number, number] {
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (!m) return [0, 0, 0, 0];
  const parts = m[1].split(',').map((s) => Number(s.trim()));
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

// ---------------------------------------------------------------------------
// PART 1 — pure crystal glass on the photo buttons
// ---------------------------------------------------------------------------

test.describe('Part 1 — crystal glass photo buttons', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`←, Share and the photo counter: white ≤ 15%, blur, border, no dark shadow (${theme})`, async ({ page }) => {
      const product = await multiPhotoProduct();
      await openWith(page, `/product/${product.slug}`, { theme });
      const header = page.getByTestId('pdp-header');
      await expect(page.getByTestId('image-counter')).toBeVisible({ timeout: 15_000 });
      // Over the photo (not the loading / scrolled bar), after the buttons'
      // 260 ms colour transition has finished.
      await expect(header).not.toHaveClass(/pdp-header--(plain|solid)/);
      await page.waitForTimeout(450);
      const targets = [
        header.getByRole('button', { name: 'Go back' }),
        header.getByRole('button', { name: /^Share / }),
        page.getByTestId('image-counter'),
      ];
      for (const target of targets) {
        const s = await target.evaluate((el) => {
          const cs = getComputedStyle(el);
          const icon = el.querySelector('svg');
          return {
            bg: cs.backgroundColor,
            blur: cs.backdropFilter || cs.getPropertyValue('-webkit-backdrop-filter'),
            borderWidth: cs.borderTopWidth,
            borderColor: cs.borderTopColor,
            shadow: cs.boxShadow,
            iconFilter: icon ? getComputedStyle(icon).filter : 'none',
          };
        });
        const [r, g, b, a] = parseRgba(s.bg);
        expect([r, g, b], s.bg).toEqual([255, 255, 255]);
        expect(a, s.bg).toBeLessThanOrEqual(0.15);
        expect(s.blur).toContain('blur(12px)');
        expect(parseFloat(s.borderWidth)).toBeGreaterThanOrEqual(1);
        const border = parseRgba(s.borderColor);
        expect(border.slice(0, 3)).toEqual([255, 255, 255]);
        // Only inset (inner highlight) shadows, and none of them dark.
        const shadows = s.shadow === 'none' ? [] : s.shadow.split(/,(?![^(]*\))/);
        for (const shadow of shadows) {
          expect(shadow, 'only an inner highlight').toContain('inset');
          const [sr, sg, sb] = parseRgba(shadow);
          expect(Math.min(sr, sg, sb), `no dark shadow: ${shadow}`).toBeGreaterThanOrEqual(200);
        }
        expect(s.iconFilter, 'no drop shadow on the icon').toBe('none');
      }
    });
  }
});

// ---------------------------------------------------------------------------
// PART 2 — stock capsule + note
// ---------------------------------------------------------------------------

test.describe('Part 2 — stock and note', () => {
  const NOTE = 'Packaging may vary slightly depending on the market of origin.';

  test('small capsule; note is a caption (no box) with an info icon; 18 / 8 / 24 px; shown once', async ({ page }) => {
    const product = await multiPhotoProduct();
    await patchNote(page, product.id, NOTE);
    await openWith(page, `/product/${product.slug}`);
    const chip = page.getByTestId('stock-chip');
    const note = page.getByTestId('product-note');
    await expect(note).toBeVisible({ timeout: 15_000 });

    const chipBox = await box(chip);
    expect(chipBox.height).toBeGreaterThanOrEqual(24);
    expect(chipBox.height).toBeLessThanOrEqual(28);

    const style = await note.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderTopWidth, bg: cs.backgroundColor, icon: el.querySelector('svg') !== null };
    });
    expect(parseFloat(style.border)).toBe(0);
    expect(parseRgba(style.bg)[3]).toBe(0);
    expect(style.icon).toBe(true);

    const priceBox = await box(page.locator('.pdp-sheet [data-sheet-part="price"]'));
    const noteBox = await box(note);
    const trustBox = await box(page.getByTestId('trust-plate'));
    expect(Math.abs(chipBox.y - (priceBox.y + priceBox.height) - 18)).toBeLessThanOrEqual(2);
    expect(Math.abs(noteBox.y - (chipBox.y + chipBox.height) - 8)).toBeLessThanOrEqual(2);
    expect(Math.abs(trustBox.y - (noteBox.y + noteBox.height) - 24)).toBeLessThanOrEqual(2);

    const occurrences = await page.evaluate((text) => document.body.innerText.split(text).length - 1, NOTE);
    expect(occurrences).toBe(1);
  });

  test('an empty note is hidden completely', async ({ page }) => {
    const product = await multiPhotoProduct();
    await patchNote(page, product.id, '');
    await openWith(page, `/product/${product.slug}`);
    await expect(page.getByTestId('stock-chip')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('product-note')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// PART 3 — floating cart above the buy bar
// ---------------------------------------------------------------------------

test.describe('Part 3 — floating cart on the product page', () => {
  test('bottom-right above the bar; moves down and back up with it; never overlaps', async ({ page }) => {
    const product = await multiPhotoProduct();
    await openWith(page, `/product/${product.slug}`);
    await page.getByTestId('add-to-cart').click();
    const glass = page.getByTestId('glass-cart');
    const bar = page.getByTestId('buy-bar');
    await expect(glass).toBeVisible();
    await page.waitForTimeout(500);

    const check = async () => {
      const g = await box(glass);
      const b = await box(bar);
      expect(Math.abs(g.x + g.width - (b.x + b.width))).toBeLessThanOrEqual(2);
      const gap = b.y - (g.y + g.height);
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(gap).toBeLessThanOrEqual(14);
      const header = page.getByTestId('pdp-header');
      for (const name of ['Go back', /^Share /] as const) {
        expect(overlaps(g, await box(header.getByRole('button', { name })))).toBe(false);
      }
      return g;
    };
    const shown = await check();

    // Scroll down: the bar slides away and the cart takes its place.
    await expect(page.getByTestId('related-products')).toBeVisible();
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'instant' }));
    await expect(bar).toHaveAttribute('data-shown', 'false');
    await page.waitForTimeout(500);
    const vh = page.viewportSize()?.height ?? 844;
    const away = await box(glass);
    expect(away.y).toBeGreaterThan(shown.y + 40);
    expect(away.y + away.height).toBeLessThanOrEqual(vh);
    expect(overlaps(away, await box(bar))).toBe(false);

    // Scroll up: both come back.
    await page.evaluate(() => window.scrollBy({ top: -40, behavior: 'instant' }));
    await expect(bar).toHaveAttribute('data-shown', 'true');
    await page.waitForTimeout(500);
    const back = await check();
    expect(Math.abs(back.y - shown.y)).toBeLessThanOrEqual(1);
  });

  for (const path of ['/', '/search', '/brand/aveeno']) {
    test(`unchanged elsewhere: middle-right on ${path}`, async ({ page }) => {
      const [p] = await plainProducts(1);
      await openWith(page, path, { cart: [lineFor(p, 1)] });
      const glass = page.getByTestId('glass-cart');
      await expect(glass).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);
      const g = await box(glass);
      const size = page.viewportSize() ?? { width: 412, height: 839 };
      expect(Math.abs(g.y + g.height / 2 - size.height / 2)).toBeLessThanOrEqual(2);
      expect(size.width - (g.x + g.width)).toBeLessThanOrEqual(16);
    });
  }
});

// ---------------------------------------------------------------------------
// PART 4 — remove at once + "Removed · Undo"
// ---------------------------------------------------------------------------

test.describe('Part 4 — Removed · Undo', () => {
  test('cart page: − at 1 removes with no dialog; Undo restores the same line in the same place', async ({ page }) => {
    const [a, b, c] = await plainProducts(3);
    const original = [lineFor(a, 2), lineFor(b, 1), lineFor(c, 3)];
    await openWith(page, '/cart', { cart: original });
    await page.getByRole('button', { name: `Decrease quantity of ${b.name}` }).click();

    await expect(page.getByText('Remove this item?')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const toast = page.getByTestId('undo-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Removed');
    await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
    expect((await cartLines(page)).map((l) => l.productId)).toEqual([a.id, c.id]);

    // Never covers the cart's total bar.
    expect(overlaps(await box(toast), await box(page.locator('.checkout-cart__sticky-bar')))).toBe(false);

    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(toast).toHaveCount(0);
    expect(await cartLines(page)).toEqual(original);
    await expect(page.getByRole('button', { name: `Decrease quantity of ${b.name}` })).toBeVisible();
  });

  test('product card: − at 1 removes; Undo brings the stepper, the badge and the floating cart back', async ({ page }) => {
    const [p] = await plainProducts(1);
    await openWith(page, '/search', { cart: [lineFor(p, 1)] });
    await page.locator('.search-bar__input, input[type="search"]').first().fill(p.name);
    const stepper = page.getByTestId('card-stepper').first();
    await expect(stepper).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: `Remove ${p.name} from cart` }).first().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('undo-toast')).toBeVisible();
    await expect(page.getByTestId('glass-cart')).toHaveCount(0);
    expect(await cartLines(page)).toEqual([]);

    await page.getByTestId('undo-toast').getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('card-stepper-qty').first()).toHaveText('1');
    await expect(page.getByTestId('glass-cart-badge')).toHaveText('1');
    expect(await cartLines(page)).toEqual([lineFor(p, 1)]);
  });

  test('buy bar: − at 1 removes; Undo restores the stepper; all counters agree', async ({ page }) => {
    const product = await multiPhotoProduct();
    await openWith(page, `/product/${product.slug}`, { cart: [lineFor(product, 1)] });
    await expect(page.getByTestId('buy-bar-qty')).toHaveText('1', { timeout: 15_000 });
    await page.getByTestId('buy-bar-minus').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const toast = page.getByTestId('undo-toast');
    await expect(toast).toBeVisible();
    await expect(page.getByTestId('add-to-cart')).toBeVisible();

    // Above the buy bar and the floating cart's spot.
    const t = await box(toast);
    const bar = await box(page.getByTestId('buy-bar'));
    expect(t.y + t.height).toBeLessThanOrEqual(bar.y - 52);

    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('buy-bar-qty')).toHaveText('1');
    await expect(page.getByTestId('glass-cart-badge')).toHaveText('1');
    expect(await cartLines(page)).toEqual([lineFor(product, 1)]);
    await page.goto('/cart');
    await expect(page.locator('.checkout-cart__step-count')).toHaveText('1');
  });

  test('the toast leaves after about 5 s; a new removal replaces the old toast', async ({ page }) => {
    const [a, b] = await plainProducts(2);
    await openWith(page, '/cart', { cart: [lineFor(a, 1), lineFor(b, 1)] });
    await page.getByRole('button', { name: `Decrease quantity of ${a.name}` }).click();
    await expect(page.getByTestId('undo-toast')).toBeVisible();
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: `Decrease quantity of ${b.name}` }).click();
    await expect(page.getByTestId('undo-toast')).toHaveCount(1);
    // Undo now restores only the latest removal.
    await page.getByTestId('undo-toast').getByRole('button', { name: 'Undo' }).click();
    expect(await cartLines(page)).toEqual([lineFor(b, 1)]);

    await page.getByRole('button', { name: `Decrease quantity of ${b.name}` }).click();
    await expect(page.getByTestId('undo-toast')).toBeVisible();
    await page.waitForTimeout(4300);
    await expect(page.getByTestId('undo-toast')).toBeVisible();
    await expect(page.getByTestId('undo-toast')).toHaveCount(0, { timeout: 2500 });
  });
});

// ---------------------------------------------------------------------------
// PART 5 — brand logos
// ---------------------------------------------------------------------------

/** A 240×120 logo: a solid backdrop with a 120×40 block in the middle. */
function logoPng(bg: [number, number, number], fg: [number, number, number]): Buffer {
  const png = new PNG({ width: 240, height: 120 });
  for (let y = 0; y < 120; y++) {
    for (let x = 0; x < 240; x++) {
      const i = (y * 240 + x) * 4;
      const inside = x >= 60 && x < 180 && y >= 40 && y < 80;
      const c = inside ? fg : bg;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const BLUE: [number, number, number] = [70, 140, 220];
const LOGOS: Record<string, { body: Buffer; cors: boolean }> = {
  'e2e-b29-white-bg.png': { body: logoPng([255, 255, 255], [20, 20, 20]), cors: true },
  'e2e-b29-black-bg.png': { body: logoPng([0, 0, 0], [255, 255, 255]), cors: true },
  'e2e-b29-blue-bg.png': { body: logoPng(BLUE, [255, 255, 255]), cors: true },
  'e2e-b29-no-cors.png': { body: logoPng([255, 255, 255], [20, 20, 20]), cors: false },
};

function logoUrl(name: string): string {
  return `https://afkgkpuppmwmkyrbheew.supabase.co/storage/v1/object/public/brand-media/logos/${name}`;
}

/** Serves the test logos and swaps them into the first three Home brands. */
async function useTestLogos(page: Page): Promise<string[]> {
  await page.goto('/');
  const row = page.locator('[data-testid="brand-row"] [data-brand-slug]');
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  const slugs = (await row.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.brandSlug ?? ''))).slice(0, 3);
  expect(slugs).toHaveLength(3);
  const plan: Record<string, { logo_url: string; logo_dark_url: string | null }> = {
    [slugs[0]]: { logo_url: logoUrl('e2e-b29-white-bg.png'), logo_dark_url: logoUrl('e2e-b29-black-bg.png') },
    [slugs[1]]: { logo_url: logoUrl('e2e-b29-blue-bg.png'), logo_dark_url: logoUrl('e2e-b29-black-bg.png') },
    [slugs[2]]: { logo_url: logoUrl('e2e-b29-no-cors.png'), logo_dark_url: null },
  };
  // A page route, not a context one: the suite's tracker-blocking page
  // route would otherwise answer first. It also covers the logo worker.
  await page.route(/\/storage\/v1\/object\/public\/brand-media\/logos\/e2e-b29-/, (route: Route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const logo = LOGOS[name];
    if (!logo) return route.fulfill({ status: 404, body: '' });
    // "Unreadable": the clean-up's own download fails (as it would without
    // CORS — the test tool adds CORS to every faked answer by itself), while
    // a plain <img> still gets the picture.
    if (!logo.cors && new URL(route.request().url()).searchParams.has('nph-logo')) return route.abort('failed');
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: logo.body,
      headers: logo.cors ? { 'access-control-allow-origin': '*' } : {},
    });
  });
  await page.route(/\/rest\/v1\/brands\?/, async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { slug: string }[];
    await route.fulfill({ response, json: body.map((b) => (plan[b.slug] ? { ...b, ...plan[b.slug] } : b)) });
  });
  return slugs;
}

/** Card screenshot → the visible logo's size (pixels that differ from the
 *  card's own colour) and the colour just inside the logo box's corner. */
async function measureCard(page: Page, card: Locator) {
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('img')).toBeVisible();
  await page.waitForTimeout(400);
  const b = await box(card);
  const shot = PNG.sync.read(await card.screenshot({ animations: 'disabled' }));
  const scale = shot.width / b.width;
  const px = (x: number, y: number) => {
    const i = (Math.round(y * scale) * shot.width + Math.round(x * scale)) * 4;
    return [shot.data[i], shot.data[i + 1], shot.data[i + 2]];
  };
  const bg = px(b.width / 2, 4);
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (let y = 3; y < shot.height - 3; y++) {
    for (let x = 3; x < shot.width - 3; x++) {
      const i = (y * shot.width + x) * 4;
      const diff = Math.max(
        Math.abs(shot.data[i] - bg[0]),
        Math.abs(shot.data[i + 1] - bg[1]),
        Math.abs(shot.data[i + 2] - bg[2])
      );
      if (diff > 60) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return {
    bg,
    logoWidth: (maxX - minX + 1) / scale,
    logoHeight: (maxY - minY + 1) / scale,
    // Just inside the logo picture's top-left corner (padding is 12 / 16 px).
    innerCorner: px(18, 14),
    cardStyle: await card.evaluate((el) => getComputedStyle(el).backgroundColor),
  };
}

function near(a: number[], b: number[], tolerance = 8): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
}

test.describe('Part 5 — brand logos', () => {
  test('white- and black-backdrop twins: same size in light and dark, no black box', async ({ page }) => {
    const [slug] = await useTestLogos(page);
    const card = page.locator(`[data-testid="brand-row"] [data-brand-slug="${slug}"]`);
    await page.goto('/');
    const light = await measureCard(page, card);
    await page.evaluate(() => localStorage.setItem('theme', 'dark'));
    await page.goto('/');
    const dark = await measureCard(page, card);

    expect(near(light.bg, [255, 255, 255])).toBe(true);
    expect(near(dark.bg, [28, 28, 30])).toBe(true);
    expect(Math.abs(dark.logoWidth - light.logoWidth) / light.logoWidth).toBeLessThanOrEqual(0.03);
    expect(Math.abs(dark.logoHeight - light.logoHeight) / light.logoHeight).toBeLessThanOrEqual(0.03);
    // The black backdrop is gone: the corner of the logo box is card colour.
    expect(near(dark.innerCorner, dark.bg), `inner corner ${dark.innerCorner}`).toBe(true);
    expect(near(light.innerCorner, light.bg)).toBe(true);
  });

  test('a coloured-backdrop logo fills the whole card with its colour, in both modes', async ({ page }) => {
    const [, slug] = await useTestLogos(page);
    const card = page.locator(`[data-testid="brand-row"] [data-brand-slug="${slug}"]`);
    const results = [];
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => localStorage.setItem('theme', t), theme);
      await page.goto('/');
      await expect(card).toHaveClass(/brand-card--colour/, { timeout: 15_000 });
      results.push(await measureCard(page, card));
    }
    for (const r of results) {
      expect(r.cardStyle).toBe(`rgb(${BLUE.join(', ')})`);
      expect(near(r.bg, BLUE)).toBe(true);
      expect(near(r.innerCorner, BLUE), `no inner box: ${r.innerCorner}`).toBe(true);
    }
    expect(Math.abs(results[0].logoWidth - results[1].logoWidth)).toBeLessThanOrEqual(2);
  });

  test('a logo that cannot be read still shows, as it is', async ({ page }) => {
    const [, , slug] = await useTestLogos(page);
    await page.goto('/');
    const img = page.locator(`[data-testid="brand-row"] [data-brand-slug="${slug}"] img`);
    await img.scrollIntoViewIfNeeded();
    await expect(img).toBeVisible({ timeout: 15_000 });
    await expect(img).toHaveAttribute('src', logoUrl('e2e-b29-no-cors.png'));
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PART 6 — brand video: a still picture first
// ---------------------------------------------------------------------------

test.describe('Part 6 — brand video banner', () => {
  test('a still picture at once, the video fades in over it in the same box', async ({ page }) => {
    const live = await select<{ slug: string }[]>(null, 'brands?select=slug&banner_video_url=not.is.null&limit=1');
    const slug = live.data?.[0]?.slug;
    test.skip(!slug, 'no brand has an uploaded video');
    // Hold the video back for 3 s, as on a slow first visit.
    await page.route(/\/brand-media\/videos\/[^?]+\.(mp4|webm)(\?.*)?$/, async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    await page.goto(`/brand/${slug}`);
    const media = page.getByTestId('brand-banner-media');
    await expect(media).toBeVisible({ timeout: 15_000 });
    const video = page.getByTestId('brand-banner-video');
    const still = page.locator('[data-testid="brand-banner-still"], [data-testid="brand-banner-fallback"]').first();
    await expect(still).toBeVisible();
    expect(await video.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    const stillBox = await box(still);
    expect(stillBox.height).toBeGreaterThan(100);
    // Something is drawn there (not a blank area): the fallback carries the logo.
    const hasContent = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="brand-banner-still"]') as HTMLImageElement | null;
      if (s && s.complete && s.naturalWidth > 0) return true;
      return document.querySelector('[data-testid="brand-banner-fallback"] img, [data-testid="brand-banner-fallback"] span') !== null;
    });
    expect(hasContent).toBe(true);

    await expect(video).toHaveClass(/brand-banner__video--playing/, { timeout: 25_000 });
    await expect.poll(() => video.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const videoBox = await box(video);
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(videoBox[k] - stillBox[k])).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// PART 7 — fast Home
// ---------------------------------------------------------------------------

test.describe('Part 7 — fast Home', () => {
  test('no admin code on Home; the product page file is fetched before any tap', async ({ page }) => {
    const scripts: string[] = [];
    page.on('request', (req) => {
      if (req.resourceType() === 'script') scripts.push(req.url());
    });
    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => scripts.some((u) => /\/assets\/ProductDetailPage-[^/]+\.js$/.test(u)), { timeout: 15_000 }).toBe(true);
    const admin = scripts.filter((u) => /\/assets\/(AdminPage|[A-Za-z]*EditSheet|ProductEditorForm|SheetChrome)-/.test(u));
    expect(admin).toEqual([]);
  });

  test('pictures: the banner is high priority, cards below the first screen are lazy', async ({ page }) => {
    await page.goto('/');
    const hero = page.locator('.hero-banner__image').first();
    await expect(hero).toBeVisible({ timeout: 15_000 });
    await expect(hero).toHaveAttribute('fetchpriority', 'high');
    await expect(page.locator('.product-card').nth(5)).toBeAttached();
    const notLazy = await page
      .locator('.product-card__image')
      .evaluateAll((imgs) => imgs.filter((i) => i.getAttribute('loading') !== 'lazy').length);
    expect(notLazy).toBe(0);
  });

  test('Facebook PageView and GA page_view are still sent (queued until the trackers load)', async ({ page }) => {
    const settings = await select<{ key: string; value: string }[]>(
      null,
      'app_settings?select=key,value&key=in.(fb_pixel_id,ga_measurement_id)'
    );
    const ids = Object.fromEntries((settings.data ?? []).map((r) => [r.key, r.value?.trim() ?? '']));
    test.skip(!ids.fb_pixel_id && !ids.ga_measurement_id, 'no tracker IDs set');
    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
    if (ids.fb_pixel_id) {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const fbq = (window as unknown as { fbq?: { queue?: unknown[][] } }).fbq;
            return (fbq?.queue ?? []).some((args) => args[0] === 'track' && args[1] === 'PageView');
          })
        )
        .toBe(true);
    }
    if (ids.ga_measurement_id) {
      await expect
        .poll(() =>
          page.evaluate(() =>
            ((window as unknown as { dataLayer?: unknown[][] }).dataLayer ?? []).some(
              (args) => args[0] === 'event' && args[1] === 'page_view'
            )
          )
        )
        .toBe(true);
    }
    // The tracker scripts are still requested (the test blocks them from
    // reaching Facebook/Google): on the first touch at the latest.
    const trackerRequest = page.waitForRequest(/connect\.facebook\.net|googletagmanager\.com/, { timeout: 15_000 });
    await page.mouse.wheel(0, 200);
    await trackerRequest;
  });
});
