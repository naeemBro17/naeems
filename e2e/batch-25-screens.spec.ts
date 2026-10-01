import { test, expect } from './fixtures';
import { blockAdTracking } from './helpers/tracking';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './helpers/env';
import { passwordSession, useSessionInPage } from './helpers/api';

// Batch 25: screenshots of every admin page at phone (390px) and computer
// (1280px) width, dark and light, saved to reports/batch-25-screens/.
// Not a pass/fail test — it only runs when asked (SCREENS=1), so the normal
// suite stays fast:  SCREENS=1 npx playwright test e2e/batch-25-screens.spec.ts

const PAGES: { name: string; query: string }[] = [
  { name: 'home', query: '' },
  { name: 'orders', query: '?tab=orders' },
  { name: 'customers', query: '?tab=customers' },
  { name: 'products', query: '?tab=products' },
  { name: 'categories', query: '?tab=categories' },
  { name: 'import-export', query: '?tab=import-export' },
  { name: 'promo-codes', query: '?tab=promo-codes' },
  { name: 'wholesalers', query: '?tab=wholesalers' },
  { name: 'reviews', query: '?tab=reviews' },
  { name: 'bento', query: '?tab=bento' },
  { name: 'banner-texts', query: '?tab=design' },
  { name: 'banner-texts-texts', query: '?tab=design&dset=texts' },
  { name: 'team', query: '?tab=team' },
  { name: 'team-roles', query: '?tab=team&tview=roles' },
  { name: 'activity', query: '?tab=activity' },
  { name: 'settings', query: '?tab=settings' },
  { name: 'settings-order-number', query: '?tab=settings&sset=order-number' },
  { name: 'more', query: '?tab=more' },
];

const SIZES = [
  { label: '390', width: 390, height: 844 },
  { label: '1280', width: 1280, height: 800 },
];

test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the test Super Admin in .env.e2e.');

for (const theme of ['dark', 'light'] as const) {
  for (const size of SIZES) {
    test(`admin screens ${size.label}px ${theme}`, async ({ page }) => {
      test.setTimeout(240_000);
      await blockAdTracking(page);
      await page.setViewportSize({ width: size.width, height: size.height });
      const admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
      await useSessionInPage(page, admin);
      await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
      for (const p of PAGES) {
        if (size.width >= 1024 && p.name === 'more') continue;
        await page.goto(`/admin${p.query}`);
        await expect(page.locator('.adm-page-header').first()).toBeVisible({ timeout: 20_000 });
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(600);
        await page.screenshot({
          path: `reports/batch-25-screens/${p.name}-${size.label}-${theme}.png`,
        });
      }
    });
  }
}
