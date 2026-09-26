import { test, expect } from './fixtures';

test.describe('Policy pages', () => {
  test('every hamburger menu policy link opens its page and has a way back', async ({ page }) => {
    const pages: Array<[string, string]> = [
      ['About Us', '/about'],
      ['Delivery Info', '/delivery'],
      ['Return Policy', '/return-policy'],
      ['Terms & Conditions', '/terms'],
      ['Privacy Policy', '/privacy'],
    ];

    for (const [label, path] of pages) {
      await page.goto('/');
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('button', { name: label }).click();
      await expect(page).toHaveURL(new RegExp(path.replace('/', '\\/') + '$'));
      // No dead ends per CLAUDE.md — every screen has a visible way back.
      const backControl = page.getByRole('button', { name: /go back|back/i }).first();
      await expect(backControl).toBeVisible();
    }
  });

  test('a footer link on Home opens its policy page', async ({ page }) => {
    await page.goto('/');
    await page.locator('footer a[href="/about"]').first().click();
    await expect(page).toHaveURL(/\/about$/);
  });
});
