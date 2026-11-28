import { mkdirSync } from 'node:fs';
import type { CDPSession, Locator, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { select } from './helpers/api';

// Fix 72.2: the product photo's counter is a dark glass pill "2 / 5"
// whenever there is more than one photo (nothing for one photo, no dots),
// and the heart on the photo is the rounder, wider shape.
//
// Nothing is written to Supabase. The photos are drawn locally (solid
// SVGs answered by page.route), so no real Storage file is downloaded and
// the bright / dark photo checks are exact. The photo count is changed
// inside this test browser only.

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Dhaka', deviceScaleFactor: 2 });

const SHOTS = 'reports/fix-72-2-screens';
const ROUND_HEART =
  'M12 20.3C5.4 15.6 3.2 12.4 3.2 9.4 3.2 7 5 5.2 7.3 5.2c1.9 0 3.6 1 4.7 2.7 1.1-1.7 2.8-2.7 4.7-2.7 2.3 0 4.1 1.8 4.1 4.2 0 3-2.2 6.2-8.8 10.9z';

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

interface LiveProduct {
  id: string;
  slug: string;
  image_urls: string[] | null;
}

/** The plain (no options) live product with the most photos, so option
 *  photos never change the count. */
async function manyPhotoProduct(): Promise<LiveProduct> {
  const res = await select<LiveProduct[]>(null, 'products_view?select=id,slug,image_urls&is_active=eq.true&order=name.asc');
  const vars = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id');
  const withOptions = new Set((vars.data ?? []).map((v) => v.product_id));
  const plain = (res.data ?? [])
    .filter((p) => p.slug && !withOptions.has(p.id))
    .sort((a, b) => (b.image_urls ?? []).length - (a.image_urls ?? []).length);
  expect(plain[0], 'a plain live product').toBeTruthy();
  return plain[0];
}

const PHOTOS = {
  // A soft beige product shot.
  mid: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3e6da"/><stop offset="1" stop-color="#c9a98e"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><circle cx="300" cy="300" r="140" fill="#8a5a3c"/></svg>',
  bright: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#ffffff"/></svg>',
  dark: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#0b0a09"/></svg>',
};

/** Every product photo in this browser is the given local picture. */
async function drawPhotos(page: Page, kind: keyof typeof PHOTOS): Promise<void> {
  await page.route(/supabase\.co\/storage\/v1\/(object|render)\//, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: PHOTOS[kind],
    })
  );
}

/** This product with only its first n photos, inside this browser only. */
async function limitPhotos(page: Page, id: string, n: number): Promise<void> {
  await page.route('**/rest/v1/products_view*', async (route: Route) => {
    const response = await route.fetch();
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) {
      await route.fulfill({ response });
      return;
    }
    const cut = (v: unknown) => (Array.isArray(v) ? v.slice(0, n) : v);
    const rows = (body as Record<string, unknown>[]).map((row) =>
      row.id === id
        ? { ...row, image_urls: cut(row.image_urls), image_urls_thumb: cut(row.image_urls_thumb), image_urls_card: cut(row.image_urls_card) }
        : row
    );
    await route.fulfill({ response, json: rows });
  });
}

async function openProduct(page: Page, slug: string): Promise<void> {
  await page.goto(`/product/${slug}`);
  await expect(page.getByTestId('pdp-buy')).toBeVisible({ timeout: 20_000 });
  // The buttons' glass colour transition settles.
  await page.waitForTimeout(500);
}

async function box(el: Locator) {
  const b = await el.boundingBox();
  expect(b).not.toBeNull();
  return b as { x: number; y: number; width: number; height: number };
}

/** The photo with its sheet edge, for the captures. */
async function shootPhoto(page: Page, name: string): Promise<void> {
  const w = page.viewportSize()?.width ?? 360;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: 0, y: 0, width: w, height: w + 30 } });
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

for (const n of [1, 2, 5, 11]) {
  test(`${n} photo${n === 1 ? '' : 's'} at 360 px: ${n === 1 ? 'no pill, no dots' : `the "1 / ${n}" glass pill bottom-left`}`, async ({ page }) => {
    test.setTimeout(60_000);
    const product = await manyPhotoProduct();
    test.skip((product.image_urls ?? []).length < n, `no plain live product with ${n} photos`);
    await drawPhotos(page, 'mid');
    await limitPhotos(page, product.id, n);
    await page.setViewportSize({ width: 360, height: 780 });
    await openProduct(page, product.slug);

    await expect(page.locator('.f721-dots, .f721-count, .product-detail__dots, [data-testid="image-dots"]')).toHaveCount(0);
    const pill = page.getByTestId('image-counter');
    if (n === 1) {
      await expect(pill).toHaveCount(0);
      await expect(page.locator('.pdp-count')).toHaveCount(0);
    } else {
      await expect(pill).toHaveText(`1 / ${n}`);
      await expect(pill).toHaveAttribute('role', 'img');
      await expect(pill).toHaveAttribute('aria-label', `Photo 1 of ${n}`);
      expect(await pill.getAttribute('aria-live')).toBeNull();
      expect(await pill.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
      // 12 px from the photo's left edge and 12 px above its visible bottom
      // (the top of the rounded sheet).
      const img = await box(page.locator('.product-detail__image').first());
      const sheet = await box(page.getByTestId('pdp-sheet'));
      const p = await box(pill);
      expect(Math.round(p.x - img.x)).toBe(12);
      expect(Math.round(sheet.y - (p.y + p.height))).toBe(12);
      expect(Math.round(p.height)).toBe(30);
    }
    await shootPhoto(page, `after-${n}-photos-360`);
    // The whole first screen, to set beside the one taken before Fix 72.2.
    await page.screenshot({ path: `${SHOTS}/after-${n}-top-360.png` });
  });
}

test('5 photos: a finger swipe to the next photo makes the pill say 2 / 5', async ({ page }) => {
  test.setTimeout(60_000);
  const product = await manyPhotoProduct();
  test.skip((product.image_urls ?? []).length < 5, 'no plain live product with 5 photos');
  await drawPhotos(page, 'mid');
  await limitPhotos(page, product.id, 5);
  await page.setViewportSize({ width: 360, height: 780 });
  await openProduct(page, product.slug);
  const pill = page.getByTestId('image-counter');
  await expect(pill).toHaveText('1 / 5');
  const cdp = await page.context().newCDPSession(page);
  await swipe(cdp, 280, 180, -220, 0);
  await expect(pill).toHaveText('2 / 5');
  await expect(pill).toHaveAttribute('aria-label', 'Photo 2 of 5');
  await page.waitForTimeout(400);
  await shootPhoto(page, 'after-5-photos-swiped-360');
});

for (const kind of ['bright', 'dark'] as const) {
  test(`a ${kind} photo: white numbers on dark glass, the same in light and dark mode`, async ({ page }) => {
    test.setTimeout(60_000);
    const product = await manyPhotoProduct();
    await drawPhotos(page, kind);
    await limitPhotos(page, product.id, 5);
    await page.setViewportSize({ width: 360, height: 780 });
    const looks: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openProduct(page, product.slug);
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, scheme);
      const pill = page.getByTestId('image-counter');
      await expect(pill).toHaveText('1 / 5');
      looks.push(
        await pill.evaluate((el) => {
          const s = getComputedStyle(el);
          return `${s.color}|${s.backgroundColor}|${s.backdropFilter}`;
        })
      );
      await shootPhoto(page, `after-${kind}-photo-360-${scheme}`);
    }
    expect(looks[0]).toBe('rgb(255, 255, 255)|rgba(20, 16, 16, 0.3)|blur(14px) saturate(1.5)');
    expect(looks[1]).toBe(looks[0]);
  });
}

test('320 px: the pill and the heart never overlap; the heart is the round shape; the page still scrolls with a finger on the photo', async ({ page }) => {
  test.setTimeout(60_000);
  const product = await manyPhotoProduct();
  test.skip((product.image_urls ?? []).length < 2, 'no plain live product with 2+ photos');
  const n = Math.min((product.image_urls ?? []).length, 20);
  await drawPhotos(page, 'mid');
  await limitPhotos(page, product.id, n);
  await page.setViewportSize({ width: 320, height: 700 });
  await openProduct(page, product.slug);

  const pill = await box(page.getByTestId('image-counter'));
  const heart = await box(page.getByTestId('photo-heart'));
  expect(pill.x + pill.width).toBeLessThan(heart.x - 8);

  // The heart: same 42 px glass button, the rounder path, outline when
  // not saved.
  const btn = page.getByTestId('photo-heart').getByTestId('wish-heart');
  expect(Math.round((await box(btn)).width)).toBe(42);
  const icon = btn.locator('svg');
  await expect(icon.locator('path')).toHaveAttribute('d', ROUND_HEART);
  await expect(icon).toHaveAttribute('fill', 'none');
  await shootPhoto(page, `after-${n}-photos-320`);
  await page.screenshot({
    path: `${SHOTS}/after-heart-closeup-320.png`,
    clip: { x: heart.x - 8, y: heart.y - 8, width: heart.width + 16, height: heart.height + 16 },
  });

  // A finger resting on the photo and moving up scrolls the page.
  const cdp = await page.context().newCDPSession(page);
  await swipe(cdp, 160, 160, 0, -260);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
});
