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
    // Batch 71: the first grid card sits on the first screen of /shop (the
    // old Home's bento tile is gone).
    await page.goto('/shop');
    const topCard = page.locator('.product-card').first();
    await expect(topCard).toBeVisible();
    await topCard.click();
    await expect(page).toHaveURL(/\/product\//);

    await assertCleanTransition(
      page,
      async () => {
        await page.goBack();
      },
      { windowMs: 450, expectNavVisible: true }
    );
    await expect(page).toHaveURL('/shop');
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(30);
    expect(errors).toEqual([]);
  });

  test('product -> home (scrolled far down) via phone back: scroll position restores, no black frame', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await page.goto('/shop');
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
    await expect(page).toHaveURL('/shop');
    await page.waitForTimeout(300);
    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(30);
    expect(errors).toEqual([]);
  });

  test('product -> search results via phone back: same search is still there, no black frame', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await page.goto('/shop');
    await page.getByRole('link', { name: 'Search', exact: true }).click();
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
    await page.goto('/shop');
    await page.getByRole('link', { name: 'Account', exact: true }).click();
    await expect(page).toHaveURL(/\/account/);

    await assertCleanTransition(page, async () => {
      await page.goBack();
    });
    await expect(page).toHaveURL('/shop');
    expect(errors).toEqual([]);
  });

  test('top grid card open + back reverses the hero with the in-app <- button', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/shop');
    const topCard = page.locator('.product-card').first();
    await expect(topCard).toBeVisible();
    await topCard.click();
    await expect(page).toHaveURL(/\/product\//);

    await assertCleanTransition(
      page,
      async () => {
        await page.getByRole('button', { name: 'Go back' }).click();
      },
      { windowMs: 450, expectNavVisible: true }
    );
    await expect(page).toHaveURL('/shop');
    expect(errors).toEqual([]);
  });
});
