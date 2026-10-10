import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_MOD_PASSWORD, E2E_PASSWORD } from './helpers/env';
import { callFunction, insert, passwordSession, remove, rpc, select, update, upsertSettings, useSessionInPage, type TestSession } from './helpers/api';
import {
  TEST_OPENING_FILE,
  TEST_PREFIX,
  TEST_SKU_PREFIX,
  TEST_SUPPLIER,
  importLot,
  openingFile,
  openingRow,
  wholesaleLot,
  type TestUnits,
} from './helpers/inventoryFixtures';
import { WEIGHT_CASES } from '../src/test/inventoryCases';
import { allocateLot } from '../src/lib/inventory/allocation';

// Batch 38: inventory lots, landed cost, opening stock. Everything here runs
// on throwaway test products (hidden from shoppers, SKU "E2E-B38-…") and
// test lots (supplier "E2E B38 supplier …"), all deleted in afterAll. Real
// products are never put in a lot. The opening stock part is skipped if a
// real opening stock (L-000) already exists — it is never touched.
// Steadfast is mocked for every page by ./fixtures.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-38-screens';
const STAFF_USERNAME = 'e2e.role38';
const ROLE_NAME = 'E2E Batch38 role';

let admin: TestSession;
let units: TestUnits;
let staffId = '';
let roleId = '';
let startedAt = '';
let realOpeningExists = false;

interface LotRow {
  id: string;
  code: string;
  kind: string;
  notes: string;
  supplier: string;
  opening_weight_added_bdt: number | null;
}
interface ItemRow {
  id: string;
  qty: number;
  qty_remaining: number;
  sort_order: number;
  unit_price_bdt: number;
  alloc_weight_paisa: number;
  alloc_other_paisa: number;
  landed_unit_cost_bdt: number;
  product_id: string;
  variant_id: string | null;
}

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

async function testLots(): Promise<LotRow[]> {
  const res = await select<LotRow[]>(admin.accessToken, 'lots?select=id,code,kind,notes,supplier,opening_weight_added_bdt&order=code');
  return res.data ?? [];
}

/** Removes every test lot, the test opening lot (never a real one), the
 *  test products, and the test staff login and role. */
async function cleanUp(): Promise<void> {
  await freshAdmin();
  const lots = await testLots();
  const purchase = lots.filter((l) => l.kind === 'purchase' && l.supplier.startsWith(TEST_SUPPLIER));
  const opening = lots.find((l) => l.kind === 'opening' && l.notes.includes(TEST_OPENING_FILE));
  if (purchase.length > 0 || opening) {
    await withLock(async () => {
      for (const lot of purchase) {
        const res = await rpc(admin.accessToken, 'inventory_delete_lot', { p_lot_id: lot.id });
        expect(res.ok, res.error ?? '').toBe(true);
      }
      if (opening) {
        const res = await rpc(admin.accessToken, 'inventory_undo_opening');
        expect(res.ok, res.error ?? '').toBe(true);
      }
    });
  }
  await remove(admin.accessToken, `products?sku=like.${TEST_SKU_PREFIX}*`);
  const team = await rpc<{ id: string; username: string }[]>(admin.accessToken, 'admin_team_list');
  for (const member of team.data ?? []) {
    if (member.username === STAFF_USERNAME) await callFunction(admin.accessToken, 'admin-team', { action: 'delete', userId: member.id });
  }
  const roles = await rpc<{ id: string; name: string }[]>(admin.accessToken, 'admin_role_list');
  for (const role of roles.data ?? []) {
    if (role.name === ROLE_NAME) await rpc(admin.accessToken, 'admin_role_delete', { p_id: role.id });
  }
  staffId = '';
  roleId = '';
}

async function makeProduct(n: number, name: string, categoryId: string, stock: number | null): Promise<string> {
  const sku = `${TEST_SKU_PREFIX}${n}-${Date.now() % 100000}`;
  const res = await insert(
    admin.accessToken,
    'products',
    {
      sku,
      slug: `e2e-b38-${n}-${Date.now() % 100000}`,
      name,
      category_id: categoryId,
      retail_price: 1500,
      stock_status: 'in_stock',
      stock_quantity: stock,
      is_active: false,
    },
    false
  );
  expect(res.ok, res.error ?? '').toBe(true);
  const row = await select<{ id: string }[]>(admin.accessToken, `products?select=id&sku=eq.${sku}`);
  return row.data![0].id;
}

/** A test staff login whose role has exactly these switches. */
async function staffWith(permissions: string[]): Promise<TestSession> {
  const role = await rpc<string>(admin.accessToken, 'admin_role_save', { p_id: roleId || null, p_name: ROLE_NAME, p_permissions: permissions });
  expect(role.ok, role.error ?? '').toBe(true);
  roleId = role.data!;
  if (!staffId) {
    const created = await callFunction<{ ok: boolean; userId?: string; error?: string }>(admin.accessToken, 'admin-team', {
      action: 'create',
      username: STAFF_USERNAME,
      fullName: 'E2E Batch38 Staff',
      phone: '01700000038',
      password: E2E_MOD_PASSWORD,
    });
    expect(created.ok, created.error).toBe(true);
    staffId = created.userId!;
    const set = await rpc(admin.accessToken, 'admin_team_set_role', { p_user_id: staffId, p_role_id: roleId });
    expect(set.ok, set.error ?? '').toBe(true);
  }
  return passwordSession(`${STAFF_USERNAME}@staff.naeems.internal`, E2E_MOD_PASSWORD);
}

/** The shop's stock numbers of the test products and option. */
async function testStock(): Promise<string> {
  const p = await select<{ id: string; stock_quantity: number | null; stock_status: string }[]>(
    admin.accessToken,
    `products?select=id,stock_quantity,stock_status&sku=like.${TEST_SKU_PREFIX}*&order=sku`
  );
  const v = await select<{ id: string; stock_quantity: number | null; in_stock: boolean }[]>(
    admin.accessToken,
    `product_variants?select=id,stock_quantity,in_stock&id=eq.${units.serumVariant}`
  );
  return JSON.stringify([p.data, v.data]);
}

async function items(lotId: string): Promise<ItemRow[]> {
  const res = await select<ItemRow[]>(admin.accessToken, `lot_items?select=*&lot_id=eq.${lotId}&order=sort_order`);
  return res.data ?? [];
}

async function movementsSum(itemId: string): Promise<number> {
  const res = await select<{ qty: number }[]>(admin.accessToken, `stock_movements?select=qty&lot_item_id=eq.${itemId}`);
  return (res.data ?? []).reduce((a, m) => a + m.qty, 0);
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function adminAt(page: Page, query: string): Promise<void> {
  await page.setViewportSize({ width: 360, height: 800 });
  await useSessionInPage(page, admin);
  await page.goto(`/admin${query}`);
}

test.beforeAll(async () => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  await cleanUp();
  startedAt = new Date().toISOString();
  const lots = await testLots();
  realOpeningExists = lots.some((l) => l.kind === 'opening');

  const cats = await select<{ id: string }[]>(null, 'categories?select=id&order=name&limit=1');
  const categoryId = cats.data![0].id;
  const cleanser = await makeProduct(1, `${TEST_PREFIX} Cleanser 236ml`, categoryId, 10);
  const toner = await makeProduct(2, `${TEST_PREFIX} Toner`, categoryId, 4);
  const serum = await makeProduct(3, `${TEST_PREFIX} Serum`, categoryId, null);
  const variant = await insert(admin.accessToken, 'product_variants', {
    product_id: serum,
    region: 'AU',
    size: '30 ml',
    retail_price: 2000,
    in_stock: true,
    stock_quantity: 2,
    sort_order: 1,
  }, false);
  expect(variant.ok, variant.error ?? '').toBe(true);
  const variantRow = await select<{ id: string }[]>(admin.accessToken, `product_variants?select=id&product_id=eq.${serum}`);
  units = { cleanser, toner, serum, serumVariant: variantRow.data![0].id };
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  await cleanUp();
});

/* ---------------------------------------------------------------- Part 1 */

test('Part 1: weight estimate — the database and the screens give the same answers; new products are estimated; manual is kept', async () => {
  for (const c of WEIGHT_CASES) {
    const res = await rpc<number | null>(admin.accessToken, 'inventory_estimate_weight', { p_text: c.text });
    expect(res.ok, res.error ?? '').toBe(true);
    expect(res.data === null ? null : Number(res.data), c.text).toBe(c.grams);
  }

  const stock = await rpc<{ product_id: string; variant_id: string | null; weight_grams: number | null; weight_source: string | null }[]>(
    admin.accessToken,
    'inventory_stock_units'
  );
  const byId = (pid: string, vid: string | null = null) => stock.data!.find((u) => u.product_id === pid && u.variant_id === vid);
  expect(byId(units.cleanser)).toMatchObject({ weight_grams: 271, weight_source: 'estimated' }); // 236 ml × 1.15
  expect(byId(units.toner)).toMatchObject({ weight_grams: null, weight_source: null }); // no size → needs weight
  expect(byId(units.serum, units.serumVariant)).toMatchObject({ weight_grams: 35, weight_source: 'estimated' }); // 30 ml

  // A typed weight is 'manual' and a rename never overwrites it.
  const set = await rpc(admin.accessToken, 'inventory_set_weight', { p_product_id: units.cleanser, p_variant_id: null, p_grams: 300 });
  expect(set.ok, set.error ?? '').toBe(true);
  const renamed = await update(admin.accessToken, `products?id=eq.${units.cleanser}&select=id`, { name: `${TEST_PREFIX} Cleanser 473ml` });
  expect(renamed.ok, renamed.error ?? '').toBe(true);
  let after = await rpc<{ product_id: string; variant_id: string | null; weight_grams: number; weight_source: string }[]>(admin.accessToken, 'inventory_stock_units');
  expect(after.data!.find((u) => u.product_id === units.cleanser)).toMatchObject({ weight_grams: 300, weight_source: 'manual' });
  // Empty = back to the estimate (now from the new name: 473 ml ≈ 544 g).
  await rpc(admin.accessToken, 'inventory_set_weight', { p_product_id: units.cleanser, p_variant_id: null, p_grams: null });
  after = await rpc(admin.accessToken, 'inventory_stock_units');
  expect(after.data!.find((u) => u.product_id === units.cleanser)).toMatchObject({ weight_grams: 544, weight_source: 'estimated' });
  const back = await update(admin.accessToken, `products?id=eq.${units.cleanser}&select=id`, { name: `${TEST_PREFIX} Cleanser 236ml` });
  expect(back.ok, back.error ?? '').toBe(true);
});

/* ---------------------------------------------------------------- Part 2 */

test('Part 2: landed cost — missing weight blocks, totals exact to the paisa, late bill re-shares, ledger matches; shop stock unchanged', async () => {
  const stockBefore = await testStock();

  const blocked = await rpc(admin.accessToken, 'inventory_save_lot', { p_lot: importLot(units, null) });
  expect(blocked.ok).toBe(false);
  expect(blocked.error).toContain(`Enter weight for: ${TEST_PREFIX} Toner`);

  const saved = await rpc<string>(admin.accessToken, 'inventory_save_lot', { p_lot: importLot(units, 333) });
  expect(saved.ok, saved.error ?? '').toBe(true);
  const lotId = saved.data!;
  let rows = await items(lotId);
  expect(rows.reduce((a, r) => a + Number(r.alloc_weight_paisa), 0)).toBe(1_000_000); // ৳10,000.00
  expect(rows.reduce((a, r) => a + Number(r.alloc_other_paisa), 0)).toBe(99_999); // ৳999.99

  // The screen's preview works it out exactly the same way.
  const lot = importLot(units, 333);
  const preview = allocateLot(
    lot.items.map((i) => ({ qty: i.qty, unitPriceForeign: i.unit_price_foreign, weightGrams: i.weight_grams, label: i.product_id })),
    lot.costs.map((c) => ({ costType: c.cost_type as 'weight' | 'other', amountBdt: c.amount_bdt })),
    lot.exchange_rate
  );
  expect(preview.ok).toBe(true);
  if (preview.ok) {
    expect(rows.map((r) => Number(r.alloc_weight_paisa))).toEqual(preview.rows.map((r) => Number(r.weightPaisa)));
    expect(rows.map((r) => Number(r.alloc_other_paisa))).toEqual(preview.rows.map((r) => Number(r.otherPaisa)));
    rows.forEach((r, i) => expect(Number(r.landed_unit_cost_bdt)).toBeCloseTo(preview.rows[i].landedUnitBdt, 5));
  }

  // Ledger: pieces left = the sum of the movements.
  for (const r of rows) expect(r.qty_remaining).toBe(await movementsSum(r.id));

  // A late bill (and more pieces of the cleanser) re-shares the lot.
  const costs = await select<{ id: string; cost_type: string; amount_bdt: number; cost_date: string | null; note: string }[]>(
    admin.accessToken,
    `lot_costs?select=id,cost_type,amount_bdt,cost_date,note&lot_id=eq.${lotId}`
  );
  const edited = await rpc<string>(admin.accessToken, 'inventory_save_lot', {
    p_lot: {
      ...lot,
      id: lotId,
      costs_pending: false,
      items: lot.items.map((i, idx) => ({ ...i, id: rows[idx].id, qty: idx === 0 ? 5 : i.qty })),
      costs: [
        ...costs.data!.map((c) => ({ ...c, amount_bdt: String(c.amount_bdt) })),
        { cost_type: 'weight', amount_bdt: '1234.57', cost_date: '2026-10-09', note: 'Late cargo bill' },
      ],
    },
  });
  expect(edited.ok, edited.error ?? '').toBe(true);
  rows = await items(lotId);
  expect(rows.reduce((a, r) => a + Number(r.alloc_weight_paisa), 0)).toBe(1_123_457);
  expect(rows.reduce((a, r) => a + Number(r.alloc_other_paisa), 0)).toBe(99_999);
  expect(rows[0].qty).toBe(5);
  expect(rows[0].qty_remaining).toBe(5);
  for (const r of rows) expect(r.qty_remaining).toBe(await movementsSum(r.id));
  const moves = await select<{ movement_type: string; qty: number; reason: string | null }[]>(
    admin.accessToken,
    `stock_movements?select=movement_type,qty,reason&lot_item_id=eq.${rows[0].id}&order=created_at`
  );
  expect(moves.data!.map((m) => [m.movement_type, m.qty])).toEqual([['purchase', 3], ['purchase', 2]]);

  // Lot 2: wholesale in taka, no weight bill → no weight needed.
  const second = await rpc<string>(admin.accessToken, 'inventory_save_lot', { p_lot: wholesaleLot(units) });
  expect(second.ok, second.error ?? '').toBe(true);

  // Inventory mode is Off: the shop's stock numbers did not move.
  expect(await testStock()).toBe(stockBefore);
  const mode = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.inventory_mode');
  expect(mode.data?.[0]?.value).toBe('false');
});

/* ---------------------------------------------------------------- Part 3 */

test('Part 3: screens at phone width — lots list, new lot with preview, lot detail, needs weight, compare, settings', async ({ page }) => {
  test.setTimeout(120_000);
  const stockBefore = await testStock();
  await adminAt(page, '?tab=inventory');
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('inv-mode-note')).toContainText('Inventory mode: Off');
  await expect(page.getByTestId('inv-lots')).toContainText(`${TEST_SUPPLIER} Sydney`);
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/01-lots-list.png`, fullPage: true });

  // New lot: two products, a weight bill, the toner has no weight yet.
  await page.getByTestId('inv-new-lot').click();
  await expect(page.getByRole('heading', { name: 'New lot' })).toBeVisible();
  await page.getByLabel('Supplier').fill(`${TEST_SUPPLIER} UI`);
  await page.getByLabel('Exchange rate').fill('80');
  const search = page.getByLabel('Search product to add');
  await search.fill(`${TEST_PREFIX} Cleanser`);
  await page.getByTestId('inv-picker').getByRole('button').first().click();
  await search.fill(`${TEST_PREFIX} Toner`);
  await page.getByTestId('inv-picker').getByRole('button').first().click();
  await page.getByLabel(`Pieces of ${TEST_PREFIX} Cleanser 236ml`).fill('2');
  await page.getByLabel(`Buy price of ${TEST_PREFIX} Cleanser 236ml`).fill('10');
  await page.getByLabel(`Pieces of ${TEST_PREFIX} Toner`).fill('1');
  await page.getByLabel(`Buy price of ${TEST_PREFIX} Toner`).fill('5');
  await page.getByTestId('inv-add-weight-cost').click();
  await page.getByLabel('Weight cost amount').fill('500');
  await expect(page.getByTestId('inv-preview')).toContainText(`Enter weight for: ${TEST_PREFIX} Toner`);
  await page.getByLabel(`Weight of ${TEST_PREFIX} Toner`).fill('100');
  await expect(page.getByTestId('inv-allocated-ok')).toHaveText('Allocated total = lot total ✓');
  // 2 × 271 g and 1 × 100 g share ৳500: 542 / 642 → ৳422.12, 100 / 642 → ৳77.88.
  await expect(page.getByTestId('inv-item-calc').first()).toContainText('Buy ৳800.00 + weight ৳211.06 + other ৳0.00 = ৳1,011.06 per piece');
  await expect(page.getByText('Save this weight to the product')).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/02-new-lot-preview.png`, fullPage: true });
  await page.getByTestId('inv-save-lot').click();

  // Lot detail.
  await expect(page.getByTestId('inv-lot-details')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('inv-detail-allocated-ok')).toBeVisible();
  await expect(page.getByTestId('inv-landed-unit').first()).toHaveText('৳1,011.06');
  await expect(page.getByTestId('inv-movements')).toContainText('Bought (lot)');
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/03-lot-detail.png`, fullPage: true });

  // Needs weight: the toner (its weight was not saved to the product).
  await page.goto('/admin?tab=inventory&inv=weights');
  const weights = page.getByTestId('inv-weights');
  await expect(weights).toContainText(`${TEST_PREFIX} Toner`, { timeout: 15_000 });
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/04-needs-weight.png`, fullPage: true });
  await page.getByLabel(`Weight in grams for ${TEST_PREFIX} Toner`).fill('120');
  await weights.locator('.inv-weight-row', { hasText: `${TEST_PREFIX} Toner` }).getByRole('button', { name: 'Save' }).click();
  await expect(weights).not.toContainText(`${TEST_PREFIX} Toner`, { timeout: 15_000 });

  // Compare: shop stock 10 vs pieces left in lots (5 + 2).
  await page.goto('/admin?tab=inventory&inv=compare');
  await page.getByRole('button', { name: /^All/ }).click();
  const row = page.getByTestId('inv-compare').locator('.inv-item', { hasText: `${TEST_PREFIX} Cleanser 236ml` });
  await expect(row).toContainText('Shop 10');
  await expect(row).toContainText('Lots 7');
  await expect(row).toContainText('Difference +3');
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/05-compare.png`, fullPage: true });

  // Settings → Inventory mode: Off, and it can't be switched on.
  await page.goto('/admin?tab=settings&sset=inventory');
  const sw = page.getByTestId('inventory-mode-switch');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(sw).toBeDisabled();
  await expect(page.getByTestId('inventory-mode-note')).toHaveText('Available after Batch 39 (sales use lots).');
  await page.screenshot({ path: `${SHOTS}/06-settings-inventory-mode.png`, fullPage: true });

  expect(await testStock()).toBe(stockBefore);
});

/* ---------------------------------------------------------------- Part 4 */

test('Part 4: opening stock — template, upload with mistakes, clean upload, confirm L-000, one only, 200 rows, undo behind the Safety Lock', async ({ page }) => {
  test.skip(realOpeningExists, 'A real opening stock already exists; the test never touches it.');
  test.setTimeout(180_000);
  const stockBefore = await testStock();
  const cleanserKey = units.cleanser;
  const tonerKey = units.toner;
  const serumKey = `${units.serum}:${units.serumVariant}`;

  await adminAt(page, '?tab=inventory&inv=opening');
  await expect(page.getByRole('heading', { name: 'Opening stock' })).toBeVisible({ timeout: 15_000 });

  // The template: "How to fill" first, then one row per product / option.
  const downloadWait = page.waitForEvent('download');
  await page.getByTestId('inv-download-template').click();
  const download = await downloadWait;
  const templatePath = `test-results/batch38-template.xlsx`;
  await download.saveAs(templatePath);
  const sheets = (await readXlsxFile(templatePath)) as unknown as { sheet: string; data: unknown[][] }[];
  expect(sheets.map((s) => s.sheet)).toEqual(['How to fill', 'Opening stock']);
  const data = sheets[1].data;
  expect(data[0]).toEqual(['product_key', 'sku', 'product_name', 'option/size', 'weight_g', 'source', 'buy_price_bdt', 'pieces', 'expiry']);
  const keys = data.slice(1).map((r) => r[0]);
  expect(keys).toEqual(expect.arrayContaining([cleanserKey, tonerKey, serumKey]));
  const serumRow = data.find((r) => r[0] === serumKey)!;
  expect(serumRow.slice(3, 6)).toEqual(['AU · 30 ml', 35, 'import']);

  // A file with mistakes: nothing can be confirmed.
  const bad = await openingFile([
    openingRow(cleanserKey, 500, null, '2027-03'),
    openingRow('00000000-0000-0000-0000-000000000000', 100, 1, '2027-03'),
    openingRow(tonerKey, 300, -2, '2027-03', 'wholesale'),
    openingRow(serumKey, 9999, 1, '2025-01'),
  ]);
  await page.getByTestId('inv-upload').setInputFiles({ name: 'with-mistakes.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bad });
  await expect(page.getByTestId('inv-count-fix')).toContainText('3');
  await expect(page.getByTestId('inv-issues-missing')).toContainText('Pieces are missing');
  await expect(page.getByTestId('inv-issues-unknown')).toContainText('Unknown product_key');
  await expect(page.getByTestId('inv-issues-negative')).toContainText('Pieces must be above 0');
  await page.getByTestId('inv-warn-price').locator('summary').click();
  await expect(page.getByTestId('inv-warn-price')).toContainText('higher than the selling price');
  await expect(page.getByTestId('inv-warn-expired')).toBeVisible();
  await expect(page.getByTestId('inv-confirm-opening')).toBeDisabled();
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/07-opening-mistakes.png`, fullPage: true });

  // The fixed file replaces the draft: a duplicate (same product + expiry)
  // is merged; the % is added to import rows only.
  const good = await openingFile([
    openingRow(cleanserKey, 500, 4, '2027-03'),
    openingRow(cleanserKey, 700, 1, '2027-03'),
    openingRow(tonerKey, 300, 2, '2025-01', 'wholesale', 120),
    openingRow(serumKey, 9999, 1, '2027-09'),
  ]);
  await page.getByTestId('inv-upload').setInputFiles({ name: TEST_OPENING_FILE, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: good });
  await expect(page.getByTestId('inv-count-fix')).toContainText('0');
  await expect(page.getByTestId('inv-count-ready')).toContainText('3');
  await expect(page.getByTestId('inv-merged')).toContainText('Rows 2, 3');
  await page.getByText('Work it out from past lots').click();
  await page.getByLabel('Total buy price of past lots').fill('1,000,000');
  await page.getByLabel('Total weight and other costs of past lots').fill('380,000');
  await expect(page.getByTestId('inv-percent-helper')).toContainText('38%');
  await page.getByRole('button', { name: 'Use this %' }).click();
  await page.getByLabel('Start date').fill('2026-07-01');
  // Cleanser 5 × ৳540 × 38% = ৳1,026.00; serum 1 × ৳9,999 × 38% = ৳3,799.62.
  await expect(page.getByTestId('inv-total-added')).toHaveText('৳4,825.62');
  await expect(page.getByTestId('inv-total-pieces')).toHaveText('8');
  await expect(page.getByTestId('inv-total-value')).toHaveText('৳18,124.62'); // 2,700 + 600 + 9,999 + 4,825.62
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/08-opening-preview.png`, fullPage: true });
  await page.getByTestId('inv-confirm-opening').click();
  await expect(page.getByTestId('inv-opening-saved')).toContainText('L-000', { timeout: 20_000 });
  await expect(page.getByTestId('inv-opening-saved')).toContainText('Weight cost moved from old expenses into opening stock: ৳4,825.62');
  await page.screenshot({ path: `${SHOTS}/09-opening-saved.png`, fullPage: true });

  const opening = (await testLots()).find((l) => l.kind === 'opening')!;
  expect(opening.code).toBe('L-000');
  expect(Number(opening.opening_weight_added_bdt)).toBe(4825.62);
  const openingItems = await items(opening.id);
  expect(openingItems).toHaveLength(3);
  expect(openingItems.map((i) => Number(i.alloc_weight_paisa))).toEqual([102600, 0, 379962]);
  for (const r of openingItems) expect(r.qty_remaining).toBe(await movementsSum(r.id));

  // Only one opening lot.
  const twice = await rpc(admin.accessToken, 'inventory_confirm_opening', {
    p_lot_date: '2026-07-01',
    p_weight_percent: '38',
    p_rows: [{ product_id: units.cleanser, variant_id: null, source: 'import', buy_price_bdt: '1', pieces: 1, expiry: null, weight_g: null }],
    p_file_name: TEST_OPENING_FILE,
  });
  expect(twice.ok).toBe(false);
  expect(twice.error).toContain('already saved');

  // Undo needs the Safety Lock.
  const locked = await rpc(admin.accessToken, 'inventory_undo_opening');
  expect(locked.ok).toBe(false);
  expect(locked.error).toContain('Safety Lock');
  await withLock(async () => {
    const undone = await rpc(admin.accessToken, 'inventory_undo_opening');
    expect(undone.ok, undone.error ?? '').toBe(true);
  });
  expect((await testLots()).some((l) => l.kind === 'opening')).toBe(false);

  // A 200-row file (different expiry months) saves in one go.
  const rows200 = Array.from({ length: 200 }, (_, i) => {
    const unit = [units.cleanser, units.toner, units.serum][i % 3];
    const month = 12 + Math.floor(i / 3);
    return {
      product_id: unit,
      variant_id: i % 3 === 2 ? units.serumVariant : null,
      source: i % 2 === 0 ? 'import' : 'wholesale',
      buy_price_bdt: String(100 + i),
      pieces: (i % 5) + 1,
      expiry: `${2026 + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}-01`,
      weight_g: null,
    };
  });
  const big = await rpc<string>(admin.accessToken, 'inventory_confirm_opening', {
    p_lot_date: '2026-07-01',
    p_weight_percent: '38.5',
    p_rows: rows200,
    p_file_name: TEST_OPENING_FILE,
  });
  expect(big.ok, big.error ?? '').toBe(true);
  const bigItems = await items(big.data!);
  expect(bigItems).toHaveLength(200);
  expect(bigItems.reduce((a, r) => a + r.qty_remaining, 0)).toBe(rows200.reduce((a, r) => a + r.pieces, 0));
  expect(bigItems.filter((_, i) => i % 2 === 1).every((r) => Number(r.alloc_weight_paisa) === 0)).toBe(true);
  await withLock(async () => {
    const undone = await rpc(admin.accessToken, 'inventory_undo_opening');
    expect(undone.ok, undone.error ?? '').toBe(true);
  });

  expect(await testStock()).toBe(stockBefore);
});

/* ------------------------------------------------------------ deleting */

test('Deleting a lot needs the Safety Lock', async () => {
  const lots = (await testLots()).filter((l) => l.supplier === `${TEST_SUPPLIER} Dhaka`);
  expect(lots).toHaveLength(1);
  const refused = await rpc(admin.accessToken, 'inventory_delete_lot', { p_lot_id: lots[0].id });
  expect(refused.ok).toBe(false);
  expect(refused.error).toContain('Safety Lock');
  await withLock(async () => {
    const res = await rpc(admin.accessToken, 'inventory_delete_lot', { p_lot_id: lots[0].id });
    expect(res.ok, res.error ?? '').toBe(true);
  });
  expect((await testLots()).some((l) => l.id === lots[0].id)).toBe(false);
});

/* -------------------------------------------------------- permissions */

test('Permissions: without "View profit & costs" nothing is readable or writable (database), and the menu has no Inventory', async ({ page }) => {
  test.setTimeout(120_000);
  await freshAdmin();
  const staff = await staffWith(['view_orders', 'edit_products']);
  for (const table of ['lots', 'lot_costs', 'lot_items', 'stock_movements']) {
    const asStaff = await select<unknown[]>(staff.accessToken, `${table}?select=*&limit=5`);
    expect(asStaff.data ?? [], `${table} as staff`).toEqual([]);
    const asPublic = await select<unknown[]>(null, `${table}?select=*&limit=5`);
    expect(asPublic.data ?? [], `${table} as public`).toEqual([]);
  }
  const unitsAsStaff = await rpc<unknown[]>(staff.accessToken, 'inventory_stock_units');
  expect(unitsAsStaff.data ?? []).toEqual([]);
  const save = await rpc(staff.accessToken, 'inventory_save_lot', { p_lot: wholesaleLot(units) });
  expect(save.ok).toBe(false);
  expect(save.error).toContain('Not authorized');
  const confirm = await rpc(staff.accessToken, 'inventory_confirm_opening', { p_lot_date: '2026-07-01', p_weight_percent: '0', p_rows: [] });
  expect(confirm.ok).toBe(false);
  // The product columns for weight are not readable by the shop.
  const publicWeight = await select<unknown[]>(null, 'products?select=weight_grams&limit=1');
  expect(publicWeight.ok).toBe(false);

  await page.setViewportSize({ width: 1280, height: 800 });
  await useSessionInPage(page, staff);
  await page.goto('/admin?tab=inventory');
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible({ timeout: 15_000 });
  expect((await page.locator('.adm-sidebar__label').allInnerTexts()).map((t) => t.trim())).not.toContain('Inventory');

  // Switched on, the same login can read lots.
  const allowed = await staffWith(['view_orders', 'view_profit_costs']);
  const lots = await select<unknown[]>(allowed.accessToken, 'lots?select=id&limit=5');
  expect((lots.data ?? []).length).toBeGreaterThan(0);
});

/* ------------------------------------------------- activity log, setting */

test('Activity Log records lots, bills, opening upload/confirm/undo and weight edits; Inventory mode cannot be turned on', async () => {
  await freshAdmin();
  const log = await select<{ action: string; summary: string }[]>(
    admin.accessToken,
    `activity_log?select=action,summary&created_at=gte.${encodeURIComponent(startedAt)}&or=(action.like.inventory.*,summary.like.*weight_grams*)&order=id`
  );
  const actions = new Set((log.data ?? []).map((l) => l.action));
  for (const a of ['inventory.lot_created', 'inventory.lot_cost_changed', 'inventory.lot_deleted']) expect(actions, a).toContain(a);
  if (!realOpeningExists) {
    for (const a of ['inventory.opening_uploaded', 'inventory.opening_confirmed', 'inventory.opening_undone']) expect(actions, a).toContain(a);
  }
  expect((log.data ?? []).some((l) => l.action === 'product.updated' && l.summary.includes('weight_grams'))).toBe(true);

  const on = await upsertSettings(admin.accessToken, [{ key: 'inventory_mode', value: 'true' }]);
  expect(on.ok).toBe(false);
  const mode = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.inventory_mode');
  expect(mode.data?.[0]?.value).toBe('false');
});
