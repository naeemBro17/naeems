import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { insert, passwordSession, remove, select, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 52.1: "Keep selling when out of stock" must work in the cart.
//
// Real products, real database, Inventory mode On, nothing kept:
// - The picks are live products with NOTHING in lots (stock 0 while
//   Inventory mode is On): one without options, one with an option, and one
//   more that plays "Keep selling OFF".
// - The shop reads the real views. Only each pick's "Keep selling" switch is
//   set for the test, exactly as the database's views would show it to the
//   person logged in (staff see the real 0; shoppers see no number).
// - "Place order" never reaches the live shop: the browser's request is
//   caught and the REAL place_order() runs on the live database inside ONE
//   transaction with Inventory mode on (inventory.test_mode) that always
//   ends in ROLLBACK. The order-number counter is put back afterwards.
// - The cart is emptied at the end.
//
// Batch 51's browser tests answered every product as a customer would see
// it (no stock number) and never shopped as the admin, so the cart's
// "just sold out" check never met a real 0 — this file shops as both.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
test.use({ serviceWorkers: 'block' });

interface Pick {
  id: string;
  name: string;
  slug: string;
}
interface OptionPick extends Pick {
  variant_id: string;
  variant_label: string;
}

let admin: TestSession;
let customer: TestSession;
let picks: { plain: Pick; withOption: OptionPick; off: Pick };

/** Rows of a read-only query run with the Supabase command line. */
async function cliRows<T>(sql: string): Promise<T[]> {
  const out = await runSql(sql);
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`No answer from the database: ${out.slice(0, 300)}`);
  const body = JSON.parse(out.slice(start, end + 1)) as { rows?: T[] };
  if (!body.rows) throw new Error(sqlError(out) ?? 'no rows');
  return body.rows;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  // Live products with nothing in lots (stock 0 while Inventory mode is On).
  const empty = `p.is_active AND p.slug IS NOT NULL AND p.image_url IS NOT NULL AND p.retail_price > 0
                 AND COALESCE(inventory_units_left(p.id, NULL), 0) <= 0`;
  const plain = await cliRows<Pick>(`
    SELECT p.id, p.name, p.slug FROM products p
    WHERE ${empty} AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)
    ORDER BY p.name LIMIT 2;`);
  const withOption = await cliRows<OptionPick>(`
    SELECT p.id, p.name, p.slug, v.id AS variant_id,
           concat_ws(' · ', NULLIF(v.region, ''), NULLIF(v.size, '')) AS variant_label
    FROM products p JOIN product_variants v ON v.product_id = p.id
    WHERE ${empty} AND v.retail_price > 0
      AND NOT EXISTS (SELECT 1 FROM product_variants w WHERE w.product_id = p.id
                      AND COALESCE(inventory_units_left(p.id, w.id), 0) > 0)
    ORDER BY p.name, v.sort_order LIMIT 1;`);
  expect(plain.length, 'two live products without options and nothing in lots').toBe(2);
  expect(withOption.length, 'a live product with an option and nothing in lots').toBe(1);
  picks = { plain: plain[0], off: plain[1], withOption: withOption[0] };
});

/* --------------------------------------------- the views, as the DB shows them */

type Row = Record<string, unknown>;

/** Keep selling for this test: the two keep-selling picks ON, the third OFF. */
function keepFor(productId: string): boolean | null {
  if (productId === picks.plain.id || productId === picks.withOption.id) return true;
  if (productId === picks.off.id) return false;
  return null;
}

/** A pick's row as products_view shows it with stock 0 (migration-052). */
function dressProduct(row: Row, staff: boolean): Row {
  const keep = keepFor(String(row.id));
  if (keep === null) return row;
  const hidden = keep && !staff;
  return {
    ...row,
    keep_selling: keep,
    in_hand: false,
    ...('stock_quantity' in row ? { stock_quantity: hidden ? null : 0 } : {}),
    ...('stock_status' in row ? { stock_status: hidden ? 'in_stock' : 'out_of_stock' } : {}),
  };
}

function dressOption(row: Row, staff: boolean): Row {
  const keep = keepFor(String(row.product_id));
  if (keep === null) return row;
  const hidden = keep && !staff;
  return {
    ...row,
    ...('keep_selling' in row ? { keep_selling: keep } : {}),
    ...('in_hand' in row ? { in_hand: false } : {}),
    ...('stock_quantity' in row ? { stock_quantity: hidden ? null : 0 } : {}),
    ...('in_stock' in row ? { in_stock: hidden } : {}),
  };
}

async function dressViews(page: Page, staff: boolean): Promise<void> {
  const dress = async (route: Route, fn: (row: Row) => Row) => {
    const res = await route.fetch();
    const body = (await res.json()) as Row[] | Row;
    const json = Array.isArray(body) ? body.map(fn) : body && typeof body === 'object' && 'id' in body ? fn(body) : body;
    await route.fulfill({ response: res, json });
  };
  await page.route(/\/rest\/v1\/products_view\?/, (route) => dress(route, (r) => dressProduct(r, staff)));
  await page.route(/\/rest\/v1\/product_variants_view\?/, (route) => dress(route, (r) => dressOption(r, staff)));
}

/* ---------------------------------------- place_order, in a rolled-back transaction */

interface PlacedResult {
  error?: string;
  order_id?: string;
  order_number?: string;
  total?: number;
  discount?: number;
  advance_discount?: number;
  buys_later?: boolean;
  short_units?: number;
  expected_units?: number;
  shopping?: { product_id: string; variant_id: string | null; qty: number }[];
  stock_after?: number[];
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Runs the real place_order() with the browser's own arguments, as that
 *  user, with Inventory mode on, then rolls everything back. */
async function placeOrderRolledBack(args: Record<string, unknown>, email: string): Promise<PlacedResult> {
  const keepIds = [picks.plain.id, picks.withOption.id].map(sqlText).join(', ');
  const ids = [picks.plain.id, picks.withOption.id, picks.off.id].map(sqlText).join(', ');
  const sql = `
BEGIN;
CREATE TEMP TABLE t_seq AS SELECT last_value FROM order_number_seq;
CREATE TEMP TABLE t_res (j jsonb);
DO $t$
DECLARE
  a jsonb := $j$${JSON.stringify(args)}$j$::jsonb;
  r record;
  v_user uuid;
  v_admin uuid;
BEGIN
  PERFORM set_config('inventory.test_mode', 'on', true);
  UPDATE products SET keep_selling = true WHERE id IN (${keepIds});
  UPDATE products SET keep_selling = false WHERE id = ${sqlText(picks.off.id)};
  SELECT id INTO v_user FROM auth.users WHERE lower(email) = lower(${sqlText(email)});
  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower(${sqlText(E2E_ADMIN_EMAIL)});
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  SELECT * INTO r FROM place_order(a->'p_items', a->>'p_full_name', a->>'p_phone', a->>'p_division', a->>'p_district',
    a->>'p_thana', a->>'p_address_line', a->>'p_delivery_zone', a->>'p_payment_method', a->>'p_bkash_trx_id',
    a->>'p_bkash_sender', a->>'p_promo_code', a->>'p_customer_note');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text, true);
  INSERT INTO t_res SELECT jsonb_build_object(
    'order_id', r.order_id, 'order_number', r.order_number, 'total', r.total, 'discount', r.discount,
    'advance_discount', r.advance_discount,
    'buys_later', (SELECT buys_later FROM orders WHERE id = r.order_id),
    'short_units', (SELECT COALESCE(sum(units), 0) FROM stock_shortfalls WHERE order_id = r.order_id AND status = 'open'),
    'expected_units', (SELECT COALESCE(sum(i.quantity * inventory_pack_size(i.product_id, i.variant_id)), 0)
                       FROM order_items i WHERE i.order_id = r.order_id),
    'shopping', (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', s.product_id, 'variant_id', s.variant_id, 'qty', s.qty)), '[]'::jsonb)
                 FROM admin_shopping_list() s WHERE s.orders::text LIKE '%' || r.order_number || '%'),
    'stock_after', (SELECT jsonb_agg(stock_quantity) FROM products WHERE id IN (${ids})));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO t_res SELECT jsonb_build_object('error', SQLERRM);
END
$t$;
SELECT setval('order_number_seq', (SELECT last_value FROM t_seq));
SELECT 'TEST_RESULT' AS tag, (SELECT j FROM t_res)::text AS results;
ROLLBACK;`;
  const out = await runSql(sql);
  return rowResult<PlacedResult>(out) ?? { error: sqlError(out) ?? 'no result' };
}

/** Catches the order the browser sends; nothing reaches the live shop. */
async function catchOrder(page: Page, email: string, placed: PlacedResult[]): Promise<void> {
  await page.route(/\/rest\/v1\/rpc\/place_order/, async (route) => {
    try {
      const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      const result = await placeOrderRolledBack(args, email);
      placed.push(result);
      if (result.error) {
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: result.error }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            order_id: result.order_id,
            order_number: result.order_number,
            total: result.total,
            discount: result.discount,
            advance_discount: result.advance_discount,
          },
        ]),
      });
    } catch {
      await route.abort();
    }
  });
  // The order only existed inside the rolled-back transaction: answer the
  // shop's follow-up read of buys_later from what it said.
  await page.route(/\/rest\/v1\/orders\?/, async (route) => {
    const last = placed[placed.length - 1];
    const url = route.request().url();
    if (!last?.order_id || !url.includes(last.order_id)) {
      await route.fallback();
      return;
    }
    const row = { buys_later: last.buys_later === true };
    const wantsObject = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(wantsObject ? row : [row]) });
  });
}

/* ------------------------------------------------------------ helpers */

async function open(page: Page, session: TestSession, path: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, session);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('b521-cart-cleared')) {
      localStorage.setItem('nph_cart', '[]');
      sessionStorage.setItem('b521-cart-cleared', '1');
    }
  });
  await page.goto(path);
}

async function addFromProductPage(page: Page, slug: string, variantId: string | null): Promise<void> {
  await page.goto(`/product/${slug}${variantId ? `?variant=${variantId}` : ''}`);
  await expect(page.getByTestId('stock-chip')).toHaveText(/in stock/i, { timeout: 30_000 });
  await expect(page.getByTestId('add-to-cart')).toBeEnabled();
  await page.getByTestId('add-to-cart').click();
  await expect(page.getByTestId('buy-bar-qty')).toHaveText('1');
}

/** The cart re-check reads both views; wait until it has answered. */
async function openCartAndWaitForCheck(page: Page): Promise<void> {
  const checked = page.waitForResponse((r) => /\/rest\/v1\/products_view\?.*id=in\./.test(r.url()), { timeout: 30_000 });
  await page.goto('/cart');
  await checked;
  await page.waitForTimeout(800);
}

async function expectSoldOutPage(page: Page, slug: string): Promise<void> {
  await page.goto(`/product/${slug}`);
  await expect(page.getByTestId('stock-chip')).toHaveText('Sold out', { timeout: 30_000 });
  await expect(page.getByTestId('buy-bar-out')).toHaveText('Sold out');
  await expect(page.getByTestId('add-to-cart')).toHaveCount(0);
}

async function emptyCart(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('nph_cart', '[]'));
}

/* -------------------------------------------------------------- tests */

test('admin (sees the real stock 0): keep-selling items, with and without an option, stay in the cart; keep OFF cannot be added', async ({ page }) => {
  test.setTimeout(150_000);
  await dressViews(page, true);
  await open(page, admin, '/');

  await addFromProductPage(page, picks.plain.slug, null);
  await addFromProductPage(page, picks.withOption.slug, picks.withOption.variant_id);
  await addFromProductPage(page, picks.withOption.slug, null);
  await expectSoldOutPage(page, picks.off.slug);

  await openCartAndWaitForCheck(page);
  await expect(page.getByTestId('stock-notice')).toHaveCount(0);
  await expect(page.locator('.checkout-cart__row')).toHaveCount(3);
  await expect(page.locator('.checkout-cart__row', { hasText: picks.withOption.variant_label })).toHaveCount(1);
  // A second visit re-checks again: still nothing removed.
  await openCartAndWaitForCheck(page);
  await expect(page.getByTestId('stock-notice')).toHaveCount(0);
  await expect(page.locator('.checkout-cart__row')).toHaveCount(3);
  await emptyCart(page);
});

test('customer: keep-selling items at stock 0 go in the cart, survive the re-check, check out as "buy after order" and reach the Shopping list', async ({ page }) => {
  test.setTimeout(240_000);
  const placed: PlacedResult[] = [];
  await dressViews(page, false);
  await catchOrder(page, E2E_EMAIL, placed);
  await open(page, customer, '/');

  await addFromProductPage(page, picks.plain.slug, null);
  await addFromProductPage(page, picks.withOption.slug, picks.withOption.variant_id);
  await expectSoldOutPage(page, picks.off.slug);

  await openCartAndWaitForCheck(page);
  await expect(page.getByTestId('stock-notice')).toHaveCount(0);
  await expect(page.locator('.checkout-cart__row')).toHaveCount(2);
  await expect(page.getByTestId('cart-buy-after').first()).toBeVisible({ timeout: 20_000 });

  // Checkout, as the existing checkout test does it.
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/\/checkout\/delivery/);
  await page.locator('.checkout-zone-card').first().click();
  await page.getByLabel(/Full name/).fill('E2E Batch 52.1');
  await page.getByLabel(/Phone number/).fill('01712345678');
  for (const field of ['division', 'district', 'thana']) {
    await page.locator(`[id$="-${field}"]`).first().click();
    await page.waitForTimeout(200);
    await page.locator('.picker-sheet__row').first().click();
    await page.waitForTimeout(200);
  }
  await page.getByLabel(/House \/ road \/ landmark/).fill('Road 1, test only');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page).toHaveURL(/\/checkout\/summary/);
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('stock-notice')).toHaveCount(0);

  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/checkout\/success/, { timeout: 90_000 });

  expect(placed.length, 'the order went to the rolled-back database run').toBe(1);
  const result = placed[0];
  expect(result.error, 'place_order accepted it').toBeUndefined();
  expect(result.buys_later, 'the order is "buy after order"').toBe(true);
  expect(result.short_units, 'every unit missing from lots is "sold without stock"').toBe(result.expected_units);
  expect(result.short_units).toBeGreaterThan(0);
  const onList = (result.shopping ?? []).map((s) => `${s.product_id}:${s.variant_id ?? ''}`);
  expect(onList).toContain(`${picks.plain.id}:`);
  expect(onList).toContain(`${picks.withOption.id}:${picks.withOption.variant_id}`);
  expect(result.stock_after?.every((n) => n === 0), 'the shop stock never goes below 0').toBe(true);
  await emptyCart(page);
});

test('database: a keep-OFF product at stock 0 is still refused, and the customer limit still applies (rolled back)', async () => {
  test.setTimeout(120_000);
  const base = {
    p_full_name: 'E2E Batch 52.1',
    p_phone: '01712345678',
    p_division: 'Dhaka',
    p_district: 'Dhaka',
    p_thana: 'Gulshan',
    p_address_line: 'Road 1, test only',
    p_delivery_zone: 'inside_dhaka',
    p_payment_method: 'cod',
  };
  const off = await placeOrderRolledBack({ ...base, p_items: [{ product_id: picks.off.id, variant_id: null, quantity: 1 }] }, E2E_EMAIL);
  expect(off.error ?? '').toMatch(/out of stock|left in stock/i);
  const tooMany = await placeOrderRolledBack({ ...base, p_items: [{ product_id: picks.plain.id, variant_id: null, quantity: 99 }] }, E2E_EMAIL);
  expect(tooMany.error ?? '').toMatch(/Limit \d+ per order/);
  const adminMany = await placeOrderRolledBack({ ...base, p_items: [{ product_id: picks.plain.id, variant_id: null, quantity: 9 }] }, E2E_ADMIN_EMAIL);
  expect(adminMany.error, 'the admin has no limit').toBeUndefined();
  expect(adminMany.buys_later).toBe(true);
});

/* ------------------------------------------ Part 2: Edit product captures */

const SHOTS = 'reports/batch-52-1-screens';
const PHASE = process.env.B521_PHASE === 'before' ? 'before' : 'after';

/** Captures the page top to bottom, one screen at a time. */
async function screens(page: Page, name: string): Promise<void> {
  const height = page.viewportSize()?.height ?? 844;
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = Math.floor(height * 0.85);
  let n = 1;
  for (let y = 0; y < total && n <= 8; y += step, n += 1) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${PHASE}/${name}-${String(n).padStart(2, '0')}.png` });
    if (y + height >= total) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function openEditor(page: Page, productId: string, width: number, theme: 'light' | 'dark'): Promise<void> {
  await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${productId}/edit`);
  await expect(page.getByTestId('product-page')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#pf-name')).toBeVisible({ timeout: 30_000 });
  // The long-text editors have opened (Save no longer says "Loading text…").
  await expect(page.getByRole('button', { name: /Save changes/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`Edit product captures at ${width} px (${theme}, ${PHASE}): with options, without options, option editor open`, async ({ page }) => {
      test.setTimeout(180_000);
      await openEditor(page, picks.withOption.id, width, theme);
      // Inventory mode is On in the live shop: an option's stock is text.
      await expect(page.getByTestId('variant-stock-text').first()).toHaveText(/^From lots: \d+$/);
      await screens(page, `${width}-${theme}-with-options`);
      await page.getByRole('button', { name: new RegExp(`^Edit ${picks.withOption.variant_label.split(' · ')[0]}`) }).first().click();
      await expect(page.getByTestId('variant-stock-hint')).toHaveText(/Inventory mode is On/);
      await page.getByTestId('variant-stock-hint').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/${PHASE}/${width}-${theme}-option-editor-open.png` });

      await openEditor(page, picks.plain.id, width, theme);
      await screens(page, `${width}-${theme}-no-options`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
    });
  }
}

/* --------------------------- Part 2: every kind of field still saves */

interface SavedRow {
  name: string;
  brand: string | null;
  category_id: string | null;
  size: string | null;
  note: string | null;
  skin_types: string[];
  retail_price: number;
  offer_price: number | null;
  wholesale_price: number | null;
  keep_selling: boolean;
  is_featured: boolean;
  is_active: boolean;
  youtube_url: string | null;
  description: string | null;
}

test('Edit product after the redesign: text, select, chips, prices, switches and long text all save and come back after a reload (throwaway hidden product, deleted after)', async ({ page }) => {
  test.setTimeout(180_000);
  const tag = Date.now().toString(36);
  // The API may add a product but not read every column back (the
  // wholesale price is hidden), so it is found again through the view.
  const created = await insert(admin.accessToken, 'products', {
    sku: `E2E-B521-${tag}`,
    slug: `e2e-b521-${tag}`,
    name: `E2E B52.1 save check ${tag}`,
    retail_price: 500,
    stock_status: 'in_stock',
    is_active: false,
  }, false);
  expect(created.error, 'throwaway product created').toBeNull();
  const found = await select<{ id: string }[]>(admin.accessToken, `products_view?select=id&sku=eq.E2E-B521-${tag}`);
  const id = found.data?.[0]?.id ?? '';
  expect(id, 'throwaway product found').not.toBe('');
  try {
    const brands = await select<{ name: string }[]>(admin.accessToken, 'brands?select=name&order=name.asc&limit=1');
    const brand = brands.data?.[0]?.name ?? '';
    await page.setViewportSize({ width: 1280, height: 900 });
    await useSessionInPage(page, admin);
    await page.goto(`/admin/products/${id}/edit`);
    await expect(page.locator('#pf-name')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible({ timeout: 30_000 });

    const newName = `E2E B52.1 save check ${tag} two`;
    await page.locator('#pf-name').fill(newName);
    if (brand) await page.locator('#pf-brand').fill(brand);
    const category = await page.locator('#pf-category option').nth(1).getAttribute('value');
    if (category) await page.locator('#pf-category').selectOption(category);
    await page.locator('#pf-size').fill('50 ml');
    await page.locator('#pf-note').fill('Batch 52.1 note');
    await page.getByRole('button', { name: 'Oily', exact: true }).click();
    await page.locator('#pf-retail').fill('600');
    await page.locator('#pf-offer').fill('550');
    await page.locator('#pf-wholesale').fill('450');
    await page.getByRole('switch', { name: 'Keep selling when out of stock' }).click();
    await page.getByRole('switch', { name: 'Featured' }).click();
    await page.locator('#pf-youtube').fill('https://youtube.com/watch?v=b521');
    const content = page.getByTestId('rt-editor-pf-description').locator('.rt-editor__content');
    await content.click();
    await page.keyboard.type('Batch 52.1 description');

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved ✓')).toBeVisible({ timeout: 30_000 });

    const row = await select<SavedRow[]>(admin.accessToken, `products_view?id=eq.${id}&select=*`);
    const saved = row.data?.[0];
    expect(saved?.name).toBe(newName);
    if (brand) expect(saved?.brand).toBe(brand);
    if (category) expect(saved?.category_id).toBe(category);
    expect(saved?.size).toBe('50 ml');
    expect(saved?.note).toBe('Batch 52.1 note');
    expect(saved?.skin_types).toContain('Oily');
    expect(Number(saved?.retail_price)).toBe(600);
    expect(Number(saved?.offer_price)).toBe(550);
    expect(Number(saved?.wholesale_price)).toBe(450);
    expect(saved?.keep_selling).toBe(false);
    expect(saved?.is_featured).toBe(true);
    expect(saved?.is_active).toBe(false);
    expect(saved?.youtube_url).toBe('https://youtube.com/watch?v=b521');
    expect(saved?.description ?? '').toContain('Batch 52.1 description');

    // After a reload the page shows what was saved.
    await page.reload();
    await expect(page.locator('#pf-name')).toHaveValue(newName, { timeout: 30_000 });
    await expect(page.locator('#pf-size')).toHaveValue('50 ml');
    await expect(page.locator('#pf-retail')).toHaveValue('600');
    await expect(page.locator('#pf-offer')).toHaveValue('550');
    await expect(page.locator('#pf-wholesale')).toHaveValue('450');
    await expect(page.getByRole('switch', { name: 'Keep selling when out of stock' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: 'Featured' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Active' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#pf-youtube')).toHaveValue('https://youtube.com/watch?v=b521');
  } finally {
    const gone = await remove(admin.accessToken, `products?id=eq.${id}`);
    expect(gone.error, 'throwaway product deleted').toBeNull();
  }
});
