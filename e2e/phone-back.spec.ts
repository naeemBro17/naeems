import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { assertCleanTransition } from './helpers/frames';

/**
 * Covers reports/fix-phone-back.txt: a real phone back button / back
 * gesture fires `popstate` completely outside any of this app's click
 * handlers, so it used to fall back to a hand-rolled CSS slide with a real
 * black gap instead of the native crossfade/hero-morph an in-app tap
 * already got. page.goBack() fires a genuine popstate, the same event a
 * phone's hardware/gesture back triggers — a plain page.click() on the
 * in-app <- button never exercises this path at all, which is why these
 * needed their own spec file rather than living in product-transitions.spec.ts.
 */

/** Collects uncaught page errors — the concrete failure mode of two DOM
 *  elements racing to claim the same view-transition-name (a real DOMException
 *  the browser throws, not just a visual glitch) would show up here. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

test.describe('Phone back button — same transition as the in-app <- button', () => {
  test('product -> home (top of the grid) via phone back: no black frame, correct scroll, nav visible', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');
    const bentoCard = page.getByRole('button', { name: /^View details for/ }).first();
    await expect(bentoCard).toBeVisible();
    await bentoCard.click();
    await expect(page).toHaveURL(/\/product\//);

    await assertCleanTransition(
      page,
      async () => {
        await page.goBack();
      },
      { windowMs: 450, expectNavVisible: true }
    );
    await expect(page).toHaveURL('/');
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(30);
    expect(errors).toEqual([]);
  });

  test('product -> home (scrolled far down) via phone back: scroll position restores, no black frame', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');
    await page.waitForSelector('.product-card');
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(300);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(100);

    const viewportHeight = page.viewportSize()?.height ?? 800;
    const cards = page.locator('.product-card');
    const count = await cards.count();
    let card = cards.first();
    for (let i = 0; i < count; i++) {
      const box = await cards.nth(i).boundingBox();
      if (box && box.y >= 0 && box.y + box.height <= viewportHeight) {
        card = cards.nth(i);
        break;
      }
    }
    await card.click();
    await expect(page).toHaveURL(/\/product\//);

    await assertCleanTransition(page, async () => {
      await page.goBack();
    });
    await expect(page).toHaveURL('/');
    await page.waitForTimeout(300);
    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(30);
    expect(errors).toEqual([]);
  });

  test('product -> search results via phone back: same search is still there, no black frame', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(/\/search/);
    const searchInput = page.getByRole('combobox', { name: 'Search products' });
    await searchInput.fill('cerave');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);

    const result = page.locator('.product-card').first();
    await expect(result).toBeVisible({ timeout: 5000 });
    await result.click();
    await expect(page).toHaveURL(/\/product\//);

    await assertCleanTransition(page, async () => {
      await page.goBack();
    });
    await expect(page).toHaveURL(/\/search\?q=cerave/i);
    await expect(searchInput).toHaveValue('cerave');
    expect(errors).toEqual([]);
  });

  test('Account -> Home via phone back: crossfade, no black or blank frame', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page).toHaveURL(/\/account/);

    await assertCleanTransition(page, async () => {
      await page.goBack();
    });
    await expect(page).toHaveURL('/');
    expect(errors).toEqual([]);
  });

  test('bento tile open + back reverses the hero with the in-app <- button', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');
    const bentoCard = page.getByRole('button', { name: /^View details for/ }).first();
    await expect(bentoCard).toBeVisible();
    await bentoCard.click();
    await expect(page).toHaveURL(/\/product\//);

    await assertCleanTransition(
      page,
      async () => {
        await page.getByRole('button', { name: 'Go back' }).click();
      },
      { windowMs: 450, expectNavVisible: true }
    );
    await expect(page).toHaveURL('/');
    expect(errors).toEqual([]);
  });

  test('bento tile open + phone back reverses the hero the same way', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');
    const bentoCard = page.getByRole('button', { name: /^View details for/ }).first();
    await expect(bentoCard).toBeVisible();
    await bentoCard.click();
    await expect(page).toHaveURL(/\/product\//);

    await assertCleanTransition(
      page,
      async () => {
        await page.goBack();
      },
      { windowMs: 450, expectNavVisible: true }
    );
    await expect(page).toHaveURL('/');
    expect(errors).toEqual([]);
  });

  test('bento flip tile: opening the back face and returning (either back) pauses the flip on that exact face', async ({
    page,
  }) => {
    await page.goto('/');
    const backFace = page.locator('.bento-face--back').first();
    const hasBackFace = (await backFace.count()) > 0;
    if (!hasBackFace) {
      // Fewer than two featured products today — nothing to flip to. Not a
      // failure, just nothing this test can exercise right now.
      test.skip(true, 'No back face on the flip tile — fewer than 2 featured products.');
      return;
    }

    const errors = collectPageErrors(page);
    await backFace.click({ force: true });
    await expect(page).toHaveURL(/\/product\//);

    await page.goBack();
    await expect(page).toHaveURL('/');

    // The flipper this face belongs to should now be frozen mid-flip, facing
    // this exact face — not left cycling on whatever the CSS animation
    // happened to land on by the time React remounted the grid.
    const flipper = page.locator('.bento-flipper').first();
    await expect(flipper).toHaveAttribute('style', /rotateX\(180deg\)/);
    expect(errors).toEqual([]);
  });

  test('bento stack tile: opening a card that is not the first one and going back restores it into view', async ({
    page,
  }) => {
    await page.goto('/');
    const slides = page.locator('.bento-stack__slide');
    const count = await slides.count();
    if (count < 2) {
      test.skip(true, 'Fewer than 2 products in the stack tile today — nothing to restore to.');
      return;
    }

    const errors = collectPageErrors(page);
    const tileBoxBefore = await page.locator('.bento-tile--stack').boundingBox();
    const second = slides.nth(1);
    await second.click({ force: true });
    await expect(page).toHaveURL(/\/product\//);

    await page.goBack();
    await expect(page).toHaveURL('/');

    // Slide index 1 should now be the one sitting in the tile's own visible
    // area — before the fix, the track always reset to index 0 on remount,
    // so the reverse-hero name ended up on an element scrolled out of sight.
    const secondBoxAfter = await slides.nth(1).boundingBox();
    expect(tileBoxBefore).not.toBeNull();
    expect(secondBoxAfter).not.toBeNull();
    if (tileBoxBefore && secondBoxAfter) {
      expect(Math.abs(secondBoxAfter.y - tileBoxBefore.y)).toBeLessThan(10);
    }
    expect(errors).toEqual([]);
  });
});
