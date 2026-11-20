import { mkdirSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import writeXlsxFile from 'write-excel-file/node';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './helpers/env';
import { passwordSession, useSessionInPage, type TestSession } from './helpers/api';

// Batch 53.1: Import from Kaarbar → Step 1 · Old products.
// On "Needs you" a row must stay while its buying price is typed one key at
// a time (it used to vanish after the first digit) and after its product is
// picked; it leaves only when the filter is changed. Each item is its own
// card. Every kaarbar_* call is answered in the browser: nothing is saved.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the test admin account in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-53-1-screens';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

type Cell = { value: string | number | null; type?: typeof Number | typeof String } | null;
const text = (value: string): Cell => ({ value, type: String });
const num = (value: number): Cell => ({ value, type: Number });

async function itemListFile(): Promise<Buffer> {
  const rows: Cell[][] = [
    [text('Item List Report'), null],
    [text('Item Name'), text('Purchase Price')],
    [text('Test Night Cream'), num(0)],
    [text('Test Old Serum Discontinued'), num(350)],
    [text('Test Mystery Balm'), num(0)],
  ];
  return writeXlsxFile(rows, { sheet: 'Item List' }).toBuffer();
}

const P = (n: number) => `00000000-0000-4000-8000-00000000053${n}`;
const CHOICES = [
  { product_id: P(3), variant_id: P(7), name: 'Test Night Cream', option: '50 ml', is_active: true, stock_unit: 'pcs', pack_size: 1, cost_per_pack: 900, made_by_import: false },
  { product_id: P(3), variant_id: P(8), name: 'Test Night Cream', option: '100 ml', is_active: true, stock_unit: 'pcs', pack_size: 1, cost_per_pack: 1600, made_by_import: false },
];

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function answerKaarbar(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/rpc\/kaarbar_/, async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'kaarbar_status') {
      return json(route, { start_date: '2026-11-13', today: '2026-11-20', locked_months: [], bill_nos: [], last_customers: null, last_expenses: null });
    }
    if (name === 'kaarbar_old_sales_status') {
      return json(route, { cutoff: '2026-09-30', items: [], choices: CHOICES, bill_keys: [], bills: 0, locked_months: [], last_products: null, last_sales: null });
    }
    return route.abort();
  });
}

async function openWithFile(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => window.localStorage.setItem('theme', 'light'));
  await answerKaarbar(page);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=kaarbar');
  await expect(page.locator('.adm-page-header__title')).toHaveText('Import from Kaarbar', { timeout: 30_000 });
  await page.getByTestId('kb-products-file').setInputFiles({ name: 'Item List Report.xlsx', mimeType: XLSX, buffer: await itemListFile() });
  await expect(page.getByTestId('kb-products-preview')).toBeVisible({ timeout: 15_000 });
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
}

test('Needs you: a row stays while its price is typed key by key and after its product is picked; it leaves when the filter changes', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithFile(page, 390);
  const rows = page.getByTestId('kb-item-row');
  const row = (name: string) => rows.filter({ hasText: name });
  const needsChip = page.getByRole('button', { name: /^Needs you/ });

  // Starts on "Needs you": the two items with no buying price.
  await expect(rows).toHaveCount(2);
  const balm = row('Test Mystery Balm');
  await expect(balm.getByTestId('kb-item-done')).toHaveCount(0);

  // Typed one key at a time, as a person types (fill() types it all at once,
  // which is why the old tests never saw the row vanish).
  await balm.getByTestId('kb-item-price').pressSequentially('1100');
  await expect(rows).toHaveCount(2);
  await expect(balm.getByTestId('kb-item-price')).toHaveValue('1100');
  await expect(balm.getByTestId('kb-item-price')).toHaveAttribute('aria-invalid', 'false');
  await expect(balm.getByTestId('kb-item-done')).toHaveText('Done');
  await expect(needsChip).toContainText('1');

  // Picking a product (which brings its buying price) does not hide the row either.
  await row('Test Night Cream').getByTestId('kb-item-pick').click();
  const picker = page.getByTestId('kb-picker');
  await picker.getByTestId('kb-picker-choice').filter({ hasText: '100 ml' }).click();
  await expect(picker).toBeHidden();
  await expect(rows).toHaveCount(2);
  await expect(row('Test Night Cream')).toContainText('Test Night Cream — 100 ml');
  await expect(row('Test Night Cream').getByTestId('kb-item-price')).toHaveValue('1600');
  await expect(row('Test Night Cream').getByTestId('kb-item-done')).toHaveText('Done');
  await expect(needsChip).toContainText('0');

  // Filter away and back: the finished rows are gone from "Needs you".
  await page.getByRole('button', { name: /^All/ }).click();
  await expect(rows).toHaveCount(3);
  await needsChip.click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('Nothing needs you.')).toBeVisible();
  // Nothing typed was lost.
  await page.getByRole('button', { name: /^All/ }).click();
  await expect(row('Test Mystery Balm').getByTestId('kb-item-price')).toHaveValue('1100');
});

for (const width of [1280, 390, 360] as const) {
  test(`each item is its own card at ${width} px (light)`, async ({ page }) => {
    test.setTimeout(90_000);
    await openWithFile(page, width);
    const rows = page.getByTestId('kb-item-row');
    const balm = rows.filter({ hasText: 'Test Mystery Balm' });
    const cream = rows.filter({ hasText: 'Test Night Cream' });
    // One card being typed into ("11"), the other still missing its price.
    await balm.getByTestId('kb-item-price').pressSequentially('11');
    await expect(rows).toHaveCount(2);
    await expect(balm.getByTestId('kb-item-done')).toBeVisible();
    await expect(cream.getByTestId('kb-item-price')).toHaveAttribute('aria-invalid', 'true');

    // Each item has its own border.
    const border = await balm.evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(border).toBe('1px');

    const name = await balm.locator('.kb-item__name').boundingBox();
    const pick = await balm.getByTestId('kb-item-pick').boundingBox();
    const price = await balm.getByTestId('kb-item-price').boundingBox();
    const card = await balm.boundingBox();
    if (!name || !pick || !price || !card) throw new Error('card parts not on screen');
    if (width >= 768) {
      // Name | site product | price side by side on one line.
      expect(name.x + name.width).toBeLessThanOrEqual(pick.x);
      expect(pick.x + pick.width).toBeLessThanOrEqual(price.x);
      expect(Math.abs(pick.y + pick.height - (price.y + price.height))).toBeLessThan(4);
    } else {
      // Stacked top to bottom, nothing cut off.
      expect(name.y + name.height).toBeLessThanOrEqual(pick.y);
      expect(pick.y + pick.height).toBeLessThanOrEqual(price.y);
    }
    for (const box of [name, pick, price]) expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
    await noSidewaysScroll(page);
    if (width !== 360) await page.getByTestId('kb-items').screenshot({ path: `${SHOTS}/products-${width}-light.png` });
  });
}
