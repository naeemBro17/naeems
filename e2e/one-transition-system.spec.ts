import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { assertSingleCleanTransition } from './helpers/frames';
import { phoneBackHeroEnabled, waitForViewTransitionsToFinish } from './helpers/animations';

/**
 * Covers reports/fix-one-transition.txt, updated for
 * reports/fix-back-known-good.txt: every navigation settles in ONE burst —
 * the in-app "<-" button (which starts its own View Transition) AND a real
 * phone back (page.goBack(), the same browser event a hardware/gesture back
 * fires; it only animates, as a reverse hero, when the switch in
 * src/lib/phoneBackTransition.ts is ON — otherwise it's an instant switch).
 *
 * assertSingleCleanTransition samples frames from the moment of the tap
 * until well past 1.5s after the page first settles, and fails on: a
 * near-black frame, a missing bottom nav, a SECOND burst of change after the
 * first one has already settled (the exact "hard cut, then a delayed second
 * animation ~0.6s later" bug this branch fixes), and any measurable real
 * layout shift (a real PerformanceObserver CLS reading, not a proxy).
 */

const PHONE_BACK_HERO = phoneBackHeroEnabled();

/** Picks a product card whose whole box is already inside the viewport
 *  before clicking — the same card a real tap would land on, and avoids
 *  Chrome's own "scroll a newly-focused element into view" behaviour (see
 *  product-transitions.spec.ts) muddying the transition's frame series with
 *  an unrelated scroll. */
async function fullyVisibleCard(page: Page) {
  const viewportHeight = page.viewportSize()?.height ?? 800;
  const cards = page.locator('.product-card');
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const box = await cards.nth(i).boundingBox();
    if (box && box.y >= 0 && box.y + box.height <= viewportHeight) {
      return cards.nth(i);
    }
  }
  return cards.first();
}

test.describe('fix-one-transition-system — exactly one mechanism, no double animation', () => {
  test.describe('grid card', () => {
    test('open (top of the page) is one clean gradual hero morph', async ({ page }) => {
      await page.goto('/');
      await page.waitForSelector('.product-card');
      const card = await fullyVisibleCard(page);
      await assertSingleCleanTransition(page, () => card.click(), { expectGradual: true });
      await expect(page).toHaveURL(/\/product\//);
    });

    test('in-app back reverses the hero cleanly, home already scrolled correctly underneath', async ({
      page,
    }) => {
      await page.goto('/');
      await page.waitForSelector('.product-card');
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(300);
      const card = await fullyVisibleCard(page);
      await card.click();
      await expect(page).toHaveURL(/\/product\//);

      await assertSingleCleanTransition(
        page,
        () => page.getByRole('button', { name: 'Go back' }).click(),
        { expectNavVisible: true, expectGradual: true }
      );
      await expect(page).toHaveURL('/');
    });

    test('phone back (page.goBack()) settles once — reverse hero when switched on', async ({ page }) => {
      await page.goto('/');
      await page.waitForSelector('.product-card');
      const card = await fullyVisibleCard(page);
      await card.click();
      await expect(page).toHaveURL(/\/product\//);
      // A real signal, not a timeout: the product page's own opening morph
      // has finished (a Back pressed DURING it is deliberately an instant
      // switch — see src/lib/phoneBackTransition.ts).
      await waitForViewTransitionsToFinish(page);

      await assertSingleCleanTransition(page, () => page.goBack(), {
        expectNavVisible: true,
        expectGradual: PHONE_BACK_HERO,
      });
      await expect(page).toHaveURL('/');
    });
  });

  test.describe('bento card', () => {
    async function openFirstBentoCard(page: Page) {
      const bentoCard = page.getByRole('button', { name: /^View details for/ }).first();
      await expect(bentoCard).toBeVisible();
      await assertSingleCleanTransition(page, () => bentoCard.click(), { expectGradual: true });
      await expect(page).toHaveURL(/\/product\//);
    }

    test('in-app back reverses the hero into the bento tile', async ({ page }) => {
      await page.goto('/');
      await openFirstBentoCard(page);

      await assertSingleCleanTransition(
        page,
        () => page.getByRole('button', { name: 'Go back' }).click(),
        { expectNavVisible: true, expectGradual: true }
      );
      await expect(page).toHaveURL('/');
    });

    test('phone back into the bento tile settles once — reverse hero when switched on', async ({ page }) => {
      await page.goto('/');
      await openFirstBentoCard(page);

      await assertSingleCleanTransition(page, () => page.goBack(), {
        expectNavVisible: true,
        expectGradual: PHONE_BACK_HERO,
      });
      await expect(page).toHaveURL('/');
    });
  });

  test.describe('search result', () => {
    async function openSearchResult(page: Page) {
      await page.goto('/');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(page).toHaveURL(/\/search/);
      const searchInput = page.getByRole('combobox', { name: 'Search products' });
      await searchInput.fill('cerave');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/[?&]q=cerave/i);
      const result = page.locator('.product-card').first();
      await expect(result).toBeVisible({ timeout: 5000 });
      await searchInput.blur();
      await result.click();
      await expect(page).toHaveURL(/\/product\//);
      await waitForViewTransitionsToFinish(page);
    }

    test('in-app back returns to the same search, one clean transition', async ({ page }) => {
      await openSearchResult(page);
      await assertSingleCleanTransition(
        page,
        () => page.getByRole('button', { name: 'Go back' }).click(),
        { expectGradual: true }
      );
      await expect(page).toHaveURL(/\/search\?q=cerave/i);
    });

    test('phone back returns to the same search, one clean transition', async ({ page }) => {
      await openSearchResult(page);
      await assertSingleCleanTransition(page, () => page.goBack(), { expectGradual: PHONE_BACK_HERO });
      await expect(page).toHaveURL(/\/search\?q=cerave/i);
    });
  });

  test.describe('Home <-> Expert', () => {
    async function openExpert(page: Page) {
      await page.goto('/');
      await page.getByRole('button', { name: /Talk with/ }).click();
      await expect(page).toHaveURL('/contact');
    }

    test('in-app back to Home is one clean crossfade, no second animation, no chip pop-in', async ({
      page,
    }) => {
      await openExpert(page);
      await assertSingleCleanTransition(
        page,
        () => page.getByRole('button', { name: 'Go back' }).click(),
        { expectNavVisible: true }
      );
      await expect(page).toHaveURL('/');
    });

    test('phone back to Home is one clean crossfade, no second animation, no chip pop-in', async ({
      page,
    }) => {
      await openExpert(page);
      await assertSingleCleanTransition(page, () => page.goBack(), { expectNavVisible: true });
      await expect(page).toHaveURL('/');
    });
  });

  test.describe('Home <-> Account', () => {
    test('there and back, both in-app, one clean transition each way', async ({ page }) => {
      await page.goto('/');
      await assertSingleCleanTransition(page, () => page.getByRole('button', { name: 'Account' }).click());
      await expect(page).toHaveURL(/\/account/);

      await assertSingleCleanTransition(
        page,
        () => page.getByRole('button', { name: 'Go back' }).click(),
        { expectNavVisible: true }
      );
      await expect(page).toHaveURL('/');
    });

    test('phone back from Account is one clean transition', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Account' }).click();
      await expect(page).toHaveURL(/\/account/);

      await assertSingleCleanTransition(page, () => page.goBack(), { expectNavVisible: true });
      await expect(page).toHaveURL('/');
    });
  });

  test.describe('Home <-> Cart', () => {
    test('there and back, both in-app, one clean transition each way', async ({ page }) => {
      await page.goto('/');
      await assertSingleCleanTransition(page, () => page.getByRole('button', { name: 'Cart' }).click());
      await expect(page).toHaveURL(/\/cart/);

      await assertSingleCleanTransition(
        page,
        () => page.getByRole('button', { name: 'Go back' }).click(),
        { expectNavVisible: true }
      );
      await expect(page).toHaveURL('/');
    });

    test('phone back from Cart is one clean transition', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Cart' }).click();
      await expect(page).toHaveURL(/\/cart/);

      await assertSingleCleanTransition(page, () => page.goBack(), { expectNavVisible: true });
      await expect(page).toHaveURL('/');
    });
  });

  test.describe('Home scrolled far down', () => {
    test('open + in-app back keeps the scrolled position with no second animation', async ({ page }) => {
      await page.goto('/');
      await page.waitForSelector('.product-card');
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(300);
      const scrollBefore = await page.evaluate(() => window.scrollY);
      expect(scrollBefore).toBeGreaterThan(100);

      const card = await fullyVisibleCard(page);
      await card.click();
      await expect(page).toHaveURL(/\/product\//);

      await assertSingleCleanTransition(
        page,
        () => page.getByRole('button', { name: 'Go back' }).click(),
        { expectNavVisible: true, expectGradual: true }
      );
      await expect(page).toHaveURL('/');
      const scrollAfter = await page.evaluate(() => window.scrollY);
      expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(30);
    });
  });
});
