import { test, expect } from './fixtures';

test.describe('Back-button history hygiene', () => {
  test('browsing several top-level pages never adds more history than pages visited', async ({
    page,
  }) => {
    await page.goto('/shop');
    const start = await page.evaluate(() => window.history.length);

    await page.getByRole('link', { name: 'Account', exact: true }).click();
    await expect(page).toHaveURL(/\/account/);
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL('/shop');

    // Batch 71: no Cart tab any more; Search is the other top-level tab.
    await page.getByRole('link', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(/\/search/);
    await page.goBack();
    await expect(page).toHaveURL('/shop');

    const end = await page.evaluate(() => window.history.length);
    // Two real forward pushes (Account, Search) is the ceiling — a bug that
    // pushes an extra entry on the way there or back (the exact class of bug
    // reports/batch-21.txt Part 2 fixed for the Google OAuth round trip)
    // would show up here as more real entries than actual page visits.
    expect(end - start).toBeLessThanOrEqual(2);
  });
});
