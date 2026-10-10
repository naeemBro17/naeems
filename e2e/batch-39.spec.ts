import { mkdirSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import {
  insert,
  passwordSession,
  pickStockedProduct,
  placeTestOrder,
  productStock,
  remove,
  rpc,
  select,
  useSessionInPage,
  type TestSession,
} from './helpers/api';
import { runSql, sqlError, sqlSteps, supabaseCli, testResult } from './helpers/sqlRunner';
import { OPENING_COLUMNS } from '../src/lib/inventory/opening';

// Batch 39: units, sales from lots, profit, the Inventory mode switch.
//
// Inventory mode stays OFF on the live shop the whole time:
//   - the sales-from-lots logic runs in e2e/sql/batch-39-inventory.sql,
//     inside ONE database transaction that is always undone, with Inventory
//     mode switched on for that transaction only;
//   - "two orders at the same moment" (e2e/sql/batch-39-lock.sql) uses two
//     real sessions on a hidden throwaway product, removed afterwards;
//   - the screens are checked at phone width on hidden test products
//     (SKU "E2E-B39-…"), test lots, a test supplier and test orders, all
//     removed in afterAll. Steadfast is mocked by ./fixtures.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-39-screens';
const SKU_PREFIX = 'E2E-B39-';
const SUPPLIER = 'E2E B39 supplier';
const FISH = 'E2E B39 Fish Oil 1000mg';

let admin: TestSession;
let customer: TestSession;
let fishId = '';
let realOpeningExists = false;
const orderIds: string[] = [];

async function freshAdmin(): Promise<void> {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
}

async function withLock<T>(work: () => Promise<T>): Promise<T> {
  await freshAdmin();
  const opened = await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 120 });
  expect(opened.ok, opened.error ?? '').toBe(true);
  try {
    return await work();
  } finally {
    await rpc(admin.accessToken, 'admin_close_delete_lock');
  }
}

async function adminAt(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 360, height: 800 });
  await useSessionInPage(page, admin);
  await page.goto(path);
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function shot(page: Page, name: string): Promise<void> {
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true });
}

/** Removes the test lots, products, supplier and orders. */
async function cleanUp(): Promise<void> {
  await freshAdmin();
  const lots = await select<{ id: string; supplier: string; kind: string }[]>(admin.accessToken, 'lots?select=id,supplier,kind');
  const mine = (lots.data ?? []).filter((l) => l.kind === 'purchase' && l.supplier.startsWith(SUPPLIER));
  if (mine.length > 0 || orderIds.length > 0) {
    await withLock(async () => {
      if (orderIds.length > 0) await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: orderIds });
      for (const lot of mine) {
        const res = await rpc(admin.accessToken, 'inventory_delete_lot', { p_lot_id: lot.id });
        expect(res.ok, res.error ?? '').toBe(true);
      }
    });
  }
  orderIds.length = 0;
  await remove(admin.accessToken, `products?sku=like.${SKU_PREFIX}*`);
  const suppliers = await select<{ id: string; name: string }[]>(admin.accessToken, 'suppliers?select=id,name');
  for (const s of suppliers.data ?? []) {
    if (s.name.startsWith(SUPPLIER)) await rpc(admin.accessToken, 'inventory_delete_supplier', { p_id: s.id });
  }
}

test.beforeAll(async () => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  await cleanUp();
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  const lots = await select<{ kind: string }[]>(admin.accessToken, 'lots?select=kind&kind=eq.opening');
  realOpeningExists = (lots.data ?? []).length > 0;
  const sku = `${SKU_PREFIX}F-${Date.now() % 100000}`;
  const created = await insert(
    admin.accessToken,
    'products',
    { sku, slug: `e2e-b39-f-${Date.now() % 100000}`, name: FISH, retail_price: 2000, stock_status: 'in_stock', stock_quantity: 0, is_active: false },
    false
  );
  expect(created.ok, created.error ?? '').toBe(true);
  const row = await select<{ id: string }[]>(admin.accessToken, `products?select=id&sku=eq.${sku}`);
  fishId = row.data![0].id;
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  await cleanUp();
  const mode = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.inventory_mode');
  expect(mode.data?.[0]?.value).toBe('false');
});

/* ------------------------------------------------- the database logic */

test('database: units, earliest expiry first, cancel / return / edits, sell without stock, late bill, profit, permissions, the switch (Inventory mode on in one undone transaction)', async () => {
  test.setTimeout(240_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const script = readFileSync('e2e/sql/batch-39-inventory.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(script);
  const results = testResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(60);
  // Nothing of it stayed: the live switch is still Off, no test product left.
  const mode = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.inventory_mode');
  expect(mode.data?.[0]?.value).toBe('false');
  const left = await select<unknown[]>(admin.accessToken, 'products?select=id&sku=like.E2E-B39-A-*');
  expect(left.data).toHaveLength(0);
});

test('two orders at the same moment can never take the same units', async () => {
  test.setTimeout(180_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const steps = sqlSteps(readFileSync('e2e/sql/batch-39-lock.sql', 'utf8'), { TAG: String(Date.now() % 100_000_000) });
  try {
    expect(sqlError(await runSql(steps.setup))).toBeNull();
    const first = runSql(steps.first);
    await new Promise((r) => setTimeout(r, 2500));
    const second = runSql(steps.second);
    const [a, b] = await Promise.all([first, second]);
    expect(sqlError(a)).toBeNull();
    const race = testResult<{ second: string; waited_ms: number }>(b);
    expect(race, `second session said: ${b.slice(0, 600)}`).not.toBeNull();
    // The second order waited for the first one's lock, then found 1 unit.
    expect(race?.second).toMatch(/^Only 0 of .* left in stock\.$/);
    expect(race?.waited_ms ?? 0).toBeGreaterThan(1000);
    const check = testResult<{ left: number; ledger: number; taken_a: number; taken_b: number; log: number }>(await runSql(steps.check));
    expect(check).toEqual({ left: 1, ledger: 1, taken_a: 2, taken_b: 0, log: 1 });
  } finally {
    expect(sqlError(await runSql(steps.cleanup))).toBeNull();
  }
});

/* ------------------------------------------------------------ screens */

test('Part 0: pack size in the product editor (staff only, never public)', async ({ page }) => {
  test.setTimeout(90_000);
  await adminAt(page, `/admin/products/${fishId}/edit`);
  const panel = page.getByTestId('pack-size-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await panel.getByLabel('Stock unit of This product').selectOption('pcs');
  await panel.getByLabel('Pack size of This product').fill('400');
  await panel.scrollIntoViewIfNeeded();
  await shot(page, '01-pack-size.png');
  await panel.getByTestId('pack-size-save').click();
  await expect(page.getByText('Pack size saved')).toBeVisible({ timeout: 15_000 });
  const packs = await rpc<{ product_id: string; stock_unit: string; pack_size: number }[]>(admin.accessToken, 'inventory_pack_units');
  expect(packs.data?.find((p) => p.product_id === fishId)).toMatchObject({ stock_unit: 'pcs', pack_size: 400 });
  // The shop (anon) can't read it.
  const anon = await select<unknown[]>(null, `products?select=pack_size&id=eq.${fishId}`);
  expect(anon.ok).toBe(false);
});

test('Part 0 + 1: lot form — packs or units, no currency, supplier list with "+ Add new", weight guessed from price', async ({ page }) => {
  test.setTimeout(120_000);
  await adminAt(page, '/admin?tab=inventory&inv=new');
  await expect(page.getByRole('heading', { name: 'New lot' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Exchange rate')).toHaveCount(0);
  await expect(page.getByLabel('Currency')).toHaveCount(0);

  await page.getByLabel('Supplier', { exact: true }).selectOption({ label: '+ Add new' });
  await page.getByLabel('New supplier name').fill(`${SUPPLIER} UI`);
  await page.getByTestId('inv-add-supplier').click();
  await expect(page.getByLabel('Supplier', { exact: true })).not.toHaveValue('', { timeout: 15_000 });

  await page.getByLabel('Search product to add').fill(FISH);
  await page.getByTestId('inv-picker').getByRole('button').first().click();
  const item = page.getByTestId('inv-item');
  await expect(item.getByTestId('inv-entry-unit')).toBeVisible();
  await item.getByRole('button', { name: 'Units (pcs)' }).click();
  await page.getByLabel(`Pieces of ${FISH}`).fill('250');
  await page.getByLabel(`Buy price of ${FISH}`).fill('3');
  await expect(item.getByTestId('inv-item-units')).toHaveText('= 250 pcs in stock');
  await item.getByRole('button', { name: 'Packs (400 pcs)' }).click();
  await page.getByLabel(`Pieces of ${FISH}`).fill('2');
  await page.getByLabel(`Buy price of ${FISH}`).fill('1200');
  await expect(item.getByTestId('inv-item-units')).toHaveText('= 800 pcs in stock');
  await page.getByTestId('inv-add-weight-cost').click();
  await page.getByLabel('Weight cost amount').fill('100');
  // No weight on the product: the weight cost is shared by price.
  await expect(item.getByTestId('inv-weight-guessed')).toBeVisible();
  await expect(page.getByTestId('inv-allocated-ok')).toBeVisible();
  await expect(item.getByTestId('inv-item-calc')).toContainText('= ৳3.13 per pcs');
  await shot(page, '02-lot-form-units.png');
  await page.getByTestId('inv-save-lot').click();

  await expect(page.getByTestId('inv-lot-details')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('inv-detail-guessed')).toBeVisible();
  await shot(page, '03-lot-detail-units.png');
  const rows = await select<{ qty: number; qty_remaining: number; landed_unit_cost_bdt: number; entry_unit: string; pack_size: number; weight_guessed: boolean }[]>(
    admin.accessToken,
    `lot_items?select=qty,qty_remaining,landed_unit_cost_bdt,entry_unit,pack_size,weight_guessed&product_id=eq.${fishId}`
  );
  expect(rows.data).toEqual([{ qty: 800, qty_remaining: 800, landed_unit_cost_bdt: 3.125, entry_unit: 'pack', pack_size: 400, weight_guessed: true }]);
  // Inventory mode is Off: the shop's stock number did not move.
  const product = await select<{ stock_quantity: number }[]>(admin.accessToken, `products?select=stock_quantity&id=eq.${fishId}`);
  expect(product.data?.[0]?.stock_quantity).toBe(0);
});

test('Part 0: opening stock template has stock_unit, pack_size and extra_units', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(realOpeningExists, 'A real opening stock exists; the template screen is not used for tests.');
  await adminAt(page, '/admin?tab=inventory&inv=opening');
  const downloadWait = page.waitForEvent('download');
  await page.getByTestId('inv-download-template').click();
  const download = await downloadWait;
  const path = `test-results/b39-template-${Date.now()}.xlsx`;
  await download.saveAs(path);
  const sheets = (await readXlsxFile(path)) as unknown as { sheet: string; data: unknown[][] }[];
  const sheet = sheets.find((s) => s.sheet === 'Opening stock');
  expect(sheet?.data[0]).toEqual([...OPENING_COLUMNS]);
  const header = sheet!.data[0] as string[];
  const fishRow = sheet!.data.find((r) => r[0] === fishId);
  expect(fishRow?.[header.indexOf('stock_unit')]).toBe('pcs');
  expect(fishRow?.[header.indexOf('pack_size')]).toBe(400);
  const howTo = sheets.find((s) => s.sheet === 'How to fill');
  expect(JSON.stringify(howTo?.data)).toContain('extra_units');
});

test('Parts 2–4: Sold without stock, Sales profit and the Inventory mode check screen at phone width', async ({ page }) => {
  test.setTimeout(120_000);
  await adminAt(page, '/admin?tab=inventory');
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('inv-mode-note')).toContainText('Inventory mode: Off');
  await shot(page, '04-inventory-home.png');

  await page.getByRole('button', { name: 'Sold without stock', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sold without stock' })).toBeVisible();
  await shot(page, '05-sold-without-stock.png');

  await page.goto('/admin?tab=inventory&inv=profit');
  await expect(page.getByTestId('inv-profit-totals')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('inv-profit-total')).toContainText('Profit');
  await shot(page, '06-sales-profit-today.png');
  await page.getByRole('button', { name: 'This month', exact: true }).click();
  await expect(page.getByTestId('inv-profit-totals')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await expect(page.getByLabel('From date')).toBeVisible();

  await page.goto('/admin?tab=inventory&inv=mode');
  await expect(page.getByTestId('inv-mode-status')).toContainText('Inventory mode: Off', { timeout: 20_000 });
  await expect(page.getByTestId('inv-mode-packs')).toContainText(FISH);
  await expect(page.getByTestId('inv-mode-sellout')).toBeVisible();
  if (!realOpeningExists) {
    await expect(page.getByTestId('inv-mode-opening')).toHaveText('Not confirmed yet');
    await expect(page.getByTestId('inv-mode-turn-on')).toBeDisabled();
  }
  await shot(page, '07-inventory-mode-check.png');

  // Settings shows the state and opens the check screen.
  await page.goto('/admin?tab=settings&sset=inventory');
  await expect(page.getByTestId('inventory-mode-switch')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('inventory-mode-open').click();
  await expect(page.getByTestId('inv-mode-status')).toBeVisible({ timeout: 20_000 });
});

test('Part 2.5 + 3: order page — Profit box, Mark returned puts the stock back (Inventory mode Off)', async ({ page }) => {
  test.setTimeout(150_000);
  const product = await pickStockedProduct(3);
  const before = await productStock(product.id);
  const order = await placeTestOrder(customer.accessToken, product.id, 1);
  orderIds.push(order.id);
  expect(await productStock(product.id)).toBe(before - 1);
  const shipped = await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: order.id, p_new_status: 'shipped', p_note: 'e2e b39' });
  expect(shipped.ok, shipped.error ?? '').toBe(true);

  await adminAt(page, `/admin/orders/${order.orderNumber}`);
  const profit = page.getByTestId('order-profit');
  await expect(profit).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('order-profit-no-cost')).toContainText('No cost (before inventory)');
  await profit.scrollIntoViewIfNeeded();
  await shot(page, '08-order-profit-box.png');

  await page.getByTestId('careful-return').click();
  await expect(page.getByTestId('return-effects')).toContainText('1 item goes back to stock');
  await page.getByTestId('confirm-sheet-input').fill(order.orderNumber.replace(/\D/g, ''));
  await shot(page, '09-mark-returned.png');
  await page.getByTestId('confirm-sheet-confirm').click();
  await expect(page.getByTestId('order-step-label')).toHaveText('Returned', { timeout: 20_000 });
  expect(await productStock(product.id)).toBe(before);
  const saved = await select<{ status: string; stock_released: boolean }[]>(admin.accessToken, `orders?select=status,stock_released&id=eq.${order.id}`);
  expect(saved.data?.[0]).toEqual({ status: 'returned', stock_released: true });
  await shot(page, '10-order-returned.png');
});

test('Part 0.6: manual order — a product with a pack size can be sold in loose units at its own price', async ({ page }) => {
  test.setTimeout(120_000);
  const product = await pickStockedProduct(1);
  // Only this browser sees the product as a 400 pcs pack (nothing is saved).
  await page.route(/\/rest\/v1\/rpc\/inventory_pack_units/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ product_id: product.id, variant_id: null, stock_unit: 'pcs', pack_size: 400 }]) })
  );
  await adminAt(page, '/admin/orders/new');
  const search = page.getByPlaceholder('Search product name...');
  await expect(search).toBeVisible({ timeout: 20_000 });
  await search.fill(product.name);
  await page.locator('.picker-sheet__list .picker-sheet__row').first().click();
  const chooser = page.getByTestId('line-sold-unit');
  await expect(chooser).toBeVisible();
  await chooser.getByRole('button', { name: 'Loose pcs' }).click();
  await page.getByTestId('line-units-input').fill('150');
  await expect(page.getByTestId('line-units-note')).toContainText('while Inventory mode is Off');
  await shot(page, '11-manual-order-loose-units.png');
});
