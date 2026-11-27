import { test, expect } from './fixtures';

test.describe('Policy pages', () => {
  // Batch 71: the hamburger menu is gone; its policy links are in the footer.
  test('every footer policy link opens its page and has a way back', async ({ page }) => {
    const pages: Array<[string, string]> = [
      ['About us', '/about'],
      ['Delivery info', '/delivery'],
      ['Return policy', '/return-policy'],
      ['Terms', '/terms'],
      ['Privacy policy', '/privacy'],
    ];

    for (const [label, path] of pages) {
      await page.goto('/');
      await page.locator('.site-footer').getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(path.replace('/', '\\/') + '$'));
      // No dead ends per CLAUDE.md — every screen has a visible way back.
      const backControl = page.getByRole('button', { name: /go back|back/i }).first();
      await expect(backControl).toBeVisible();
    }
  });

  test('a footer link on Home opens its policy page', async ({ page }) => {
    await page.goto('/shop');
    await page.locator('footer a[href="/about"]').first().click();
    await expect(page).toHaveURL(/\/about$/);
  });
});
