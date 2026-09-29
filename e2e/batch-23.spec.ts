import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  readViewTransitions,
  recordViewTransitions,
  waitForViewTransitionsToFinish,
  type HeroRecord,
} from './helpers/animations';

/**
 * Covers reports/batch-23.txt — bugs from Naeem's real-phone testing.
 */

type BackKind = 'phone' | 'in-app';

async function goBack(page: Page, kind: BackKind): Promise<void> {
  if (kind === 'phone') {
    await page.goBack();
  } else {
    await page.getByRole('button', { name: 'Go back' }).click();
  }
}

/** A product card whose whole box is inside the viewport. */
async function fullyVisibleCard(page: Page): Promise<Locator> {
  const viewportHeight = page.viewportSize()?.height ?? 800;
  const cards = page.locator('.product-card');
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const box = await cards.nth(i).boundingBox();
    if (box && box.y >= 60 && box.y + box.height <= viewportHeight) return cards.nth(i);
  }
  return cards.first();
}

async function scrollToAndSettle(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const current = window.scrollY;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY === current)));
      })
  );
}

async function lastHero(page: Page): Promise<HeroRecord> {
  await waitForViewTransitionsToFinish(page);
  const records = await readViewTransitions(page);
  const hero = records[records.length - 1]?.hero ?? null;
  expect(hero, 'a product hero morph ran').not.toBeNull();
  return hero as HeroRecord;
}

/**
 * Part 1 — the flying image's corners change GRADUALLY from the old end's
 * real visible radius to the new end's: the first sampled frame equals the
 * page it left, the last equals the page it landed on, and at least one
 * frame in between is strictly between the two (no snap at either end).
 */
function expectGradualCorners(hero: HeroRecord): void {
  expect(hero.fromRadius).not.toBeNull();
  expect(hero.toRadius).not.toBeNull();
  const from = hero.fromRadius as number;
  const to = hero.toRadius as number;
  expect(Math.abs(from - to), 'the two ends have different corners').toBeGreaterThan(4);
  expect(hero.radii.length).toBeGreaterThan(2);
  expect(Math.abs(hero.radii[0] - from), `first frame ${hero.radii[0]} = start ${from}`).toBeLessThan(1);
  expect(
    Math.abs(hero.radii[hero.radii.length - 1] - to),
    `last frame ${hero.radii[hero.radii.length - 1]} = end ${to}`
  ).toBeLessThan(1);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const between = hero.radii.filter((r) => r > lo + 1 && r < hi - 1);
  expect(between.length, `mid-flight radii: ${hero.radii.join(',')}`).toBeGreaterThan(0);
}

test.describe('Part 1 — hero morph corners animate, no snap', () => {
  for (const kind of ['in-app', 'phone'] as const) {
    test(`grid card -> product -> ${kind} back`, async ({ page }) => {
      await recordViewTransitions(page);
      await page.goto('/');
      await page.waitForSelector('.product-card');
      await page.locator('.product-card').nth(2).scrollIntoViewIfNeeded();
      await (await fullyVisibleCard(page)).click();
      await expect(page).toHaveURL(/\/product\//);
      const open = await lastHero(page);
      expectGradualCorners(open);
      expect(open.fromRadius as number).toBeGreaterThan(open.toRadius as number);

      await goBack(page, kind);
      await expect(page).toHaveURL('/');
      const back = await lastHero(page);
      expectGradualCorners(back);
      expect(back.toRadius as number).toBeGreaterThan(back.fromRadius as number);
    });

    test(`bento tile -> product -> ${kind} back`, async ({ page }) => {
      await recordViewTransitions(page);
      await page.goto('/');
      const bentoFace = page.locator('.bento-stack__slide').first();
      await expect(bentoFace).toBeVisible();
      await bentoFace.click();
      await expect(page).toHaveURL(/\/product\//);
      expectGradualCorners(await lastHero(page));

      await goBack(page, kind);
      await expect(page).toHaveURL('/');
      expectGradualCorners(await lastHero(page));
    });
  }

  test('search result -> product -> in-app back', async ({ page }) => {
    await recordViewTransitions(page);
    await page.goto('/search?q=cerave');
    await expect(page.locator('.product-card').first()).toBeVisible();
    await page.locator('.product-card').first().click();
    await expect(page).toHaveURL(/\/product\//);
    expectGradualCorners(await lastHero(page));

    await goBack(page, 'in-app');
    await expect(page).toHaveURL(/\/search\?q=cerave/);
    expectGradualCorners(await lastHero(page));
  });
});

test.describe('Part 2 — reload starts at the top; Back restores', () => {
  for (const path of ['/', '/search'] as const) {
    test(`${path}: Back restores the spot, scrolling updates it, a reload starts at the top`, async ({ page }) => {
      await page.goto(path);
      if (path !== '/') {
        await page.locator('.search-quickpicks .chip').filter({ hasText: /face care/i }).first().click();
      }
      await expect(page.locator('.product-card').nth(6)).toBeVisible();
      await scrollToAndSettle(page, 900);
      const before = await page.evaluate(() => window.scrollY);
      const url = page.url();

      await (await fullyVisibleCard(page)).click();
      await expect(page).toHaveURL(/\/product\//);
      await waitForViewTransitionsToFinish(page);
      await page.goBack();
      await expect(page).toHaveURL(url);
      await waitForViewTransitionsToFinish(page);
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(5);

      // Scroll somewhere else, then Back again from a product: the NEW spot.
      await scrollToAndSettle(page, 300);
      await page.waitForTimeout(400);
      const newSpot = await page.evaluate(() => window.scrollY);
      await (await fullyVisibleCard(page)).click();
      await expect(page).toHaveURL(/\/product\//);
      await waitForViewTransitionsToFinish(page);
      await page.goBack();
      await waitForViewTransitionsToFinish(page);
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - newSpot)).toBeLessThan(5);

      // Scroll to the top and reload: stays at the top.
      await scrollToAndSettle(page, 0);
      await page.waitForTimeout(400);
      await page.reload();
      await expect(page.locator('.product-card').first()).toBeVisible();
      await page.waitForTimeout(800);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      // Even a reload while scrolled down starts at the top.
      await scrollToAndSettle(page, 700);
      await page.waitForTimeout(400);
      await page.reload();
      await expect(page.locator('.product-card').first()).toBeVisible();
      await page.waitForTimeout(800);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });
  }

  test('Home tab goes to the top and forgets the old spot', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.product-card').nth(6)).toBeVisible();
    await scrollToAndSettle(page, 900);
    await (await fullyVisibleCard(page)).click();
    await expect(page).toHaveURL(/\/product\//);
    await waitForViewTransitionsToFinish(page);
    await page.goBack();
    await waitForViewTransitionsToFinish(page);
    await page.locator('.bottom-nav__tab').filter({ hasText: 'Home' }).click();
    await page.waitForFunction(() => window.scrollY === 0);
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.locator('.product-card').first()).toBeVisible();
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test.describe('Part 3 — variants: sizes appear, the image follows the choice', () => {
  test('CeraVe Hydrating Cleanser: opens on the card image, Korea shows its size and its own image', async ({
    page,
  }) => {
    await page.goto('/search?q=hydrating%20cleanser');
    const card = page.locator('.product-card', { hasText: 'CeraVe Hydrating Cleanser' }).first();
    await expect(card).toBeVisible();
    const cardSrc = (await card.locator('.product-card__image').getAttribute('src')) ?? '';
    await card.click();
    await expect(page).toHaveURL(/\/product\/cerave-hydrating-cleanser/);
    await waitForViewTransitionsToFinish(page);

    const firstImage = page.locator('.product-detail__image').first();
    const shownSrc = async () =>
      page.evaluate(() => {
        const carousel = document.querySelector<HTMLElement>('.product-detail__carousel');
        if (!carousel) return '';
        const index = Math.round(carousel.scrollLeft / carousel.clientWidth);
        return carousel.querySelectorAll('img')[index]?.getAttribute('src') ?? '';
      });

    // The same photo the card showed (the card may use its small version).
    const openedOn = (await firstImage.getAttribute('src')) ?? '';
    expect(openedOn).toBe(cardSrc.replace('/thumb/', '/'));
    // ...and it never changes by itself afterwards.
    for (let i = 0; i < 8; i++) {
      expect(await shownSrc()).toBe(openedOn);
      await page.waitForTimeout(500);
    }

    const regionRow = page.getByRole('group', { name: 'Region' });
    const sizeRow = page.getByRole('group', { name: 'Size' });
    await expect(regionRow).toBeVisible();
    await expect(sizeRow).toBeVisible();
    await expect(sizeRow.locator('[aria-pressed="true"]')).toHaveCount(1);
    const priceBefore = await page.locator('.product-detail__price').textContent();

    await regionRow.getByRole('button', { name: /korea/i }).click();
    await expect(sizeRow).toBeVisible();
    await expect(sizeRow.locator('[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('.product-detail__price')).not.toHaveText(priceBefore ?? '');
    await expect.poll(shownSrc).not.toBe(openedOn);
    const koreaSrc = await shownSrc();
    expect(koreaSrc).not.toBe('');

    await regionRow.getByRole('button', { name: /australia/i }).click();
    await expect.poll(shownSrc).toBe(openedOn);
    await expect(page.locator('.product-detail__price')).toHaveText(priceBefore ?? '');
  });
});

test.describe('Part 4 — every card cart button works', () => {
  test('tapping each Home card\'s cart button adds it, or opens its option picker and adds from there', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
    await page.reload();
    await expect(page.locator('.product-card').first()).toBeVisible();

    const cards = page.locator('.product-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(10);
    const failures: string[] = [];
    let added = 0;
    let picked = 0;
    let outOfStock = 0;

    const cartLines = () =>
      page.evaluate(() => (JSON.parse(localStorage.getItem('nph_cart') ?? '[]') as unknown[]).length);

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const button = card.locator('.cart-button');
      await button.scrollIntoViewIfNeeded();
      const label = (await button.getAttribute('aria-label')) ?? '';
      const name = (await card.locator('.product-card__name').textContent())?.trim() ?? `card ${i}`;
      if (await button.isDisabled()) {
        outOfStock += 1;
        continue;
      }
      const linesBefore = await cartLines();
      await button.tap();

      if (label.startsWith('Choose options for')) {
        const sheet = page.getByRole('dialog', { name: 'Choose options' });
        try {
          await expect(sheet).toBeVisible({ timeout: 3000 });
          await sheet.getByRole('button', { name: 'Add to Cart' }).tap();
          await expect(sheet).toBeHidden({ timeout: 3000 });
          picked += 1;
        } catch {
          failures.push(`${name}: option picker did not open or could not add`);
          await page.keyboard.press('Escape');
          continue;
        }
      } else {
        added += 1;
      }

      if (!page.url().endsWith('/')) {
        failures.push(`${name}: tapping the cart button left the page (${page.url()})`);
        await page.goto('/');
        continue;
      }
      await expect
        .poll(cartLines, { timeout: 2000 })
        .toBeGreaterThan(linesBefore)
        .catch(() => failures.push(`${name}: nothing was added to the cart`));
      await expect(button)
        .toHaveClass(/cart-button--added/, { timeout: 2000 })
        .catch(() => failures.push(`${name}: button does not show it is in the cart`));
    }

    console.log(
      `Cart buttons: ${count} cards — ${added} added directly, ${picked} via the option picker, ${outOfStock} out of stock (disabled).`
    );
    expect(failures, failures.join('\n')).toEqual([]);
    await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
  });
});

test.describe('Part 7 — video review plays inline and never leaves the page', () => {
  test('row shows the YouTube thumbnail; taps anywhere on the playing video stay on the page', async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);
    const opened: string[] = [];
    context.on('page', (p) => opened.push(p.url()));

    await page.goto('/product/cerave-hydrating-cleanser');
    const header = page.getByRole('button', { name: 'Video Review', exact: true });
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');

    const row = page.locator('.video-review');
    await row.scrollIntoViewIfNeeded();
    await expect(row.locator('img')).toHaveAttribute('src', /^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/hqdefault\.jpg$/);
    await expect(row).toContainText('Reviewed on YouTube');
    await expect(row.locator('a')).toHaveCount(0);

    await row.tap();
    const frame = page.locator('.video-player__frame');
    await expect(frame).toBeVisible();
    const iframeSrc = (await frame.locator('iframe').getAttribute('src')) ?? '';
    expect(iframeSrc).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\//);
    for (const param of ['controls=0', 'rel=0', 'modestbranding=1', 'playsinline=1', 'disablekb=1', 'fs=0', 'iv_load_policy=3']) {
      expect(iframeSrc).toContain(param);
    }

    // Inline at full card width, 16:9, and it genuinely starts playing.
    await frame.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();
    const { x, y, width, height } = box as { x: number; y: number; width: number; height: number };
    expect(Math.abs(width / height - 16 / 9)).toBeLessThan(0.05);
    await expect(page.getByRole('button', { name: 'Pause video' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Add .* to cart/ })).toBeAttached();

    const url = page.url();
    // Corners (YouTube's title, channel and logo live there), edges, centre.
    const points: Array<[number, number]> = [
      [0.05, 0.08], [0.5, 0.08], [0.95, 0.08], [0.05, 0.5], [0.5, 0.5],
      [0.05, 0.92], [0.5, 0.92], [0.8, 0.92], [0.3, 0.3], [0.7, 0.7],
    ];
    for (const [fx, fy] of points) {
      const px = x + width * fx;
      const py = y + height * fy;
      // Whatever is under the finger is our own layer, never YouTube's frame.
      const hit = await page.evaluate(
        ([hx, hy]) => document.elementFromPoint(hx, hy)?.className ?? '',
        [px, py]
      );
      expect(hit, `tap at ${fx},${fy} lands on`).toMatch(/video-player__(surface|sound)/);
      await page.touchscreen.tap(px, py);
      await page.waitForTimeout(250);
      expect(page.url()).toBe(url);
    }
    // Play/pause toggles from our own layer.
    const surface = page.locator('.video-player__surface');
    const before = await surface.getAttribute('aria-label');
    await surface.tap();
    await expect(surface).not.toHaveAttribute('aria-label', before ?? '', { timeout: 5000 });

    expect(opened).toEqual([]);
    expect(page.url()).toBe(url);
  });
});
