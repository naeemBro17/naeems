import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

// Batch 27: screenshots for reports/batch-27-screens/ — the product page
// (top and scrolled), Home with the glass cart and card steppers at 390 px,
// and a row of long card titles at 360 / 390 / 412 px, light and dark. Not
// a pass/fail test; only runs when asked:
//   SCREENS=1 npx playwright test e2e/batch-27-screens.spec.ts

test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');

const DIR = 'reports/batch-27-screens';
const PDP = '/product/aveeno-baby-daily-moisture-lightly-scented-wash-shampoo-236ml';

async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
}

for (const theme of ['light', 'dark'] as const) {
  test(`product page and Home 390px ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await useTheme(page, theme);
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
    await page.reload();
    const adds = page.getByRole('button', { name: /^Add .* to cart$/ });
    await expect(adds.first()).toBeVisible();
    await page.locator('.product-grid').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70));
    await page.waitForTimeout(600);
    await adds.first().click();
    await adds.nth(1).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/home-glass-cart-390-${theme}.png` });

    await page.goto(PDP);
    await expect(page.getByTestId('add-to-cart')).toBeVisible();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${DIR}/product-top-390-${theme}.png` });
    await page.getByTestId('trust-plate').evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().bottom + 20));
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/product-scrolled-390-${theme}.png` });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/product-bottom-390-${theme}.png` });
    await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
  });

  for (const width of [360, 390, 412]) {
    test(`long card titles ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await useTheme(page, theme);
      await page.goto('/search?q=aveeno');
      const card = page.locator('.product-card', { hasText: 'Lightly Scented Wash' }).first();
      await expect(card).toBeVisible();
      await card.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 120));
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${DIR}/titles-${width}-${theme}.png` });
    });
  }
}
