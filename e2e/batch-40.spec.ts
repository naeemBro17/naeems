import type { BrowserContext, Page, Request, Response, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { PLACEHOLDER_HEADER, STORAGE_FILE, storageLeakCount, storageLeaksSince } from './helpers/storageGuard';
import { startDevServer } from './helpers/devServer';
import { select } from './helpers/api';

/**
 * Batch 40 — stop the Supabase bandwidth problem.
 * Part 1: the tests themselves never download real Storage files.
 * Part 3: a calm page when Supabase is blocked or down.
 * Part 4: photos (two sizes, new names, long cache), the offline helper,
 *         brand videos.
 */

interface StorageTally {
  placeholders: number;
  real: string[];
  realBytes: number;
}

/** Counts every Storage file answer this context receives. */
function tallyStorage(context: BrowserContext): StorageTally {
  const tally: StorageTally = { placeholders: 0, real: [], realBytes: 0 };
  context.on('response', (response: Response) => {
    const url = response.url();
    if (!STORAGE_FILE.test(url) || !['GET', 'HEAD'].includes(response.request().method())) return;
    if (response.headers()[PLACEHOLDER_HEADER] === '1') {
      tally.placeholders += 1;
      return;
    }
    void response.serverAddr().then(async (addr) => {
      if (addr === null) return;
      tally.real.push(url);
      tally.realBytes += (await response.body().catch(() => Buffer.alloc(0))).length;
    });
  });
  return tally;
}

async function scrollToEnd(page: Page): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const done = await page.evaluate(() => {
      window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
    });
    await page.waitForTimeout(150);
    if (done) break;
  }
}

test.describe('Part 1 — tests download no real Storage files', () => {
  test('guard: Home (scrolled to the end) and a product page — zero real Storage bytes', async ({ page, context }) => {
    test.setTimeout(60_000);
    const tally = tallyStorage(context);
    const leaksBefore = storageLeakCount();

    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
    await scrollToEnd(page);
    await page.waitForTimeout(1500);

    await page.locator('.product-card').first().scrollIntoViewIfNeeded();
    await page.locator('.product-card').first().click();
    await expect(page).toHaveURL(/\/product\//);
    await page.waitForTimeout(2000);

    // The pages really asked for pictures, and every one was answered here.
    expect(tally.placeholders).toBeGreaterThan(5);
    expect(tally.real, 'real Storage files downloaded').toEqual([]);
    expect(tally.realBytes).toBe(0);
    expect(storageLeaksSince(leaksBefore)).toEqual([]);
  });

  test('guard: a page the test opens itself (browser.newPage) gets the same placeholders', async ({ browser }) => {
    test.setTimeout(60_000);
    const page = await browser.newPage();
    const tally = tallyStorage(page.context());
    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(tally.placeholders).toBeGreaterThan(0);
    expect(tally.real).toEqual([]);
    await page.close();
  });

  test('guard: Facebook Pixel and Google Analytics never get a fake visit', async ({ page }) => {
    await page.goto('/');
    const reached = await page.evaluate(async () => {
      const urls = ['https://www.google-analytics.com/g/collect?v=2', 'https://connect.facebook.net/en_US/fbevents.js'];
      const results: boolean[] = [];
      for (const url of urls) {
        try {
          await fetch(url, { mode: 'no-cors' });
          results.push(true);
        } catch {
          results.push(false);
        }
      }
      return results;
    });
    expect(reached).toEqual([false, false]);
  });
});

/* ------------------------------------------------------------------ Part 3 */

const SUPABASE = /^https:\/\/[a-z0-9-]+\.supabase\.co\//;
const RESTRICTED = JSON.stringify({ message: 'Service restricted', code: 'exceed_cached_egress_quota' });

/** Every Supabase answer is "402 Service restricted" (11 Oct 2026) while
 *  `blocked()` is true; otherwise the request goes on as normal. */
async function restrictSupabase(page: Page, blocked: () => boolean = () => true): Promise<string[]> {
  const asked: string[] = [];
  await page.context().route(SUPABASE, (route) => {
    asked.push(route.request().url());
    if (!blocked()) return route.fallback();
    return route.fulfill({
      status: 402,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: RESTRICTED,
    });
  });
  return asked;
}

test.describe('Part 3 — if Supabase is blocked or down', () => {
  test('a 402 from Supabase: a calm page with working WhatsApp and Messenger buttons, no broken shop', async ({ page }) => {
    await restrictSupabase(page);
    await page.goto('/');
    const down = page.getByTestId('shop-down');
    await expect(down).toBeVisible({ timeout: 10_000 });
    await expect(down.getByRole('heading')).toHaveText('Our online shop is being updated.');
    await expect(down).toContainText('You can still order — message us:');
    const whatsapp = page.getByTestId('shop-down-whatsapp');
    const messenger = page.getByTestId('shop-down-messenger');
    await expect(whatsapp).toHaveAttribute('href', 'https://wa.me/8801560040012');
    await expect(messenger).toHaveAttribute('href', 'https://m.me/naeems.skinscience');
    for (const link of [whatsapp, messenger]) {
      await expect(link).toHaveAttribute('target', '_blank');
      const box = await link.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(48);
    }
    // Nothing of the broken shop around it.
    await expect(page.locator('.product-card')).toHaveCount(0);
    await expect(page.getByTestId('glass-cart')).toHaveCount(0);
    // No sideways scrolling at phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('a product link opened while blocked shows the same page', async ({ page }) => {
    await restrictSupabase(page);
    await page.goto('/product/any-product');
    await expect(page.getByTestId('shop-down')).toBeVisible({ timeout: 10_000 });
  });

  test('the admin sign-in page shows the short note and stays usable', async ({ page }) => {
    await restrictSupabase(page);
    await page.goto('/admin-access');
    await expect(page.getByTestId('backend-down-note')).toHaveText('Database not reachable right now. Your data is safe; try again later.', {
      timeout: 10_000,
    });
    await expect(page.getByRole('heading', { name: 'Admin Sign In' })).toBeVisible();
    await expect(page.getByTestId('shop-down')).toHaveCount(0);
  });

  test('no answer for 8 seconds: the same page; it goes away by itself when the data arrives', async ({ page }) => {
    test.setTimeout(60_000);
    // Hold the shop's data back for 12 s (Supabase not answering).
    await page.context().route(/\/rest\/v1\//, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      await route.fallback();
    });
    await page.goto('/');
    await expect(page.getByTestId('shop-down')).toBeVisible({ timeout: 11_000 });
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('shop-down')).toHaveCount(0);
  });

  test('it checks again at most every 30 seconds, and comes back by itself', async ({ page }) => {
    test.setTimeout(60_000);
    await page.clock.install();
    let blocked = true;
    const asked = await restrictSupabase(page, () => blocked);
    await page.goto('/');
    await expect(page.getByTestId('shop-down')).toBeVisible({ timeout: 10_000 });
    const before = asked.length;
    // Two minutes of waiting: about four light checks, no tight loop.
    await page.clock.runFor(120_000);
    const checks = asked.slice(before);
    expect(checks.length).toBeGreaterThanOrEqual(3);
    expect(checks.length).toBeLessThanOrEqual(5);
    expect(checks.every((u) => u.includes('/rest/v1/app_settings?select=key&limit=1'))).toBe(true);

    blocked = false;
    await page.clock.runFor(31_000);
    await expect(page.getByTestId('shop-down')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 20_000 });
  });
});

/* ------------------------------------------------------------------ Part 4 */

/** The shop's own picture/video code, run in the test browser (a Vite dev
 *  server serves the source files; e2e/harness/media.ts). */
test.describe('Part 4 — photos and videos made light (the shop\'s own code, in the browser)', () => {
  let dev: { url: string; close: () => Promise<void> };
  test.beforeAll(async () => {
    dev = await startDevServer();
  });
  test.afterAll(async () => {
    await dev?.close();
  });

  async function harness(page: Page): Promise<void> {
    await page.goto(`${dev.url}offline.html`);
  }

  test('a product photo becomes a large (1400 px) and a card (480 px) WebP; a small photo is never enlarged', async ({ page }) => {
    test.setTimeout(60_000);
    await harness(page);
    const big = await page.evaluate(async () => (await import('/e2e/harness/media.ts')).photoVersions(3000, 2400));
    expect(big.large).toMatchObject({ width: 1400, height: 1120, type: 'image/webp' });
    expect(big.card).toMatchObject({ width: 480, height: 384, type: 'image/webp' });
    expect(big.card.bytes).toBeLessThan(80 * 1024);
    expect(big.card.bytes).toBeLessThan(big.large.bytes);
    const small = await page.evaluate(async () => (await import('/e2e/harness/media.ts')).photoVersions(900, 900));
    expect(small.large).toMatchObject({ width: 900, height: 900 });
    expect(small.card).toMatchObject({ width: 480, height: 480 });
  });

  test('every upload gets a new name and the one-year cache setting', async ({ page }) => {
    test.setTimeout(60_000);
    const uploads: { path: string; body: string }[] = [];
    await page.route(/\/storage\/v1\/object\/product-images\//, async (route: Route) => {
      const request = route.request();
      if (request.method() !== 'POST' && request.method() !== 'PUT') return route.fallback();
      uploads.push({ path: new URL(request.url()).pathname, body: request.postDataBuffer()?.toString('latin1') ?? '' });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ Key: 'mock', Id: 'mock' }),
      });
    });
    await harness(page);
    const result = await page.evaluate(async () => (await import('/e2e/harness/media.ts')).uploadTest());

    // Product photos: products/{id}.webp + products/card/{id}.webp, new ids each time.
    const [first, second] = result.product;
    expect(first.url).toMatch(/\/products\/[0-9a-f-]{36}\.webp$/);
    expect(first.cardUrl).toBe(first.url.replace('/products/', '/products/card/'));
    expect(second.url).not.toBe(first.url);
    // One-photo fields: next to the old name, never over it, no "?v=".
    expect(result.admin[0]).toMatch(/\/banners\/slide-1-[0-9a-z-]{8}\.webp$/);
    expect(result.admin[1]).not.toBe(result.admin[0]);

    expect(uploads).toHaveLength(6);
    expect(new Set(uploads.map((u) => u.path)).size).toBe(6);
    for (const upload of uploads) {
      // Never "upsert" over an existing file, always the one-year setting.
      expect(upload.body).toContain('31536000');
      expect(upload.body).toMatch(/name="cacheControl"/);
    }
  });

  test('a brand video becomes H.264, at most 720p, no sound, at most 1.5 MB (20 s at most)', async ({ page }) => {
    test.setTimeout(180_000);
    await harness(page);
    const results = await page.evaluate(async () => {
      const m = await import('/e2e/harness/media.ts');
      return [
        await m.compressTest({ width: 1920, height: 1080, seconds: 8, fps: 30, audio: true }),
        await m.compressTest({ width: 1280, height: 720, seconds: 26, fps: 30, audio: false }),
        await m.compressTest({ width: 1080, height: 1920, seconds: 6, fps: 30, audio: true }),
      ];
    });
    for (const r of results) {
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) continue;
      expect(r.after.codec).toBe('avc');
      expect(r.after.bytes).toBeLessThanOrEqual(1.5 * 1024 * 1024);
      expect(Math.min(r.after.width, r.after.height)).toBeLessThanOrEqual(720);
      expect(Math.max(r.after.width, r.after.height)).toBeLessThanOrEqual(1280);
      expect(r.after.audioTracks).toBe(0);
      expect(r.after.seconds).toBeLessThanOrEqual(20.1);
      expect(r.after.bytes).toBeLessThan(r.before.bytes);
    }
    // The 1080p clip with sound: much smaller, 720p, silent.
    const [hd] = results;
    if (hd.ok) {
      expect(hd.before.audioTracks).toBe(1);
      expect(hd.after).toMatchObject({ width: 1280, height: 720 });
    }
  });
});

/** Products whose card copy is in card/ (as after "Make images light"):
 *  the browser sees this answer instead of the live one. */
async function withCardCopies(page: Page): Promise<{ slug: string; large: string; card: string }> {
  let first: { slug: string; large: string; card: string } | null = null;
  await page.route(/\/rest\/v1\/products_view\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const rows = (await response.json()) as { slug: string; image_urls: string[] | null; image_urls_thumb: string[] | null }[];
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const full = row.image_urls ?? [];
      row.image_urls_thumb = full.map((u) => u.split('?')[0].replace('/products/', '/products/card/'));
      if (!first && full.length > 0) first = { slug: row.slug, large: full[0], card: row.image_urls_thumb[0] };
    }
    return route.fulfill({ response, json: rows });
  });
  await page.goto('/');
  await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
  expect(first).not.toBeNull();
  return first as unknown as { slug: string; large: string; card: string };
}

test.describe('Part 4 — the shop shows the right size', () => {
  test('grids show the 480 px card copy; the product page shows the large photo', async ({ page }) => {
    test.setTimeout(60_000);
    const product = await withCardCopies(page);
    const cardImages = await page.locator('.product-card__image').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src') ?? ''));
    expect(cardImages.length).toBeGreaterThan(0);
    expect(cardImages.every((src) => src.includes('/products/card/'))).toBe(true);
    // Card pictures: lazy, with a size so nothing jumps.
    const first = page.locator('.product-card__image').first();
    await expect(first).toHaveAttribute('loading', 'lazy');
    await expect(first).toHaveAttribute('width', '480');

    await page.goto(`/product/${product.slug}`);
    const shown = page.locator('.product-detail__image').first();
    await expect(shown).toBeVisible({ timeout: 15_000 });
    expect(await shown.getAttribute('src')).toBe(product.large);
    expect(product.large).not.toContain('/card/');
    // The first photo loads at once; the rest only when swiped near.
    await expect(shown).toHaveAttribute('loading', 'eager');
  });

  test('every product photo, card copy and brand picture in the live shop is there (no broken images)', async () => {
    test.setTimeout(180_000);
    const products = await select<{ name: string; image_urls: string[] | null; image_urls_thumb: string[] | null }[]>(
      null,
      'products_view?select=name,image_urls,image_urls_thumb&is_active=eq.true'
    );
    const brands = await select<{ name: string; logo_url: string | null; logo_dark_url: string | null; banner_image_url: string | null; banner_video_url: string | null }[]>(
      null,
      'brands?select=name,logo_url,logo_dark_url,banner_image_url,banner_video_url'
    );
    const urls = new Set<string>();
    for (const p of products.data ?? []) for (const u of [...(p.image_urls ?? []), ...(p.image_urls_thumb ?? [])]) urls.add(u);
    for (const b of brands.data ?? []) for (const u of [b.logo_url, b.logo_dark_url, b.banner_image_url, b.banner_video_url]) if (u) urls.add(u);
    expect(urls.size).toBeGreaterThan(50);

    // Only the first byte of each file (a HEAD answer carries different
    // cache headers than a real download, so a 1-byte download is asked).
    const list = [...urls];
    const missing: string[] = [];
    let longCache = 0;
    let newCopies = 0;
    let newCopiesLong = 0;
    for (let i = 0; i < list.length; i += 8) {
      await Promise.all(
        list.slice(i, i + 8).map(async (url) => {
          const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
          await res.body?.cancel();
          if (!res.ok) missing.push(`${res.status} ${url}`);
          const cache = res.headers.get('cache-control') ?? '';
          if (cache.includes('max-age=31536000')) longCache += 1;
          if (url.includes('/card/') || /-720p\.mp4/.test(url)) {
            newCopies += 1;
            if (cache.includes('max-age=31536000')) newCopiesLong += 1;
          }
        })
      );
    }
    test.info().annotations.push({
      type: 'images',
      description: `${list.length} files checked, ${missing.length} missing, ${longCache} with the one-year cache, ${newCopies} Batch 40 copies`,
    });
    expect(missing, 'files the shop points at that are not in Storage').toEqual([]);
    // Everything made by Batch 40 code carries the one-year cache.
    expect(newCopiesLong).toBe(newCopies);
  });
});

test.describe('Part 4 — the offline helper keeps photos', () => {
  test('after the first visit, opening Home again downloads no photo: all come from the phone', async ({ page, context }) => {
    test.setTimeout(120_000);
    const fromNetwork: string[] = [];
    let counting = false;
    // Requests the offline helper (service worker) itself sends out = photos
    // it did not have yet. The page's own requests are answered by it.
    context.on('request', (request: Request) => {
      if (counting && request.serviceWorker() !== null && STORAGE_FILE.test(request.url())) fromNetwork.push(request.url());
    });
    const pageAnswers: { fromWorker: boolean }[] = [];
    page.on('response', (response: Response) => {
      if (counting && STORAGE_FILE.test(response.url()) && response.request().method() === 'GET') {
        pageAnswers.push({ fromWorker: response.fromServiceWorker() });
      }
    });

    // First visit: the helper installs and takes charge of the page.
    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 30_000 }).toBe(true);
    await scrollToEnd(page);
    await page.waitForTimeout(1500);
    // (In tests the browser's own cache is off, so photos shown before the
    // helper took charge are fetched by it once, on this visit.)
    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
    await scrollToEnd(page);
    await page.waitForTimeout(1500);

    // The visit being measured.
    counting = true;
    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
    await scrollToEnd(page);
    await page.waitForTimeout(2000);
    counting = false;

    expect(pageAnswers.length).toBeGreaterThan(10);
    expect(pageAnswers.every((a) => a.fromWorker)).toBe(true);
    expect(fromNetwork, 'photos downloaded again').toEqual([]);
  });
});

test.describe('Part 4 — brand videos', () => {
  test('Home never downloads a brand video (it used to pre-download three)', async ({ page }) => {
    test.setTimeout(60_000);
    const videos: string[] = [];
    page.context().on('request', (request: Request) => {
      if (/\.(mp4|webm)(\?|$)/.test(request.url())) videos.push(request.url());
    });
    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
    const row = page.getByTestId('brand-row');
    if ((await row.count()) > 0) {
      await row.scrollIntoViewIfNeeded();
      await row.locator('[data-testid="brand-card"]').first().dispatchEvent('pointerdown');
    }
    await scrollToEnd(page);
    await page.waitForTimeout(5000);
    expect(videos).toEqual([]);
  });

  test('a brand page: nothing of the video downloads until the banner is on screen; the picture shows first', async ({ page }) => {
    test.setTimeout(60_000);
    const live = await select<{ slug: string; banner_image_url: string | null }[]>(
      null,
      'brands?select=slug,banner_image_url&banner_video_url=not.is.null&limit=1'
    );
    const brand = live.data?.[0];
    test.skip(!brand, 'no brand has an uploaded video');
    // The banner starts off screen: the page's "on screen" watcher is held
    // until the test lets it see the banner.
    await page.addInitScript(() => {
      const held: { cb: IntersectionObserverCallback; el: Element[]; observer: IntersectionObserver }[] = [];
      const Real = window.IntersectionObserver;
      class Held implements IntersectionObserver {
        readonly root = null;
        readonly rootMargin = '0px';
        readonly thresholds = [0];
        private entry: { cb: IntersectionObserverCallback; el: Element[]; observer: IntersectionObserver };
        constructor(cb: IntersectionObserverCallback) {
          this.entry = { cb, el: [], observer: this };
          held.push(this.entry);
        }
        observe(el: Element) {
          this.entry.el.push(el);
        }
        unobserve() {}
        disconnect() {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
      }
      (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Held;
      (window as unknown as { __showBanner: () => void }).__showBanner = () => {
        for (const h of held) {
          const banner = h.el.filter((e) => e.matches('[data-testid="brand-banner-media"]'));
          if (banner.length === 0) continue;
          h.cb(banner.map((target) => ({ isIntersecting: true, target, intersectionRatio: 1 }) as unknown as IntersectionObserverEntry), h.observer);
        }
      };
      void Real;
    });
    const videos: string[] = [];
    page.context().on('request', (request: Request) => {
      if (/\/brand-media\/videos\/[^?]+\.(mp4|webm)(\?|$)/.test(request.url())) videos.push(request.url());
    });

    await page.goto(`/brand/${brand!.slug}`);
    const video = page.getByTestId('brand-banner-video');
    await expect(video).toHaveCount(1, { timeout: 15_000 });
    await expect(video).toHaveAttribute('preload', 'none');
    if (brand!.banner_image_url) await expect(video).toHaveAttribute('poster', brand!.banner_image_url);
    await expect(page.locator('[data-testid="brand-banner-still"], [data-testid="brand-banner-fallback"]').first()).toBeVisible();
    await page.waitForTimeout(3000);
    expect(videos, 'video downloaded before the banner was on screen').toEqual([]);
    expect(await video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true);

    await page.evaluate(() => (window as unknown as { __showBanner: () => void }).__showBanner());
    await expect.poll(() => videos.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(video).toHaveClass(/brand-banner__video--playing/, { timeout: 20_000 });
  });
});

