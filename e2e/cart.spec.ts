import { test, expect } from './fixtures';

test.describe('Cart', () => {
  test('add a product, change its quantity, then remove it', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.product-card');

    // A "Choose options" card (has variants) opens a picker sheet instead of
    // adding directly — pick a plain "Add ... to cart" card so this test
    // exercises the simple add/remove path, not the variant sheet.
    const addButton = page.getByRole('button', { name: /^Add .* to cart$/ }).first();
    const name = (await addButton.getAttribute('aria-label'))!.replace(/^Add /, '').replace(/ to cart$/, '');
    await addButton.click();

    await page.locator('.bottom-nav__tab').filter({ hasText: 'Cart' }).click();
    await expect(page).toHaveURL(/\/cart/);
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible();

    const increaseBtn = page.getByRole('button', { name: new RegExp(`Increase quantity of ${escapeRegExp(name)}`, 'i') });
    if (await increaseBtn.count() > 0) {
      await increaseBtn.click();
      await page.waitForTimeout(150);
    }

    // Decreasing to zero asks for confirmation ("Remove this item?") rather
    // than silently deleting the line.
    const decreaseBtn = page.getByRole('button', { name: new RegExp(`Decrease quantity of ${escapeRegExp(name)}`, 'i') });
    let guard = 0;
    while ((await decreaseBtn.count()) > 0 && guard < 10) {
      await decreaseBtn.click();
      await page.waitForTimeout(150);
      const confirmRemove = page.getByRole('button', { name: 'Remove', exact: true });
      if (await confirmRemove.isVisible().catch(() => false)) {
        await confirmRemove.click();
        await page.waitForTimeout(150);
        break;
      }
      guard += 1;
    }

    await expect(page.getByText(name, { exact: false })).toHaveCount(0);
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
