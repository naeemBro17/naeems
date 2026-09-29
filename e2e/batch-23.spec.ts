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
