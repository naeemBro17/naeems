import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL } from './helpers/env';
import { passwordSession, useSessionInPage } from './helpers/api';

// Batch 26: screenshots of the new screens — Home's "Shop by Brand" row,
// /brands, a brand page, and the admin Brands list, brand editor, Restock
// sheet, 7-day chart and customer notes — dark and light, saved to
// reports/batch-26-screens/. Not a pass/fail test; only runs when asked:
//   SCREENS=1 npx playwright test e2e/batch-26-screens.spec.ts
// Needs at least one brand with "Show on home" on and a product.

test.skip(!process.env.SCREENS, 'Screenshots only when SCREENS=1.');
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the test Super Admin in .env.e2e.');

const DIR = 'reports/batch-26-screens';

for (const theme of ['light', 'dark'] as const) {
  test(`shop screens 390px ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
    await page.goto('/');
    const row = page.locator('[data-testid="brand-row"]');
    await expect(row.locator('[data-testid="brand-card"]').first()).toBeVisible({ timeout: 20_000 });
    await row.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 300));
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/home-row-390-${theme}.png` });

    await page.goto('/brands');
    await expect(page.locator('.brands-grid__item').first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/brands-390-${theme}.png` });

    const slug = await page.locator('[data-testid="brand-card"]').first().getAttribute('data-brand-slug');
    await page.goto(`/brand/${slug}`);
    await expect(page.locator('.brand-page__name')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/brand-page-390-${theme}.png` });
  });

  for (const size of [
    { label: '390', width: 390, height: 844 },
    { label: '1280', width: 1280, height: 800 },
  ]) {
    test(`admin screens ${size.label}px ${theme}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: size.width, height: size.height });
      const admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
      await useSessionInPage(page, admin);
      await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);

      await page.goto('/admin?tab=brands');
      await expect(page.locator('[data-testid="brand-row-admin"]').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${DIR}/admin-brands-${size.label}-${theme}.png` });

      await page.locator('[data-testid="brand-row-admin"] .adm-lrow__open').first().click();
      await expect(page.locator('#bf-name')).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${DIR}/admin-brand-editor-${size.label}-${theme}.png` });
      await page.locator('.adm-brand-preview').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/admin-brand-editor-logos-${size.label}-${theme}.png` });

      await page.goto('/admin');
      await expect(page.locator('[data-testid="sales-chart"]')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${DIR}/admin-home-chart-${size.label}-${theme}.png` });

      await page.goto('/admin?tab=products&pq=CeraVe');
      await page.getByRole('button', { name: /^Actions for CeraVe/ }).first().click({ timeout: 20_000 });
      await page.getByRole('menuitem', { name: 'Restock' }).click();
      await page.locator('[data-testid="restock-row"] input').first().fill('24');
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${DIR}/admin-restock-${size.label}-${theme}.png` });

      await page.goto(`/admin?tab=customers&cq=${encodeURIComponent(E2E_EMAIL)}`);
      await page.locator('[data-testid="customer-row"] .adm-lrow__open').first().click({ timeout: 20_000 });
      await expect(page.locator('[data-testid="customer-note"]')).toBeVisible();
      await page.locator('[data-testid="customer-note"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${DIR}/admin-customer-note-${size.label}-${theme}.png` });
    });
  }
}
