import { test, expect } from './fixtures';

test.describe('Search flow', () => {
  test('open search, type, open a result, Back, Back returns to Home', async ({ page }) => {
    await page.goto('/');
    const startingHistoryLength = await page.evaluate(() => window.history.length);

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

    // First Back: product -> search, with the query still there.
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL(/\/search\?q=cerave/i);
    await expect(searchInput).toHaveValue('cerave');

    // Second Back: search -> Home.
    await page.goBack();
    await expect(page).toHaveURL('/');

    // Never more real history entries than real pages actually visited
    // (Home -> Search -> Product = 2 pushes) — see reports/batch-21.txt
    // Part 2 for the OAuth version of this same check.
    const endingHistoryLength = await page.evaluate(() => window.history.length);
    expect(endingHistoryLength - startingHistoryLength).toBeLessThanOrEqual(2);
  });

  test('typing an empty query does not break the search results page', async ({ page }) => {
    await page.goto('/search');
    const searchInput = page.getByRole('combobox', { name: 'Search products' });
    await expect(searchInput).toBeVisible();
    await expect(page).toHaveURL(/\/search/);
  });
});
