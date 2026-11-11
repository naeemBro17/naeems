import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, rpc, select, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';
import { pdfPageCount, pdfPageText } from './helpers/invoicePdf';

// Batch 43: smart helpers — Give an offer, the Buying list, Below cost on
// order lines, the investor report PDF.
//
// The live books are never touched:
//   - every rule with numbers runs in e2e/sql/batch-43-smart.sql, inside ONE
//     database transaction that is always rolled back;
//   - the screens are checked at 360 px (phone) with the database answers
//     mocked in the browser, so they show known numbers; no order is saved,
//     nothing is written off (that call is mocked too);
//   - one read-only test opens the real screens.
// Steadfast is mocked by ./fixtures; no real Storage file is downloaded.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-43-screens';

let admin: TestSession;

async function adminAt(page: Page, path: string, width = 360): Promise<void> {
  await page.setViewportSize({ width, height: width >= 1024 ? 900 : 800 });
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

/** Answers one database function in the browser with a fixed reply. */
async function mockRpc(page: Page, fn: string, reply: unknown | ((args: Record<string, unknown>) => unknown)): Promise<string[]> {
  const calls: string[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push(JSON.stringify(args));
    const body = typeof reply === 'function' ? (reply as (a: Record<string, unknown>) => unknown)(args) : reply;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  return calls;
}

function dhakaToday(): string {
  return new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 10);
}

function monthsFromToday(months: number): string {
  const [y, m] = dhakaToday().split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return d.toISOString().slice(0, 10);
}

/* --------------------------------------------------------------- fixtures */

function offerFixture() {
  const base = {
    variant_id: null, stock_unit: 'pcs', pack_size: 1, lot_date: '2026-06-01', units_before: 0, last_sold: dhakaToday(), history_days: 90,
  };
  return {
    today: dhakaToday(),
    inventory_mode: true,
    rows: [
      // 14 left at 2 a month = 7 months, ~4–5 months to expiry → Give offer.
      { ...base, lot_item_id: 'li-1', product_id: 'p-1', label: 'Hydrating Cream 50 ml', lot_code: 'L-001', expiry_date: monthsFromToday(4), units: 14, unit_cost: 700, units_90: 6, price: 1000 },
      // 6 left = 3 months → Watch.
      { ...base, lot_item_id: 'li-2', product_id: 'p-2', label: 'Vitamin C Serum', lot_code: 'L-002', expiry_date: monthsFromToday(4), units: 6, unit_cost: 850, units_90: 6, price: 1000 },
      // Sells in time → not listed.
      { ...base, lot_item_id: 'li-3', product_id: 'p-3', label: 'Fish Oil 400', lot_code: 'L-002', expiry_date: monthsFromToday(12), units: 4, unit_cost: 900, units_90: 6, price: 1500 },
      // Expired last month.
      { ...base, lot_item_id: 'li-4', product_id: 'p-4', label: 'Night Cream', lot_code: 'L-000', expiry_date: monthsFromToday(-2), units: 3, unit_cost: 120.5, units_90: 0, price: 600 },
    ],
  };
}

const BUYING = {
  today: '2026-11-11',
  inventory_mode: true,
  suppliers: [
    { id: 's-1', name: 'Chemist Warehouse', country: 'Australia' },
    { id: 's-2', name: 'Tokyo Drug', country: 'Japan' },
  ],
  countries: ['Australia', 'Japan'],
  rows: [
    { product_id: 'p-1', variant_id: null, label: 'Fish Oil 400', stock_unit: 'pcs', pack_size: 1, supplier_id: 's-1', country: 'Australia', units_left: 4, units_on_way: 2, units_90: 9, history_days: 90, last_sold: '2026-11-01', sold_120: 12, last_unit_cost: 1250.5, last_buy_unit: 1100, last_bought: '2026-08-01' },
    { product_id: 'p-2', variant_id: null, label: 'Magnesium Powder', stock_unit: 'g', pack_size: 2, supplier_id: 's-1', country: 'Australia', units_left: 2, units_on_way: 0, units_90: 6, history_days: 90, last_sold: '2026-10-20', sold_120: 8, last_unit_cost: 100, last_buy_unit: 80, last_bought: '2026-08-01' },
    { product_id: 'p-3', variant_id: null, label: 'Old Sunscreen', stock_unit: 'pcs', pack_size: 1, supplier_id: 's-1', country: 'Australia', units_left: 5, units_on_way: 0, units_90: 0, history_days: 90, last_sold: '2026-05-01', sold_120: 0, last_unit_cost: 900, last_buy_unit: 800, last_bought: '2026-03-01' },
    { product_id: 'p-4', variant_id: null, label: 'Rice Toner', stock_unit: 'pcs', pack_size: 1, supplier_id: 's-2', country: 'Japan', units_left: 0, units_on_way: 0, units_90: 3, history_days: 90, last_sold: '2026-11-01', sold_120: 3, last_unit_cost: 700, last_buy_unit: 650, last_bought: '2026-09-01' },
  ],
};

const INVESTORS = [
  { id: 'i-1', name: 'Rahim Uddin', capital_in: 500000, capital_back: 100000, owed: 400000, share_all: 45000, in_range: 0, back_range: 0, share_range: 9000 },
  { id: 'i-2', name: 'Karim Ahmed', capital_in: 200000, capital_back: 0, owed: 200000, share_all: 12000, in_range: 0, back_range: 0, share_range: 3000 },
];

function statementFixture(args: Record<string, unknown>) {
  const inv = INVESTORS.find((i) => i.id === args.p_investor) ?? INVESTORS[0];
  return {
    from: args.p_from, to: args.p_to, sales: 148250.5, net_profit: 31420, roi_percent: 6.4, investor: inv, year: 2026,
    months: Array.from({ length: 11 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}-01`, sales: 10000 * (i + 1), net_profit: 2000 * (i + 1) })),
    start_date: '2026-01-01',
  };
}

/* ------------------------------------------------------------------ tests */

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

test('database: offer and buying rows, below cost (who sees taka), the investor report equals the Money page (one rolled-back transaction)', async () => {
  test.skip(!supabaseCli(), 'The Supabase command line is not on this computer.');
  test.setTimeout(300_000);
  const script = readFileSync('e2e/sql/batch-43-smart.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(script);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? output.slice(0, 400)).not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  const skipped = (results ?? []).some((r) => r.detail === 'skipped');
  if (!skipped) expect((results ?? []).length).toBeGreaterThanOrEqual(30);
  // Nothing of it stayed.
  const products = await select<unknown[]>(admin.accessToken, 'products?select=id&sku=like.E2E-B43-*');
  expect(products.data).toHaveLength(0);
  const lots = await select<unknown[]>(admin.accessToken, 'lots?select=id&notes=eq.e2e%20b43');
  expect(lots.data).toHaveLength(0);
  const mode = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.inventory_mode');
  expect(mode.data?.[0]?.value).toBe('false');
});

test('permissions: the public and a customer get nothing from the smart helpers', async () => {
  const customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  for (const token of [null, customer.accessToken]) {
    for (const [fn, args] of [
      ['smart_offer_rows', {}],
      ['smart_buying_rows', {}],
      ['smart_below_cost', { p_lines: [] }],
      ['report_investor_statement', { p_investor: '00000000-0000-0000-0000-000000000000', p_from: '2026-10-01', p_to: '2026-10-31' }],
      ['smart_selling_price', { p_product_id: '00000000-0000-0000-0000-000000000000', p_variant_id: null }],
    ] as const) {
      const res = await rpc(token, fn, args);
      expect(res.ok, `${fn} as ${token ? 'customer' : 'public'}`).toBe(false);
    }
  }
});

test('Give an offer (phone): red Give offer, amber Watch, the reason, the floor price; sells-in-time rows are not listed', async ({ page }) => {
  test.setTimeout(90_000);
  await mockRpc(page, 'smart_offer_rows', offerFixture());
  await adminAt(page, '/admin?tab=inventory');
  await page.getByRole('button', { name: /Give an offer/ }).click();
  const list = page.getByTestId('offers-list');
  await expect(list).toBeVisible({ timeout: 20_000 });
  const rows = list.getByTestId('offer-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'offer');
  await expect(rows.nth(0)).toContainText('Hydrating Cream 50 ml');
  await expect(rows.nth(0).getByTestId('offer-reason')).toContainText('Sells 2 a month, 14 left, expires in');
  await expect(rows.nth(0).getByTestId('offer-suggested')).toHaveText('10–20% off: ৳800–৳900');
  await expect(rows.nth(0).getByTestId('offer-floor')).toHaveText('৳700');
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'watch');
  // Watch on ৳1,000 with a ৳850 cost: 5–10% → ৳900–৳950 (never below ৳850).
  await expect(rows.nth(1).getByTestId('offer-suggested')).toHaveText('5–10% off: ৳900–৳950');
  await expect(rows.nth(1).getByTestId('offer-floor')).toHaveText('৳850');
  await expect(list).not.toContainText('Fish Oil 400');
  await expect(page.getByText(/\bAI\b/)).toHaveCount(0);
  await shot(page, '01-give-offer.png');

  // The open-product button goes to the product editor.
  await rows.nth(0).getByTestId('offer-open').click();
  await expect(page).toHaveURL(/\/admin\/products\/p-1\/edit/);
});

test('Give an offer: expired units with a Write off shortcut (the write-off call mocked — nothing is removed)', async ({ page }) => {
  test.setTimeout(90_000);
  await mockRpc(page, 'smart_offer_rows', offerFixture());
  const calls = await mockRpc(page, 'money_write_off', { id: 'w-1', units: 3, cost_bdt: 361.5, reason: 'expired' });
  await adminAt(page, '/admin?tab=inventory&inv=offers');
  await page.getByRole('button', { name: /^Expired/ }).click();
  const row = page.getByTestId('expired-row');
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row).toContainText('Night Cream');
  await expect(row).toContainText('৳361.50');
  await shot(page, '02-expired-write-off.png');
  await row.getByTestId('expired-write-off').click();
  await page.getByTestId('confirm-sheet-input').fill('3');
  await page.getByTestId('confirm-sheet-confirm').click();
  await expect.poll(() => calls.length).toBe(1);
  const args = JSON.parse(calls[0]) as Record<string, unknown>;
  expect(args).toMatchObject({ p_product_id: 'p-4', p_units: 3, p_reason: 'expired', p_lot_item_id: 'li-4' });
});

test('Give an offer: with Inventory mode Off it says why every speed is 0', async ({ page }) => {
  await mockRpc(page, 'smart_offer_rows', { ...offerFixture(), inventory_mode: false });
  await adminAt(page, '/admin?tab=inventory&inv=offers');
  await expect(page.getByTestId('offers-mode-note')).toContainText('Inventory mode is Off', { timeout: 20_000 });
  await expect(page.getByTestId('expired-write-off')).toBeDisabled();
});

test('Buying list (phone): packs rounded up, on the way counted, Skip — not moving, total money; a changed number goes into the Excel file', async ({ page }) => {
  test.setTimeout(90_000);
  await mockRpc(page, 'smart_buying_rows', BUYING);
  await adminAt(page, '/admin?tab=inventory');
  await page.getByRole('button', { name: /Buying list/ }).click();
  await page.getByTestId('buying-source').selectOption('s-1', { timeout: 20_000 });
  const rows = page.getByTestId('buying-row');
  await expect(rows).toHaveCount(3);
  // Fish Oil: 3 a month × (6 weeks + 3 months) = 13.1 − 4 − 2 → 8.
  const fish = page.locator('[data-testid="buying-row"][data-key="p-1:"]');
  await expect(fish.getByTestId('buying-packs')).toHaveValue('8');
  await expect(fish.getByTestId('buying-note')).toContainText('4 left, 2 on the way');
  // Magnesium: 2 a month × 4.38 = 8.8 − 2 = 6.8 g → packs of 2 → 4.
  await expect(page.locator('[data-testid="buying-row"][data-key="p-2:"]').getByTestId('buying-packs')).toHaveValue('4');
  const old = page.locator('[data-testid="buying-row"][data-key="p-3:"]');
  await expect(old).toContainText('Skip — not moving');
  await expect(old.getByTestId('buying-packs')).toHaveValue('0');
  // 8 × ৳1,250.50 + 4 × ৳200 = ৳10,804.
  await expect(page.getByTestId('buying-total')).toHaveText('৳10,804');
  await shot(page, '03-buying-list.png');

  await fish.getByTestId('buying-packs').fill('2');
  await expect(page.getByTestId('buying-total')).toHaveText('৳3,301');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('buying-excel').click()]);
  expect(download.suggestedFilename()).toMatch(/^naeem-buying-list-chemist-warehouse-.*\.xlsx$/);
  const sheets = (await readXlsxFile(await download.path())) as unknown as { sheet: string; data: unknown[][] }[];
  const data = sheets[0].data;
  const head = data.findIndex((r) => r[0] === 'Product');
  const body = data.slice(head + 1);
  expect(body.find((r) => r[0] === 'Fish Oil 400')?.slice(1, 4)).toEqual([2, 2, 1100]);
  expect(body.find((r) => r[0] === 'Magnesium Powder')?.slice(1, 3)).toEqual([4, 8]);
  expect(body.some((r) => r[0] === 'Old Sunscreen')).toBe(false);
  expect(body.find((r) => r[0] === 'Total')?.[5]).toBe(3301);
  expect(String(body.find((r) => r[0] === 'Fish Oil 400')?.[6])).toContain('Changed from 8');

  // A country works too.
  await page.getByRole('button', { name: 'Country' }).click();
  await page.getByTestId('buying-source').selectOption('Japan');
  await expect(page.getByTestId('buying-row')).toHaveCount(1);
  await expect(page.getByTestId('buying-row')).toContainText('Rice Toner');
});

test('Below cost on New order: with View profit & costs the cost and the loss; without them no taka at all; never blocks', async ({ page }) => {
  test.setTimeout(120_000);
  const product = await select<{ name: string }[]>(null, 'products?select=name&is_active=eq.true&order=name.asc&limit=1');
  const name = product.data?.[0]?.name ?? '';
  expect(name).not.toBe('');
  let hideCost = false;
  await mockRpc(page, 'smart_below_cost', (args) => {
    const lines = (args.p_lines ?? []) as { price: number; quantity: number }[];
    return lines.map((l) => (hideCost ? { below: true, cost: null, loss: null } : { below: true, cost: l.price + 250, loss: 250 * l.quantity }));
  });
  await adminAt(page, '/admin/orders/new');
  const search = page.getByPlaceholder('Search product name...');
  await expect(search).toBeVisible({ timeout: 20_000 });
  await search.fill(name);
  await page.locator('.picker-sheet__list .picker-sheet__row').first().click();
  const below = page.getByTestId('line-below-cost');
  await expect(below).toContainText('Below cost — cost ৳', { timeout: 10_000 });
  await expect(below).toContainText('loss ৳250');
  await below.scrollIntoViewIfNeeded();
  await shot(page, '04-new-order-below-cost.png');

  // What a staff member without "View profit & costs" gets from the
  // database (no cost, no loss) shows no taka.
  hideCost = true;
  await page.getByRole('button', { name: 'Increase quantity' }).first().click();
  await expect(below).toHaveText('Below cost — check with Naeem', { timeout: 10_000 });
  await expect(below).not.toContainText('৳');
  await shot(page, '05-new-order-below-cost-no-permission.png');
  // It is only words: no alert, nothing disabled because of it.
  await expect(below).toHaveAttribute('role', 'status');
});

test('Below cost on Edit order (the order is opened, never saved)', async ({ page }) => {
  test.setTimeout(120_000);
  const orders = await select<{ order_number: string }[]>(admin.accessToken, 'orders?select=order_number&status=in.(pending,confirmed)&order=created_at.desc&limit=1');
  test.skip(!orders.data?.length, 'No open order to look at.');
  await mockRpc(page, 'smart_below_cost', (args) =>
    ((args.p_lines ?? []) as { price: number }[]).map((l) => ({ below: true, cost: l.price + 100, loss: 100 }))
  );
  await adminAt(page, `/admin/orders/${encodeURIComponent(orders.data![0].order_number)}/edit`);
  const item = page.getByTestId('edit-order-item').first();
  await expect(item.getByTestId('edit-line-below-cost')).toContainText('Below cost — cost ৳', { timeout: 20_000 });
  // Only the item row is pictured (no customer details in the screenshot).
  await item.screenshot({ path: `${SHOTS}/06-edit-order-below-cost-line.png` });
});

test('Investor report PDF: one page; its numbers equal Reports → Investors and the statement; Download and Share', async ({ page }) => {
  test.setTimeout(120_000);
  // No share sheet in this browser (like a computer): Share downloads.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  });
  await mockRpc(page, 'report_investors', INVESTORS);
  const calls = await mockRpc(page, 'report_investor_statement', statementFixture);
  await adminAt(page, '/admin?tab=reports&r=investors');
  const card = page.getByTestId('investor-pdf');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('investor-pdf-who').selectOption('i-1');
  await page.getByTestId('investor-pdf-month').selectOption({ index: 2 });
  await expect(page.getByTestId('investor-pdf-period')).toContainText('Period: 1 ');
  await card.scrollIntoViewIfNeeded();
  await shot(page, '07-investor-pdf-card.png');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('investor-pdf-download').click()]);
  expect(download.suggestedFilename()).toMatch(/^NAEEMS-investor-Rahim-Uddin-\d{4}-\d{2}-01-to-\d{4}-\d{2}-\d{2}\.pdf$/);
  const bytes = new Uint8Array(readFileSync(await download.path()));
  expect(await pdfPageCount(bytes)).toBe(1);
  const text = (await pdfPageText(bytes)).join(' ').replace(/\s+/g, ' ');
  // The same numbers as the Investors table on the screen.
  const table = await page.getByTestId('investors-table').innerText();
  for (const n of ['5,00,000', '1,00,000', '4,00,000']) {
    expect(table).toContain(n);
    expect(text).toContain(n);
  }
  for (const s of ["NAEEM'S", 'Rahim Uddin', '1,48,250.50', '31,420', '6.4%', '9,000', '6,60,000']) expect(text).toContain(s);
  expect(text).not.toContain('Karim Ahmed');
  const args = JSON.parse(calls[calls.length - 1]) as Record<string, unknown>;
  expect(args.p_investor).toBe('i-1');

  // Share: a computer without a share sheet downloads it instead.
  const [shared] = await Promise.all([page.waitForEvent('download'), page.getByTestId('investor-pdf-share').click()]);
  expect(shared.suggestedFilename()).toMatch(/\.pdf$/);
});

test('live: Give an offer, Buying list and Investors open with the real database (nothing is changed)', async ({ page }) => {
  test.setTimeout(120_000);
  for (const fn of ['smart_offer_rows', 'smart_buying_rows']) {
    const res = await rpc(admin.accessToken, fn, {});
    expect(res.ok, fn).toBe(true);
  }
  await adminAt(page, '/admin?tab=inventory&inv=offers');
  await expect(page.getByRole('heading', { name: 'Give an offer' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Could not load')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('offers-mode-note')).toBeVisible();
  await page.goto('/admin?tab=inventory&inv=buying');
  await expect(page.getByTestId('buying-source')).toBeVisible({ timeout: 20_000 });
  await page.goto('/admin?tab=reports&r=investors');
  await expect(page.getByTestId('report-excel')).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByText('Could not load')).toHaveCount(0);
});
