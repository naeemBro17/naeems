import { PNG } from 'pngjs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { select } from './helpers/api';

// Batch 29: screenshots for reports/batch-29-screens/ at 390 px, light and
// dark — crystal buttons on an orange and a white photo, the stock + note
// area, the floating cart with the buy bar shown and hidden, the "Removed ·
// Undo" toast, Home's "Shop by Brand" row, and a brand page right after
// opening (still picture) and once its video plays. Not a pass/fail test;
// only runs when asked:
//   SCREENS=1 npx playwright test e2e/batch-29-screens.spec.ts

test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');
test.use({ serviceWorkers: 'block' });

const DIR = 'reports/batch-29-screens';
const NOTE = 'Packaging may vary slightly depending on the market of origin.';

interface Live {
  id: string;
  slug: string;
  name: string;
  retail_price: number;
  offer_price: number | null;
  image_urls: string[] | null;
  region: string | null;
  size: string | null;
}

async function liveProduct(): Promise<Live> {
  const res = await select<Live[]>(
    null,
    'products_view?select=id,slug,name,retail_price,offer_price,image_urls,region,size&is_active=eq.true&stock_status=eq.in_stock&order=name.asc'
  );
  const found = (res.data ?? []).find((p) => (p.image_urls ?? []).length >= 2 && !p.region && !p.size);
  expect(found).toBeTruthy();
  return found as Live;
}

async function start(page: Page, theme: 'light' | 'dark', cart = '[]'): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await page.goto('/');
  await page.evaluate((c) => localStorage.setItem('nph_cart', c), cart);
}

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

async function photoColour(page: Page, rgb: [number, number, number]): Promise<void> {
  const body = solidPng(...rgb);
  await page.route(/\/storage\/v1\/object\/public\/product-images\//, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body })
  );
}

for (const theme of ['light', 'dark'] as const) {
  test(`product page photos, stock + note, cart above the bar 390px ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    const product = await liveProduct();

    await photoColour(page, [255, 122, 69]);
    await start(page, theme);
    await page.goto(`/product/${product.slug}`);
    await expect(page.getByTestId('add-to-cart')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${DIR}/product-orange-photo-390-${theme}.png` });

    await page.unroute(/\/storage\/v1\/object\/public\/product-images\//);
    await photoColour(page, [255, 255, 255]);
    // The note, shown as on the La Roche-Posay page.
    await page.route(/\/rest\/v1\/products_view\?/, async (route: Route) => {
      const response = await route.fetch();
      const body = (await response.json()) as unknown;
      const patch = (row: { id?: string }) => (row.id === product.id ? { ...row, note: NOTE } : row);
      await route.fulfill({ response, json: Array.isArray(body) ? body.map(patch) : patch(body as { id?: string }) });
    });
    await page.goto(`/product/${product.slug}`);
    await expect(page.getByTestId('product-note')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${DIR}/product-white-photo-390-${theme}.png` });

    const price = await page.locator('.pdp-sheet [data-sheet-part="price"]').boundingBox();
    const trust = await page.getByTestId('trust-plate').boundingBox();
    if (price && trust) {
      await page.screenshot({
        path: `${DIR}/stock-note-390-${theme}.png`,
        clip: { x: 0, y: price.y - 16, width: 390, height: trust.y + trust.height - price.y + 32 },
      });
    }

    await page.getByTestId('add-to-cart').click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${DIR}/product-bar-shown-390-${theme}.png` });
    await page.mouse.move(200, 400);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${DIR}/product-bar-hidden-390-${theme}.png` });
  });

  test(`Removed · Undo toast 390px ${theme}`, async ({ page }) => {
    const product = await liveProduct();
    const line = { productId: product.id, variantId: null, variantLabel: null, quantity: 1, priceAtAdd: product.offer_price ?? product.retail_price };
    await start(page, theme, JSON.stringify([line]));
    await page.goto(`/product/${product.slug}`);
    await expect(page.getByTestId('buy-bar-minus')).toBeVisible();
    await page.waitForTimeout(800);
    await page.getByTestId('buy-bar-minus').click();
    await expect(page.getByTestId('undo-toast')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${DIR}/undo-toast-390-${theme}.png` });
  });

  test(`Home "Shop by Brand" row 390px ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await start(page, theme);
    await page.goto('/');
    const row = page.getByTestId('brand-row');
    await expect(row.locator('[data-brand-slug]').first()).toBeVisible({ timeout: 15_000 });
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);
    await row.screenshot({ path: `${DIR}/home-brands-390-${theme}.png` });
    // Along the row to the one-colour twins and the coloured-background logo.
    for (const slug of ['david-beckham', 'invisible-zinc']) {
      const card = row.locator(`[data-brand-slug="${slug}"]`);
      if ((await card.count()) === 0) continue;
      await card.evaluate((el) => el.scrollIntoView({ inline: 'center', block: 'nearest' }));
      await page.waitForTimeout(2500);
      await row.screenshot({ path: `${DIR}/home-brands-${slug}-390-${theme}.png` });
    }
  });

  test(`brand page still picture, then video 390px ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    const live = await select<{ slug: string }[]>(null, 'brands?select=slug&banner_video_url=not.is.null&limit=1');
    const slug = live.data?.[0]?.slug;
    test.skip(!slug, 'no brand has an uploaded video');
    await page.route(/\/brand-media\/videos\/[^?]+\.(mp4|webm)(\?.*)?$/, async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.continue();
    });
    await start(page, theme);
    await page.goto(`/brand/${slug}`);
    await expect(page.getByTestId('brand-banner-media')).toBeVisible();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${DIR}/brand-opening-390-${theme}.png` });
    await expect(page.getByTestId('brand-banner-video')).toHaveClass(/brand-banner__video--playing/, { timeout: 30_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/brand-video-390-${theme}.png` });
  });
}
