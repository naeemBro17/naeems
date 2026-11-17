import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import writeXlsxFile from 'write-excel-file/node';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, rpc, select, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 45: inventory clean-up — stock comes back, weight out of cost,
// every sale has a stored cost, free edit / delete of every lot, Stock
// check, Set buying prices, the compact lot form, Excel rows, receipts,
// New order's size picker.
//
// The live shop is never changed:
//   - the database rules run in e2e/sql/batch-45-inventory.sql together with
//     the whole Batch 45 migration, inside ONE transaction that is always
//     rolled back (Inventory mode is switched there only);
//   - the screens are checked at 390 px; nothing is saved (no lot, no
//     order). Functions the migration adds are answered in the browser
//     until Naeem has run it;
//   - the receipt test runs only once the migration is live, with its own
//     tiny file, which it deletes.
// Steadfast is mocked by ./fixtures; no real Storage file is downloaded.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-45-screens';
const WIDTH = 390;

let admin: TestSession;

interface Unit {
  product_id: string;
  variant_id: string | null;
  sku: string;
  product_name: string;
  option_label: string | null;
  is_active: boolean;
}

let units: Unit[] = [];

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  const res = await rpc<Unit[]>(admin.accessToken, 'inventory_stock_units');
  units = (res.data ?? []).filter((u) => u.is_active);
});

async function adminAt(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto(path);
}

async function shot(page: Page, name: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true });
}

async function mockRpc(page: Page, fn: string, reply: unknown): Promise<void> {
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(reply) });
  });
}

function unitName(u: Unit): string {
  return u.option_label ? `${u.product_name} — ${u.option_label}` : u.product_name;
}

/* ------------------------------------------------- the database rules */

test('database: stock comes back (mode On and Off, lots, packs, options, own size, edits, oversell, deleted lot), no weight in cost, stored cost of every sale, free lot edit / delete incl. L-000 (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const migration = readFileSync('supabase/migration-046-batch45-inventory.sql', 'utf8').replace(/\r\n/g, '\n');
  const body = migration.slice(migration.indexOf('\nBEGIN;\n') + 8, migration.lastIndexOf('\nCOMMIT;\n'));
  const tests = readFileSync('e2e/sql/batch-45-inventory.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${body}\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(40);
  // Nothing of it stayed.
  const left = await select<unknown[]>(admin.accessToken, 'products?select=id&sku=like.E2E-B45-*');
  expect(left.data).toHaveLength(0);
});

/* ------------------------------------------------- the lot form (390) */

test('New lot at 390 px: compact rows (Qty · Buying price · Expiry), typing keeps the keyboard, Save lot is the only orange element', async ({ page }) => {
  test.setTimeout(120_000);
  const unit = units.find((u) => u.option_label === null);
  expect(unit, 'a product to add').toBeTruthy();
  await adminAt(page, '/admin?tab=inventory&inv=new');
  const search = page.getByLabel('Search product to add');
  await expect(search).toBeVisible({ timeout: 20_000 });
  await search.fill(unit!.product_name.slice(0, 20));
  await page.getByTestId('inv-picker').locator('.picker-sheet__row').filter({ hasText: unit!.product_name }).first().click();
  const row = page.getByTestId('inv-item');
  await expect(row).toHaveCount(1);
  const price = row.getByLabel(/Buying price per/);
  await price.click();
  await page.keyboard.type('1250.50');
  await expect(price).toBeFocused();
  await expect(price).toHaveValue('1250.50');
  await row.getByLabel(/Expiry of/).fill('03/2027');
  await expect(page.getByTestId('inv-lot-total')).toContainText('৳1,250.50');
  // The three fields sit on one row.
  const boxes = await row.locator('.inv-prow__fields input').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(boxes).size).toBe(1);
  // Only one orange element: Save lot.
  const orange = await page.evaluate(() => {
    const or = getComputedStyle(document.documentElement).getPropertyValue('--adm-or').trim();
    const probe = document.createElement('div');
    probe.style.color = or || '#f2592a';
    document.body.appendChild(probe);
    const target = getComputedStyle(probe).color;
    probe.remove();
    return [...document.querySelectorAll('section.inv *')].filter((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (s.backgroundColor === target || s.color === target);
    }).length;
  });
  expect(orange).toBe(1);
  await expect(page.getByTestId('inv-save-lot')).toHaveText('Save lot');
  await shot(page, '01-new-lot-1-product.png');
});

test('Import from Excel: 15 good rows go into the form (nothing saved); an unknown product and a bad date are listed with the reason', async ({ page }) => {
  test.setTimeout(120_000);
  const pick = units.slice(0, 15);
  expect(pick.length).toBe(15);
  const header = ['SKU', 'Product', 'Qty', 'Buying price', 'Expiry (MM/YYYY)'];
  const rows = [
    header.map((value) => ({ value })),
    ...pick.map((u, i) => [
      { value: u.option_label ? '' : u.sku },
      { value: unitName(u) },
      { value: i + 1, type: Number },
      { value: 100 + i, type: Number },
      { value: '06/2027' },
    ]),
    [{ value: 'E2E-NOPE' }, { value: 'E2E B45 not a product' }, { value: 1, type: Number }, { value: 10, type: Number }, { value: '' }],
    [{ value: '' }, { value: unitName(pick[0]) }, { value: 2, type: Number }, { value: 10, type: Number }, { value: '13/2027' }],
  ];
  const buffer = await writeXlsxFile(rows, { sheet: 'Lot' }).toBuffer();
  await adminAt(page, '/admin?tab=inventory&inv=new');
  await expect(page.getByTestId('inv-import')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('inv-import-input').setInputFiles({ name: 'lot.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
  await expect(page.getByTestId('inv-item')).toHaveCount(15, { timeout: 15_000 });
  const problems = page.getByTestId('inv-import-problems');
  await expect(problems).toContainText('2 rows not added');
  await expect(problems).toContainText('Product not found');
  await expect(problems).toContainText('Expiry "13/2027"');
  await expect(page.getByTestId('inv-item').nth(14).getByLabel(/Expiry of/)).toHaveValue('06/2027');
  await shot(page, '02-new-lot-15-products-from-excel.png');
});

/* ---------------------------------------------- New order size picker */

test('New order: a product with options shows once; the picker adds the chosen size and quantity', async ({ page }) => {
  test.setTimeout(120_000);
  const withOptions = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id&limit=50');
  const ids = [...new Set((withOptions.data ?? []).map((v) => v.product_id))];
  const found = await select<{ id: string; name: string }[]>(null, `products_view?select=id,name&is_active=eq.true&id=in.(${ids.join(',')})&limit=1`);
  const product = found.data?.[0];
  test.skip(!product, 'No active product with options in the shop.');
  await adminAt(page, '/admin/orders/new');
  const search = page.getByPlaceholder('Search product name...');
  await expect(search).toBeVisible({ timeout: 20_000 });
  await search.fill(product!.name);
  const results = page.getByTestId('manual-product-result').filter({ hasText: product!.name });
  await expect(results).toHaveCount(1);
  await expect(results).toContainText('sizes');
  await results.click();
  const picker = page.getByTestId('manual-option-picker');
  await expect(picker).toBeVisible();
  const options = picker.getByTestId('manual-option');
  expect(await options.count()).toBeGreaterThanOrEqual(2);
  await expect(picker.getByTestId('manual-pick-add')).toBeDisabled();
  await options.nth(1).click();
  await picker.getByRole('button', { name: 'One more' }).click();
  await expect(picker.getByTestId('manual-pick-qty')).toHaveText('2');
  await page.screenshot({ path: `${SHOTS}/03-new-order-size-picker.png` });
  const chosen = (await options.nth(1).locator('.manual-pick__name').textContent())?.trim() ?? '';
  await picker.getByTestId('manual-pick-add').click();
  const line = page.locator('.manual-order-lines .checkout-cart__row').filter({ hasText: product!.name });
  await expect(line).toHaveCount(1);
  await expect(line).toContainText(chosen);
  await shot(page, '04-new-order-size-added.png');
});

/* ------------------------------------- Stock check and buying prices */

test('Stock check (read only): each line with its reason, the two numbers and a link; "Everything matches" when empty', async ({ page }) => {
  test.setTimeout(90_000);
  const u = units[0];
  await mockRpc(page, 'inventory_stock_check', [
    { product_id: u.product_id, variant_id: null, label: 'CeraVe Foaming Cleanser Eco-Recharge Refill 473mL', reason_code: 'no_lot', reason: 'In stock in the shop but has no lot at all', shop_number: 1, lot_number: 0, lot_id: null, lot_code: null },
    { product_id: u.product_id, variant_id: null, label: 'The Ordinary Niacinamide 10% + Zinc 1% 30ml', reason_code: 'shop_differs', reason: 'Shop stock differs from the units left in its lots', shop_number: 5, lot_number: 7, lot_id: null, lot_code: null },
    { product_id: u.product_id, variant_id: null, label: 'Scalpe Plus Expert Anti-Dandruff Shampoo', reason_code: 'sold_no_lot', reason: 'Units were sold with no lot behind them', shop_number: null, lot_number: 1, lot_id: null, lot_code: null },
  ]);
  await adminAt(page, '/admin?tab=inventory&inv=check');
  const list = page.getByTestId('inv-stock-check');
  await expect(list).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('inv-check-row')).toHaveCount(3);
  await expect(list).toContainText('Shop: 1 · Lots: none');
  await expect(list).toContainText('Shop: 5 · Lots: 7');
  await expect(list.getByRole('link', { name: 'Open product' }).first()).toHaveAttribute('href', new RegExp(`/admin/products/${u.product_id}/edit`));
  await shot(page, '05-stock-check.png');
  await page.unroute(/\/rest\/v1\/rpc\/inventory_stock_check/);
  await mockRpc(page, 'inventory_stock_check', []);
  await page.reload();
  await expect(page.getByText('Everything matches')).toBeVisible({ timeout: 20_000 });
});

test('Set buying prices: sold products first with units sold, one Save all, typing never closes the keyboard', async ({ page }) => {
  test.setTimeout(90_000);
  const [a, b, c] = units;
  const sent: unknown[] = [];
  await mockRpc(page, 'inventory_missing_buying_prices', [
    { product_id: a.product_id, variant_id: a.variant_id, label: unitName(a), stock_unit: 'pcs', pack_size: 1, units_sold: 12, items_missing: 9 },
    { product_id: b.product_id, variant_id: b.variant_id, label: unitName(b), stock_unit: 'pcs', pack_size: 400, units_sold: 0, items_missing: 0 },
    { product_id: c.product_id, variant_id: c.variant_id, label: unitName(c), stock_unit: 'pcs', pack_size: 1, units_sold: 0, items_missing: 0 },
  ]);
  await page.route(/\/rest\/v1\/rpc\/inventory_set_buying_prices/, async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saved: 1, items_filled: 9 }) });
  });
  await adminAt(page, '/admin?tab=inventory&inv=prices');
  await expect(page.getByTestId('inv-bp-count')).toHaveText('3 products still need a buying price', { timeout: 20_000 });
  const rows = page.getByTestId('inv-bp-row');
  await expect(rows.first()).toContainText('12 sold');
  await expect(rows.nth(1)).toContainText('per pcs (1 pack = 400 pcs)');
  const input = rows.first().locator('input');
  await input.click();
  await page.keyboard.type('795');
  await expect(input).toBeFocused();
  await shot(page, '06-set-buying-prices.png');
  await page.getByTestId('inv-bp-save').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ p_rows: [{ product_id: a.product_id, variant_id: a.variant_id, price: '795' }] });
});

/* -------------------------------------------- the lot page (L-000) */

test('Lot page: L-000 has Edit and Delete like any lot; one confirmation says what will happen; no weight anywhere', async ({ page }) => {
  test.setTimeout(90_000);
  const lots = await select<{ id: string }[]>(admin.accessToken, 'lots?select=id&code=eq.L-000');
  const id = lots.data?.[0]?.id;
  test.skip(!id, 'No L-000 in this shop.');
  await mockRpc(page, 'inventory_lot_delete_info', { code: 'L-000', units_left: 120, orders: 3, receipts: 0 });
  await adminAt(page, `/admin?tab=inventory&inv=lot&lot=${id}`);
  await expect(page.getByTestId('inv-lot-totals')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('section.inv')).not.toContainText(/weight/i);
  await page.getByRole('button', { name: /More actions/ }).first().click();
  await expect(page.getByRole('menuitem', { name: 'Edit lot' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete lot' }).click();
  await expect(page.getByTestId('inv-delete-text')).toHaveText(
    'Delete lot L-000? 120 units leave stock. 3 orders were sold from this lot — the orders stay. This can’t be undone.'.replace('’', "'")
  );
  await shot(page, '07-delete-lot-confirmation.png');
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByTestId('inv-delete-text')).toHaveCount(0);
});

/* --------------------------------------------------------- receipts */

test('Receipts: a tiny photo is made small, listed by name, opened only when tapped, then deleted', async ({ page }) => {
  test.setTimeout(120_000);
  const ready = await select<unknown[]>(admin.accessToken, 'lot_receipts?select=id&limit=1');
  test.skip(!ready.ok, 'The Batch 45 database step (lot_receipts) has not been run yet.');
  const lots = await select<{ id: string }[]>(admin.accessToken, 'lots?select=id&order=created_at.desc&limit=1');
  const id = lots.data?.[0]?.id;
  test.skip(!id, 'No lot to attach a receipt to.');
  await adminAt(page, `/admin?tab=inventory&inv=lot&lot=${id}`);
  await expect(page.getByTestId('inv-add-receipt')).toBeVisible({ timeout: 20_000 });
  // A 2 × 2 px PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4GBgYEJAA0SAQGdu2VcAAAAAElFTkSuQmCC', 'base64');
  await page.getByTestId('inv-receipt-input').setInputFiles({ name: 'e2e-b45-receipt.png', mimeType: 'image/png', buffer: png });
  const row = page.getByTestId('inv-receipt').filter({ hasText: 'e2e-b45-receipt.webp' });
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  const saved = await select<{ id: string; path: string; size_bytes: number }[]>(admin.accessToken, `lot_receipts?select=id,path,size_bytes&lot_id=eq.${id}&file_name=eq.e2e-b45-receipt.webp`);
  const receipt = saved.data?.[0];
  try {
    // Made small in the browser; the list shows names only (no file is
    // downloaded until a name is tapped).
    expect(receipt?.size_bytes ?? 0).toBeGreaterThan(0);
    expect(receipt?.size_bytes ?? 0).toBeLessThan(300 * 1024);
  } finally {
    await row.getByRole('button', { name: /Delete/ }).click();
    await page.getByTestId('inv-receipt-delete-yes').click();
    await expect(row).toHaveCount(0, { timeout: 20_000 });
  }
  const after = await select<unknown[]>(admin.accessToken, `lot_receipts?select=id&lot_id=eq.${id}&file_name=eq.e2e-b45-receipt.webp`);
  expect(after.data).toHaveLength(0);
});
