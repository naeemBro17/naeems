import { test, expect } from './fixtures';
import { assertCleanTransition } from './helpers/frames';

test.describe('Product open/close transitions', () => {
  // A card that straddles the viewport's top/bottom edge gets pulled fully
  // into view by the browser's own "scroll a newly focused element into
  // view" behaviour the instant it's tapped (these cards are natively
  // focusable — tabIndex=0 — for keyboard/screen-reader use). That's a real,
  // pre-existing browser behaviour independent of this batch's animation
  // work, not something to paper over in the test — so both scroll tests
  // below deliberately pick a card that's already fully inside the viewport
  // before clicking, the same way a real tap on a fully-visible card would.
  async function fullyVisibleCard(page: import('@playwright/test').Page) {
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

  test('opening a grid card and going back restores scroll position (scrolled far down)', async ({
    page,
  }) => {
    await page.goto('/shop');
    await page.waitForSelector('.product-card');
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(300);

    const card = await fullyVisibleCard(page);
    const name = (await card.locator('.product-card__name').textContent())?.trim();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(100);

    await card.click();
    await expect(page).toHaveURL(/\/product\//);
    if (name) {
      await expect(page.getByRole('main')).toContainText(name.slice(0, 10));
    }

    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL('/shop');
    await page.waitForTimeout(300);
    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(30);
  });

  test('opening a fully-visible card near the top and going back stays at the top', async ({
    page,
  }) => {
    await page.goto('/shop');
    await page.waitForSelector('.product-card');
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBe(0);

    // Batch 71: on /shop the grid starts on the first screen (only the
    // Shop header, search and chips above it), so the first card is fully
    // visible at scroll 0.
    const topCard = page.locator('.product-card').first();
    const box = await topCard.boundingBox();
    expect(box && box.y + box.height <= (page.viewportSize()?.height ?? 800)).toBe(true);
    await topCard.click();
    await expect(page).toHaveURL(/\/product\//);
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL('/shop');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(30);
  });

  test('opening the top grid card works and the bottom nav never disappears mid-slide', async ({
    page,
  }) => {
    await page.goto('/shop');
    const topCard = page.locator('.product-card').first();
    await expect(topCard).toBeVisible();

    await assertCleanTransition(
      page,
      async () => {
        await topCard.click();
      },
      { windowMs: 450 }
    );
    await expect(page).toHaveURL(/\/product\//);

    await assertCleanTransition(
      page,
      async () => {
        await page.getByRole('button', { name: 'Go back' }).click();
      },
      { windowMs: 450, expectNavVisible: true }
    );
    await expect(page).toHaveURL('/shop');
  });

  test('opening a product from a search result and back returns to the same search', async ({
    page,
  }) => {
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

    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL(/\/search\?q=cerave/i);
    await expect(searchInput).toHaveValue('cerave');
  });

  test('Home <-> Account crossfades without a black or blank frame', async ({ page }) => {
    await page.goto('/shop');
    await assertCleanTransition(page, async () => {
      await page.getByRole('link', { name: 'Account', exact: true }).click();
    });
    await expect(page).toHaveURL(/\/account/);

    await assertCleanTransition(page, async () => {
      await page.getByRole('button', { name: 'Go back' }).click();
    });
    await expect(page).toHaveURL('/shop');
  });
});
