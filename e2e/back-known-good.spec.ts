import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  collectStrayAnimations,
  phoneBackHeroEnabled,
  readViewTransitions,
  recordViewTransitions,
  waitForViewTransitionsToFinish,
} from './helpers/animations';

/**
 * Covers reports/fix-back-known-good.txt.
 *
 * Part 1 — "Back returns you exactly where you were": the category chip,
 * typed query, results and scroll position all survive BOTH kinds of Back
 * (page.goBack() = the phone's back button; the in-app "Go back" arrow),
 * and the search box is never focused (no keyboard) on return.
 *
 * Parts 2/3 — what each kind of Back animates, proven from the browser's own
 * View Transition records (helpers/animations.ts), not from "some animation
 * existed somewhere on the page" (the bento tile's infinite flip made that
 * always true on Home, which is how the old tests passed while Naeem's phone
 * showed a hard cut plus a ghost crossfade).
 */

const PHONE_BACK_HERO = phoneBackHeroEnabled();

type BackKind = 'phone' | 'in-app';

async function goBack(page: Page, kind: BackKind): Promise<void> {
  if (kind === 'phone') {
    await page.goBack();
  } else {
    await page.getByRole('button', { name: 'Go back' }).click();
  }
}

/** A product card whose whole box is inside the viewport — the card a real
 *  tap lands on, without Chrome's focus-scroll moving the page first. */
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

async function openCardAndSettle(page: Page, card: Locator): Promise<void> {
  await card.click();
  await expect(page).toHaveURL(/\/product\//);
  await waitForViewTransitionsToFinish(page);
}

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

/** Scrolls by `dy` and waits until the page has actually come to rest. */
async function scrollBy(page: Page, dy: number): Promise<void> {
  await page.evaluate((delta) => window.scrollBy({ top: delta, behavior: 'instant' }), dy);
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const y = window.scrollY;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY === y)));
      })
  );
}

for (const kind of ['phone', 'in-app'] as const) {
  test.describe(`Back (${kind}) returns you exactly where you were`, () => {
    test('search: a picked category keeps its results, chip, scroll — no keyboard', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(page).toHaveURL(/\/search/);

      const chips = page.locator('.search-quickpicks .chip');
      await expect(chips.first()).toBeVisible();
      const babyCare = chips.filter({ hasText: /baby care/i });
      const chip = (await babyCare.count()) > 0 ? babyCare.first() : chips.first();
      const chipName = (await chip.textContent())?.trim() ?? '';
      await chip.click();
      await expect(page).toHaveURL(/[?&]cat=/);
      await expect(page.locator('.product-card').first()).toBeVisible();
      const countText = await page.locator('.search-page__count').textContent();

      await scrollBy(page, 250);
      const before = await scrollY(page);
      const urlBefore = page.url();
      await openCardAndSettle(page, await fullyVisibleCard(page));

      await goBack(page, kind);
      await expect(page).toHaveURL(urlBefore);
      await waitForViewTransitionsToFinish(page);

      await expect(page.locator('.search-page__count')).toHaveText(countText ?? '');
      await expect(page.getByRole('tab', { name: chipName, exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(Math.abs((await scrollY(page)) - before)).toBeLessThan(5);
      const searchFocused = await page.evaluate(
        () => document.activeElement?.getAttribute('aria-label') === 'Search products'
      );
      expect(searchFocused).toBe(false);
    });

    test('search: a typed query keeps its results and scroll — no keyboard', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const input = page.getByRole('combobox', { name: 'Search products' });
      await input.fill('cerave');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/[?&]q=cerave/i);
      await expect(page.locator('.product-card').first()).toBeVisible();
      const countText = await page.locator('.search-page__count').textContent();
      await input.blur();

      await scrollBy(page, 200);
      const before = await scrollY(page);
      await openCardAndSettle(page, await fullyVisibleCard(page));

      await goBack(page, kind);
      await expect(page).toHaveURL(/\/search\?q=cerave/i);
      await waitForViewTransitionsToFinish(page);
      await expect(input).toHaveValue('cerave');
      await expect(page.locator('.search-page__count')).toHaveText(countText ?? '');
      expect(Math.abs((await scrollY(page)) - before)).toBeLessThan(5);
      await expect(input).not.toBeFocused();
    });

    test('home: the selected chip and scroll position survive', async ({ page }) => {
      await page.goto('/');
      await page.waitForSelector('.product-card');
      const homeChips = page.locator('.home-chips [role="tab"]');
      await expect(homeChips.nth(1)).toBeVisible();
      const chip = homeChips.nth(1);
      const chipName = (await chip.textContent())?.trim() ?? '';
      await chip.click();
      await expect(page).toHaveURL(/[?&]cat=/);
      // Let the chip's own smooth "scroll the grid into view" settle first.
      await page.waitForTimeout(700);
      await scrollBy(page, 300);
      const before = await scrollY(page);
      const urlBefore = page.url();

      await openCardAndSettle(page, await fullyVisibleCard(page));
      await goBack(page, kind);
      await expect(page).toHaveURL(urlBefore);
      await waitForViewTransitionsToFinish(page);

      await expect(
        page.locator('.home-chips').getByRole('tab', { name: chipName, exact: true })
      ).toHaveAttribute('aria-selected', 'true');
      expect(Math.abs((await scrollY(page)) - before)).toBeLessThan(5);
    });
  });
}

test.describe('Phone back — clean switch, nothing plays afterwards', () => {
  test('grid product -> Home', async ({ page }) => {
    await recordViewTransitions(page);
    await page.goto('/');
    await page.waitForSelector('.product-card');
    await scrollBy(page, 900);
    const before = await scrollY(page);
    await openCardAndSettle(page, await fullyVisibleCard(page));
    const transitionsBefore = (await readViewTransitions(page)).length;

    await page.goBack();
    await expect(page).toHaveURL('/');

    if (!PHONE_BACK_HERO) {
      // Instant switch: already committed by the time the URL has changed,
      // so the very first frame has the right scroll.
      expect(Math.abs((await scrollY(page)) - before)).toBeLessThan(5);
      const stray = await collectStrayAnimations(page, { delayMs: 50, windowMs: 1500 });
      expect(stray).toEqual([]);
      expect((await readViewTransitions(page)).length).toBe(transitionsBefore);
      return;
    }

    // Flag ON: the Back must be a real reverse hero whose "before" picture is
    // the product page (the image shrinks from its full width to the card's),
    // captured mid-flight between the two sizes...
    await waitForViewTransitionsToFinish(page);
    const records = await readViewTransitions(page);
    const hero = records[records.length - 1]?.hero;
    expect(records.length).toBe(transitionsBefore + 1);
    // The first new frame (the browser's "after" picture) already has the
    // right scroll — read at the moment the page update finished, not
    // whenever the test runner happens to look.
    expect(Math.abs((records[records.length - 1].scrollYAfterUpdate ?? -1000) - before)).toBeLessThan(5);
    expect(Math.abs((await scrollY(page)) - before)).toBeLessThan(5);
    expect(hero).not.toBeNull();
    if (hero) {
      expect(hero.fromWidth).toBeGreaterThan(hero.toWidth * 1.5);
      const midFlight = hero.samples.filter((w) => w < hero.fromWidth - 1 && w > hero.toWidth + 1);
      expect(midFlight.length).toBeGreaterThan(0);
    }
    // ...and nothing at all plays once it has settled.
    expect(await collectStrayAnimations(page, { delayMs: 0, windowMs: 1500 })).toEqual([]);
  });

  test('bento product -> Home: instant, the same tile is back in place', async ({ page }) => {
    await recordViewTransitions(page);
    await page.goto('/');
    const bentoCard = page.getByRole('button', { name: /^View details for/ }).first();
    await expect(bentoCard).toBeVisible();
    const label = await bentoCard.getAttribute('aria-label');
    await openCardAndSettle(page, bentoCard);

    await page.goBack();
    await expect(page).toHaveURL('/');
    await waitForViewTransitionsToFinish(page);
    expect(await collectStrayAnimations(page, { delayMs: 0, windowMs: 1500 })).toEqual([]);
    await expect(page.getByRole('button', { name: label ?? '' }).first()).toBeVisible();
  });

  test('Expert -> Home: no slide, nothing afterwards', async ({ page }) => {
    await recordViewTransitions(page);
    await page.goto('/');
    await page.getByRole('button', { name: /Talk with/ }).click();
    await expect(page).toHaveURL('/contact');
    await waitForViewTransitionsToFinish(page);
    const transitionsBefore = (await readViewTransitions(page)).length;

    await page.goBack();
    await expect(page).toHaveURL('/');
    expect(await collectStrayAnimations(page, { delayMs: 50, windowMs: 1500 })).toEqual([]);
    expect((await readViewTransitions(page)).length).toBe(transitionsBefore);
  });
});

test.describe('In-app back arrow — reverse hero (restored from Batch 21)', () => {
  async function expectReverseHero(page: Page, transitionsBefore: number) {
    await waitForViewTransitionsToFinish(page);
    const records = await readViewTransitions(page);
    expect(records.length).toBe(transitionsBefore + 1);
    const last = records[records.length - 1];
    expect(last.hero).not.toBeNull();
    if (last.hero) {
      // "Before" = the product page's full-size image, "after" = the card:
      // proves the old page was captured before anything changed.
      expect(last.hero.fromWidth).toBeGreaterThan(last.hero.toWidth * 1.5);
    }
    expect(await collectStrayAnimations(page, { delayMs: 0, windowMs: 1500 })).toEqual([]);
  }

  test('grid card', async ({ page }) => {
    await recordViewTransitions(page);
    await page.goto('/');
    await page.waitForSelector('.product-card');
    await scrollBy(page, 900);
    await openCardAndSettle(page, await fullyVisibleCard(page));
    const before = (await readViewTransitions(page)).length;
    await goBack(page, 'in-app');
    await expect(page).toHaveURL('/');
    await expectReverseHero(page, before);
  });

  test('bento card', async ({ page }) => {
    await recordViewTransitions(page);
    await page.goto('/');
    const bentoCard = page.getByRole('button', { name: /^View details for/ }).first();
    await expect(bentoCard).toBeVisible();
    await openCardAndSettle(page, bentoCard);
    const before = (await readViewTransitions(page)).length;
    await goBack(page, 'in-app');
    await expect(page).toHaveURL('/');
    await expectReverseHero(page, before);
  });

  test('search result card', async ({ page }) => {
    await recordViewTransitions(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('combobox', { name: 'Search products' }).fill('cerave');
    await page.keyboard.press('Enter');
    await expect(page.locator('.product-card').first()).toBeVisible();
    await page.getByRole('combobox', { name: 'Search products' }).blur();
    await openCardAndSettle(page, await fullyVisibleCard(page));
    const before = (await readViewTransitions(page)).length;
    await goBack(page, 'in-app');
    await expect(page).toHaveURL(/\/search\?q=cerave/i);
    await expectReverseHero(page, before);
  });
});

test.describe('Expert page', () => {
  test('opens at the very top, even from a scrolled Home, and closes with a crossfade', async ({ page }) => {
    await recordViewTransitions(page);
    await page.goto('/');
    await page.waitForSelector('.product-card');
    const expertTile = page.getByRole('button', { name: /Talk with/ });
    await expertTile.scrollIntoViewIfNeeded();
    await scrollBy(page, 120);
    await expertTile.scrollIntoViewIfNeeded();
    expect(await scrollY(page)).toBeGreaterThan(50);

    await expertTile.click();
    await expect(page).toHaveURL('/contact');
    expect(await scrollY(page)).toBe(0);
    await waitForViewTransitionsToFinish(page);
    expect(await scrollY(page)).toBe(0);
    await expect(page.locator('.exp-header')).not.toHaveClass(/exp-header--collapsed/);

    const before = (await readViewTransitions(page)).length;
    await goBack(page, 'in-app');
    await expect(page).toHaveURL('/');
    await waitForViewTransitionsToFinish(page);
    const records = await readViewTransitions(page);
    expect(records.length).toBe(before + 1);
    // A crossfade animates only the page root, never a sliding transform.
    expect(records[records.length - 1].pseudos.every((p) => p.endsWith('(root)'))).toBe(true);
    const slid = await page.evaluate(() =>
      Array.from(document.styleSheets).some((sheet) => {
        try {
          return Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('vt-slide'));
        } catch {
          return false;
        }
      })
    );
    expect(slid).toBe(false);
  });
});
