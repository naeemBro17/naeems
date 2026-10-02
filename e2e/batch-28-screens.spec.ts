import { PNG } from 'pngjs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';

// Batch 28: screenshots for reports/batch-28-screens/ at 390 px, light and
// dark — the product page on load, after adding (stepper + floating cart),
// scrolled mid-page with the bar shown, a product with a very white photo,
// and Home with the floating cart. Not a pass/fail test; only runs when
// asked:
//   SCREENS=1 npx playwright test e2e/batch-28-screens.spec.ts

test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');
// The site's service worker fetches photos itself, which page.route can't
// see — blocked so the white test photo really is used.
test.use({ serviceWorkers: 'block' });

const DIR = 'reports/batch-28-screens';
const PDP = '/product/cerave-hydrating-cleanser';

async function start(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
}

function whitePng(): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

for (const theme of ['light', 'dark'] as const) {
  test(`product page 390px ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await start(page, theme);
    await page.goto(PDP);
    await expect(page.getByTestId('add-to-cart')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${DIR}/product-load-390-${theme}.png` });

    await page.getByTestId('add-to-cart').click();
    await page.getByTestId('buy-bar-plus').click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/product-added-390-${theme}.png` });

    await page.evaluate(() => window.scrollTo({ top: 520, behavior: 'instant' }));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollBy({ top: -30, behavior: 'instant' }));
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${DIR}/product-scrolled-390-${theme}.png` });
    await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
  });

  test(`very white photo 390px ${theme}`, async ({ page }) => {
    const body = whitePng();
    await page.route(/\/storage\/v1\/object\/public\/product-images\//, (route: Route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body })
    );
    await start(page, theme);
    await page.goto(PDP);
    await expect(page.getByTestId('add-to-cart')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${DIR}/product-white-photo-390-${theme}.png` });
  });

  test(`Home with the floating cart 390px ${theme}`, async ({ page }) => {
    await start(page, theme);
    await page.reload();
    const adds = page.getByRole('button', { name: /^Add .* to cart$/ });
    await expect(adds.first()).toBeVisible();
    await page.locator('.product-grid').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70));
    await page.waitForTimeout(600);
    await adds.first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/home-floating-cart-390-${theme}.png` });
    await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
  });
}
