import { test, expect } from './fixtures';

test.describe('Back-button history hygiene', () => {
  test('browsing several top-level pages never adds more history than pages visited', async ({
    page,
  }) => {
    await page.goto('/');
    const start = await page.evaluate(() => window.history.length);

    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page).toHaveURL(/\/account/);
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL('/');

    await page.getByRole('button', { name: 'Cart', exact: true }).click();
    await expect(page).toHaveURL(/\/cart/);
    await page.goBack();
    await expect(page).toHaveURL('/');

    const end = await page.evaluate(() => window.history.length);
    // Two real forward pushes (Account, Cart) is the ceiling — a bug that
    // pushes an extra entry on the way there or back (the exact class of bug
    // reports/batch-21.txt Part 2 fixed for the Google OAuth round trip)
    // would show up here as more real entries than actual page visits.
    expect(end - start).toBeLessThanOrEqual(2);
  });
});
