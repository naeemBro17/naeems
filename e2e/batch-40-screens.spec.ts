import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Batch 40: screenshots for reports/batch-40-screens/ — 360 px phone width,
// light and dark. Not a pass/fail test; only runs when asked:
//   SCREENS=1 npx playwright test e2e/batch-40-screens.spec.ts --project=parallel --no-deps
// Supabase is mocked as blocked ("402 Service restricted"), as on 11 Oct 2026.
test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');
test.use({ serviceWorkers: 'block', viewport: { width: 360, height: 760 } });

const DIR = 'reports/batch-40-screens';
const THEMES = ['light', 'dark'] as const;

async function blocked(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
  await page.context().route(/^https:\/\/[a-z0-9-]+\.supabase\.co\//, (route) =>
    route.fulfill({
      status: 402,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: JSON.stringify({ message: 'Service restricted' }),
    })
  );
}

for (const theme of THEMES) {
  test(`shop is being updated 360px ${theme}`, async ({ page }) => {
    await blocked(page, theme);
    await page.goto('/');
    await expect(page.getByTestId('shop-down')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${DIR}/shop-down-360-${theme}.png` });
  });

  test(`admin sign-in note 360px ${theme}`, async ({ page }) => {
    await blocked(page, theme);
    await page.goto('/admin-access');
    await expect(page.getByTestId('backend-down-note')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${DIR}/admin-sign-in-note-360-${theme}.png` });
  });
}
