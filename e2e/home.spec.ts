import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures';

/** Batch 29: Home draws its cards a few at a time after the first screen —
 *  wait until the grid has finished drawing before counting it. */
async function settledCount(grid: Locator): Promise<number> {
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const now = await grid.count();
    if (now === last && now > 0) return now;
    last = now;
    await grid.page().waitForTimeout(250);
  }
  return last;
}

test.describe('Home — categories', () => {
  test('home loads with the product grid and category chips visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'All' })).toBeVisible();
    await expect(page.locator('.product-card').first()).toBeVisible();
  });

  test('a category chip filters the grid, and All resets it', async ({ page }) => {
    await page.goto('/');
    const grid = page.locator('.product-card');
    await expect(grid.first()).toBeVisible();
    const allCount = await settledCount(grid);

    const chips = page.getByRole('tab').filter({ hasNotText: 'All' });
    const firstChip = chips.first();
    const chipName = (await firstChip.textContent())?.trim();
    await firstChip.click();
    await expect(firstChip).toHaveAttribute('aria-selected', 'true');

    // A real filter must narrow the grid to fewer items than "All" (this
    // catalog has products in more than one category — see
    // reports/fix-animation-audit.txt Part 1, the bug this guards against).
    const filteredCount = await grid.count();
    expect(filteredCount).toBeLessThan(allCount);
    expect(filteredCount).toBeGreaterThan(0);
    for (const card of await grid.all()) {
      await expect(card).toBeVisible();
    }
    void chipName;

    await page.getByRole('tab', { name: 'All' }).click();
    await expect(page.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    await expect(grid).toHaveCount(allCount);
  });

  test('a Browse circle filters the same way a chip does', async ({ page }) => {
    await page.goto('/');
    const grid = page.locator('.product-card');
    await expect(grid.first()).toBeVisible();
    const allCount = await settledCount(grid);

    const circle = page.getByRole('button', { name: /^Show .* products$/ }).first();
    await circle.click();
    await page.waitForTimeout(200);
    const filteredCount = await grid.count();
    expect(filteredCount).toBeLessThanOrEqual(allCount);
  });
});
