import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import writeXlsxFile from 'write-excel-file/node';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 50: old Kaarbar sales (Step 1 · Old products, Step 2 · Old sales),
// where they appear, and "Correct previous balance".
//
// The live shop is never changed. The database rules run in
// e2e/sql/batch-50.sql together with the whole Batch 50 migration inside
// ONE transaction that is always rolled back. The screens are driven at
// 390 px with made-up Kaarbar files (an Item List made here, party
// statements drawn here as real PDFs); every kaarbar_* / money call they
// make is answered in the browser, so nothing is saved and no real name
// appears in a screenshot.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-50-screens';
const WIDTH = 390;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

/* ------------------------------------------------------ the database rules */

test('database: Super Admin only, password, items + hidden products, old bills change no money / stock / dues, Profit & loss and Products include them, undo, correct previous balance (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const migration = readFileSync('supabase/migration-051-batch50.sql', 'utf8').replace(/\r\n/g, '\n');
  const body = migration.slice(migration.indexOf('\nBEGIN;\n') + 8, migration.lastIndexOf('\nCOMMIT;\n'));
  const tests = readFileSync('e2e/sql/batch-50.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${body}\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(45);
});

/* ---------------------------------------------------------- made-up files */

type Cell = { value: string | number | null; type?: typeof Number | typeof String } | null;
const text = (value: string): Cell => ({ value, type: String });
const num = (value: number): Cell => ({ value, type: Number });

async function itemListFile(): Promise<Buffer> {
  const rows: Cell[][] = [
    [text('Item List Report'), null],
    [text('Item Name'), text('Purchase Price')],
    [text('Test Gentle Cleanser 236 ML (Australia/USA)'), num(0)],
    [text('Test Moisturising Lotion 473ml'), num(0)],
    [text('Test Night Cream'), num(0)],
    [text('Test Old Serum Discontinued'), num(350)],
    [text('Test Mystery Balm'), num(0)],
  ];
  return writeXlsxFile(rows, { sheet: 'Item List' }).toBuffer();
}

const TX = { date: 30, part: 110, total: 230, paid: 300, due: 370, bal: 440 };
const IT = { name: 44, total: 230, qty: 300, rate: 360, disc: 430 };

/** A party statement drawn as a real PDF in Kaarbar's layout. */
async function statementPdf(opts: { name: string; phone: string; headerTotal: string; layout?: 'old'; bills: 'main' | 'short' }): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 800;
  const line = (cells: [string, number][], dy = 12) => {
    for (const [s, x] of cells) page.drawText(s, { x, y, size: 8, font });
    y -= dy;
  };
  line([[`Party Statement of ${opts.name}`, 30], [`Total Sales (Sales - Sales Return): Tk. ${opts.headerTotal}`, 300]]);
  line([[`Phone No: ${opts.phone}`, 30], ['Money In: Tk. 1', 300]]);
  line([['Total Transactions : 6', 30], ['Report Generated on: 18 Nov 2026 5:39 PM', 300]]);
  if (opts.layout === 'old') {
    line([['Date', TX.date], ['Particulars', TX.part], ['Debit', TX.total], ['Credit', TX.paid], ['Running Balance', TX.due]]);
    line([['12 Nov 2025', TX.date], ['Sale #9', TX.part], ['Tk. 100', TX.total]]);
    return Buffer.from(await doc.save());
  }
  line([['Date', TX.date], ['Particulars', TX.part], ['Total', TX.total], ['Rec/Paid Amt', TX.paid], ['Due', TX.due], ['Running Balance', TX.bal]]);
  const tx = (date: string, part: string, total: string) =>
    line([[date, TX.date], [part, TX.part], [`Tk. ${total}`, TX.total], [`Tk. ${total}`, TX.paid], ['Tk. 0', TX.due], ['Tk. 0', TX.bal]]);
  const head = () => line([['Items', IT.name], ['Total', IT.total], ['Quantity', IT.qty], ['Rate', IT.rate], ['Discount', IT.disc]]);
  const item = (name: string[], total: string, qty: string, rate: string, disc: string[] = ['--']) => {
    const n = Math.max(name.length, disc.length);
    for (let i = 0; i < n; i++) {
      const cells: [string, number][] = [];
      if (name[i]) cells.push([name[i], IT.name]);
      if (i === 0) cells.push([`Tk. ${total}`, IT.total], [qty, IT.qty], [`Tk. ${rate}`, IT.rate]);
      if (disc[i]) cells.push([disc[i], IT.disc]);
      line(cells, i === n - 1 ? 14 : 10);
    }
  };
  if (opts.bills === 'short') {
    tx('02 Feb 2026', 'Sale #B-300', '1,500');
    head();
    item(['Test Night Cream'], '1,500', '1', '1,500');
    return Buffer.from(await doc.save());
  }
  tx('12 Jan 2026', 'Sale #B-100', '2,000');
  head();
  item(['Test Night Cream'], '2,000', '1', '2,000');
  tx('18 May 2026', 'Sale #B-101', '4,230');
  head();
  item(['Test Gentle Cleanser 236 ML', '(Australia/USA)'], '2,100', '1', '2,750', ['Tk. 650', '(23.63%)']);
  item(['Test Moisturising Lotion 473ml'], '2,800', '2', '1,400');
  item(['Delivery Charge'], '130', '1', '130');
  line([['Remarks: Paid. TRX: TEST', IT.name]]);
  tx('11 Jun 2026', 'Payment In #14', '3,000');
  line([['Remarks: You have received Tk 3,000.00', IT.name]]);
  tx('25 Sep 2026', 'Sale #B-102', '850');
  head();
  item(['Test Moisturising Lotion 473ml'], '850', '100 ML', '8.50');
  tx('05 Oct 2026', 'Sale #B-103', '1,000');
  head();
  item(['Test Night Cream'], '1,000', '1', '1,000');
  return Buffer.from(await doc.save());
}

/* --------------------------------------------------------- the answers */

const P = (n: number) => `00000000-0000-4000-8000-00000000050${n}`;
const CHOICES = [
  { product_id: P(1), variant_id: P(6), name: 'Test Gentle Cleanser', option: '236 ml', is_active: true, stock_unit: 'pcs', pack_size: 1, cost_per_pack: 1500, made_by_import: false },
  { product_id: P(2), variant_id: null, name: 'Test Moisturizing Lotion 473ml', option: null, is_active: true, stock_unit: 'pcs', pack_size: 1, cost_per_pack: 2200, made_by_import: false },
  { product_id: P(3), variant_id: P(7), name: 'Test Night Cream', option: '50 ml', is_active: true, stock_unit: 'pcs', pack_size: 1, cost_per_pack: 900, made_by_import: false },
  { product_id: P(3), variant_id: P(8), name: 'Test Night Cream', option: '100 ml', is_active: true, stock_unit: 'pcs', pack_size: 1, cost_per_pack: 1600, made_by_import: false },
  { product_id: P(4), variant_id: null, name: 'Test Sun Cream SPF50', option: null, is_active: false, stock_unit: 'pcs', pack_size: 1, cost_per_pack: null, made_by_import: false },
];

function savedItem(id: number, name: string, product: string | null, variant: string | null, cost: number, unitCosts: Record<string, number> = {}) {
  return {
    id: `00000000-0000-4000-8000-0000000005a${id}`,
    name_key: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    kaarbar_name: name,
    kaarbar_price: 0,
    product_id: product,
    variant_id: variant,
    made_product_id: null,
    match_how: 'auto',
    cost_per_pack: cost,
    unit_costs: unitCosts,
    bill_lines: 0,
  };
}

interface Captured {
  items: Record<string, unknown>[] | null;
  units: Record<string, unknown>[] | null;
  bills: Record<string, unknown>[] | null;
}

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function answerKaarbar(page: Page, captured: Captured, saved: 'none' | 'saved'): Promise<void> {
  let mlCost: number | null = null;
  const items = () =>
    saved === 'none'
      ? []
      : [
          savedItem(1, 'Test Gentle Cleanser 236 ML (Australia/USA)', P(1), P(6), 1500),
          savedItem(2, 'Test Moisturising Lotion 473ml', P(2), null, 2200, mlCost === null ? {} : { ml: mlCost }),
          savedItem(3, 'Test Night Cream', P(3), P(8), 1600),
        ];
  await page.route(/\/rest\/v1\/rpc\/kaarbar_/, async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (name === 'kaarbar_status') {
      return json(route, { start_date: '2026-11-13', today: '2026-11-18', locked_months: [], bill_nos: [], last_customers: null, last_expenses: null });
    }
    if (name === 'kaarbar_old_sales_status') {
      return json(route, {
        cutoff: '2026-09-30',
        items: items(),
        choices: CHOICES,
        bill_keys: ['sale:B-100'],
        bills: 1,
        locked_months: [],
        last_products: saved === 'none' ? null : { id: 'p', at: '2026-11-18T10:00:00Z', by: 'naeem', count: 3, total: 0 },
        last_sales: null,
      });
    }
    if (name === 'kaarbar_customers_check') {
      const rows = (body.p_rows ?? []) as { n: number; phone_key: string | null }[];
      return json(
        route,
        rows.map((r) => (r.phone_key === '01799950001' ? { n: r.n, site_key: 'ph:01799950001', site_name: 'Test Party One', site_due: 0 } : { n: r.n, site_key: null, site_name: null, site_due: 0 }))
      );
    }
    if (name === 'kaarbar_save_items') {
      captured.items = (body.p_rows ?? []) as Record<string, unknown>[];
      return json(route, { added: captured.items.length, updated: 0, hidden_made: 2 });
    }
    if (name === 'kaarbar_set_unit_costs') {
      captured.units = (body.p_rows ?? []) as Record<string, unknown>[];
      mlCost = Number(captured.units[0]?.cost ?? 0);
      return json(route, captured.units.length);
    }
    if (name === 'kaarbar_import_sales') {
      captured.bills = (body.p_bills ?? []) as Record<string, unknown>[];
      return json(route, { import_id: 'z', added: captured.bills.length, skipped: 0, total: 0 });
    }
    return route.abort();
  });
}

async function openScreen(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=kaarbar');
  await expect(page.locator('.adm-page-header__title')).toHaveText('Import from Kaarbar', { timeout: 30_000 });
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
}

/** Nothing on these cards is orange except inside the confirm sheet. */
async function noOrangeOnCard(page: Page, testId: string): Promise<void> {
  const orange = await page.getByTestId(testId).evaluate((root) => {
    const hits: string[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const s = getComputedStyle(el);
      for (const c of [s.color, s.backgroundColor, s.borderTopColor]) {
        const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c);
        if (m && Number(m[1]) > 230 && Number(m[2]) > 100 && Number(m[2]) < 140 && Number(m[3]) < 90) hits.push(`${el.className}: ${c}`);
      }
    }
    return hits;
  });
  expect(orange, 'no orange on the card').toEqual([]);
}

/* ------------------------------------------------------------- the screen */

test('before the Batch 50 SQL is run, the two new cards say so plainly (the Batch 49 cards still work)', async ({ page }) => {
  await page.route(/\/rest\/v1\/rpc\/kaarbar_old_sales_status/, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function' }) })
  );
  await page.route(/\/rest\/v1\/rpc\/kaarbar_status/, (route) =>
    json(route, { start_date: '2026-11-13', today: '2026-11-18', locked_months: [], bill_nos: [], last_customers: null, last_expenses: null })
  );
  await openScreen(page, 'light');
  await expect(page.getByTestId('kb-old-needs-update')).toContainText('Batch 50 database update (migration-051)');
  await expect(page.getByTestId('kb-customers')).toBeVisible();
  await expect(page.getByTestId('kb-products')).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`Step 1 · Old products at 390 px (${theme}): auto matches, Needs you, the picker, hidden products, prices, save with the password (nothing real saved)`, async ({ page }) => {
    test.setTimeout(120_000);
    const captured: Captured = { items: null, units: null, bills: null };
    await answerKaarbar(page, captured, 'none');
    await openScreen(page, theme);
    await expect(page.getByTestId('kb-sales-locked')).toHaveText('Save the product list in Step 1 first.');

    await page.getByTestId('kb-products-file').setInputFiles({ name: 'Item List Report.xlsx', mimeType: XLSX, buffer: await itemListFile() });
    const preview = page.getByTestId('kb-products-preview');
    await expect(preview).toBeVisible({ timeout: 15_000 });
    const count = (id: string) => page.getByTestId(`kb-pcount-${id}`).locator('b');
    await expect(count('matched')).toHaveText('2');
    await expect(count('hand')).toHaveText('0');
    // No sure match: a new hidden product by default, tagged without opening the picker.
    await expect(count('hidden')).toHaveText('3');
    await expect(count('price')).toHaveText('2');
    // "Needs you" is the starting view (the two with no price).
    const rows = page.getByTestId('kb-item-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Hidden');
    await expect(page.getByTestId('kb-products-save')).toBeDisabled();
    await expect(page.getByTestId('kb-products-save-note')).toHaveText('2 items still need a product or a buying price.');
    const row = (name: string) => rows.filter({ hasText: name });
    await expect(row('Test Mystery Balm').getByTestId('kb-item-price')).toHaveAttribute('aria-invalid', 'true');

    // The matched ones, with the site's buying price.
    await page.getByRole('button', { name: /^Matched/ }).click();
    await expect(row('Test Gentle Cleanser 236 ML')).toContainText('Test Gentle Cleanser — 236 ml');
    await expect(row('Test Gentle Cleanser 236 ML')).toContainText('Auto');
    await expect(row('Test Gentle Cleanser 236 ML').getByTestId('kb-item-price')).toHaveValue('1500');
    await expect(row('Test Gentle Cleanser 236 ML')).toContainText('From the site. Change it if you paid differently then.');
    await page.getByRole('button', { name: /^All/ }).click();

    // Night Cream: two options → pick by hand.
    await row('Test Night Cream').getByTestId('kb-item-pick').click();
    const picker = page.getByTestId('kb-picker');
    await expect(picker).toBeVisible();
    // "+ Add as new hidden product" is the first row; arrow keys move down the list.
    await expect(picker.locator('.kb-picker__row').first()).toHaveAttribute('data-testid', 'kb-picker-hidden');
    await picker.getByLabel('Search site products').press('ArrowDown');
    await expect(picker.getByTestId('kb-picker-hidden')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(picker.getByTestId('kb-picker-choice').first()).toBeFocused();
    const scrolls = await picker.getByTestId('kb-picker-list').evaluate((el) => getComputedStyle(el).overflowY === 'auto' && el.clientHeight > 0);
    expect(scrolls, 'the list is its own scroll area').toBe(true);
    await noSidewaysScroll(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-01-step1-picker-open.png` });
    await picker.getByTestId('kb-picker-choice').filter({ hasText: '100 ml' }).click();
    await expect(picker).toBeHidden();

    // Old Serum and Mystery Balm are already new hidden products.
    await row('Test Mystery Balm').getByTestId('kb-item-price').fill('120');
    await expect(page.getByTestId('kb-products-save')).toBeEnabled();
    // The card's main button is near-black (light) / near-white (dark), never orange.
    const saveBg = await page.getByTestId('kb-products-save').evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = (/(\d+), (\d+), (\d+)/.exec(saveBg) ?? []).slice(1).map(Number);
    expect(theme === 'light' ? r + g + b < 150 : r + g + b > 600, `save button colour ${saveBg}`).toBe(true);

    await page.getByRole('button', { name: /^All/ }).click();
    await expect(row('Test Night Cream')).toContainText('Test Night Cream — 100 ml');
    await expect(row('Test Night Cream')).toContainText('By hand');
    await expect(row('Test Night Cream').getByTestId('kb-item-price')).toHaveValue('1600');
    await expect(row('Test Old Serum Discontinued')).toContainText('New hidden product');
    await expect(row('Test Old Serum Discontinued').getByTestId('kb-item-price')).toHaveValue('350');
    await expect(count('hidden')).toHaveText('2');
    await noSidewaysScroll(page);
    await noOrangeOnCard(page, 'kb-products');
    await page.getByTestId('kb-products').screenshot({ path: `${SHOTS}/${theme}-02-step1-list.png` });

    await page.getByTestId('kb-products-save').click();
    await page.getByTestId('kb-password').fill(E2E_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => captured.items).not.toBeNull();
    const sent = captured.items as { kaarbar_name: string; choice: string; product_id: string | null; variant_id: string | null; cost_per_pack: number }[];
    expect(sent).toHaveLength(5);
    expect(sent.find((r) => r.kaarbar_name === 'Test Night Cream')).toMatchObject({ choice: 'hand', product_id: P(3), variant_id: P(8), cost_per_pack: 1600 });
    expect(sent.find((r) => r.kaarbar_name === 'Test Mystery Balm')).toMatchObject({ choice: 'hidden', product_id: null, cost_per_pack: 120 });
    expect(sent.find((r) => r.kaarbar_name.startsWith('Test Gentle'))).toMatchObject({ choice: 'auto', product_id: P(1), variant_id: P(6) });
  });

  test(`Step 2 · Old sales at 390 px (${theme}): many PDFs, the Kaarbar check, old layout refused, per-ml price, a bill opened, import with the password (nothing real saved)`, async ({ page }) => {
    test.setTimeout(150_000);
    const captured: Captured = { items: null, units: null, bills: null };
    await answerKaarbar(page, captured, 'saved');
    await openScreen(page, theme);
    const card = page.getByTestId('kb-sales');
    await expect(card).toBeVisible();

    // Main: 2,000 + 4,230 + 850 + 1,000 = 8,080. Short: header says 1,600 (wrong on purpose).
    await page.getByTestId('kb-sales-file').setInputFiles([
      { name: 'party-one.pdf', mimeType: 'application/pdf', buffer: await statementPdf({ name: 'Test Party One', phone: '01799950001', headerTotal: '8,080', bills: 'main' }) },
      { name: 'party-old.pdf', mimeType: 'application/pdf', buffer: await statementPdf({ name: 'Test Party Old', phone: '01799950002', headerTotal: '100', layout: 'old', bills: 'short' }) },
      { name: 'party-two.pdf', mimeType: 'application/pdf', buffer: await statementPdf({ name: 'Test Party Two', phone: '01799950003', headerTotal: '1,600', bills: 'short' }) },
    ]);
    await expect(page.getByTestId('kb-statement-row')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId('kb-sales-file-error')).toContainText('This is the old statement layout.');
    const one = page.getByTestId('kb-statement-row').filter({ hasText: 'Test Party One' });
    await expect(one).toContainText('01799950001 · on the site');
    await expect(one).toContainText('2 bills to add · ৳5,080');
    await expect(one.getByTestId('kb-statement-ok')).toContainText('matches Kaarbar');
    const two = page.getByTestId('kb-statement-row').filter({ hasText: 'Test Party Two' });
    await expect(two).toContainText('not on the site');
    await expect(two.getByTestId('kb-statement-bad')).toHaveText('Does not match Kaarbar (৳1,500 vs ৳1,600)');
    const scount = (id: string) => page.getByTestId(`kb-scount-${id}`).locator('b');
    await expect(scount('new')).toHaveText('3');
    await expect(scount('already')).toHaveText('1');
    await expect(scount('after')).toHaveText('1');
    await expect(scount('unknown')).toHaveText('0');
    await expect(page.getByTestId('kb-sales-import')).toBeDisabled();
    await expect(page.getByTestId('kb-sales-import-note')).toContainText('does not match Kaarbar');
    await expect(page.getByTestId('kb-sales-import-note')).toContainText('1 price per piece / per ml to save.');

    // Sold by the ml: the price of 1 ml.
    const unit = page.getByTestId('kb-unit-row');
    await expect(unit).toHaveCount(1);
    await expect(unit).toContainText('Buying price of 1 ml');
    await unit.getByTestId('kb-unit-price').fill('4.65');
    await page.getByTestId('kb-unit-save').click();
    await expect.poll(() => captured.units).not.toBeNull();
    expect(captured.units?.[0]).toMatchObject({ unit: 'ml', cost: 4.65 });
    await expect(page.getByTestId('kb-unit-row')).toHaveCount(0);

    // Remove the file that does not match, then a bill opened.
    await page.getByRole('button', { name: 'Remove party-two.pdf' }).click();
    await page.getByTestId('kb-sales-file-error').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByTestId('kb-sales-import')).toBeEnabled();
    await expect(page.getByTestId('kb-sales-import')).toHaveText('Import 2 bills…');
    const bill = page.getByTestId('kb-bill-row').filter({ hasText: 'Bill B-101' });
    await bill.getByRole('button').click();
    const lines = bill.getByTestId('kb-bill-lines');
    await expect(lines).toContainText('Test Gentle Cleanser 236 ML (Australia/USA)');
    await expect(lines).toContainText('1 × ৳2,750 − ৳650');
    await expect(lines).toContainText('Delivery charge');
    await expect(lines.getByTestId('kb-bill-discount')).toContainText('−৳800');
    await expect(lines).toContainText('Bill total');
    await expect(page.getByTestId('kb-sales-note')).toHaveText(
      'Nothing else changes: stock, lots, Cash / bKash and customer dues stay as they are. These bills only appear in Profit & loss and in each customer’s history.'.replace('’', "'")
    );
    await noSidewaysScroll(page);
    await noOrangeOnCard(page, 'kb-sales');
    await bill.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/${theme}-03-step2-preview-bill-open.png` });
    await page.getByTestId('kb-sales').screenshot({ path: `${SHOTS}/${theme}-04-step2-card.png` });

    await page.getByTestId('kb-sales-import').click();
    await page.getByTestId('kb-password').fill(E2E_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect.poll(() => captured.bills).not.toBeNull();
    const sent = captured.bills as { bill_no: string; customer_key: string | null; bill_discount: number; delivery: number; bill_total: number; lines: { unit: string | null }[] }[];
    expect(sent.map((b) => b.bill_no)).toEqual(['B-101', 'B-102']);
    expect(sent[0]).toMatchObject({ customer_key: 'ph:01799950001', delivery: 130, bill_discount: 800, bill_total: 4230 });
    expect(sent[0].lines).toHaveLength(2);
    expect(sent[1].lines[0].unit).toBe('ml');
    expect(JSON.stringify(sent)).not.toMatch(/cost/i);
  });
}

/* -------------------------------------------- customer page and reports */

const FAKE_KEY = 'ph:01799950501';
const FAKE_PHONE = '01799950501';

async function mockRpc(page: Page, fn: string, reply: unknown | ((args: Record<string, unknown>) => unknown)): Promise<void> {
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const body = typeof reply === 'function' ? (reply as (a: Record<string, unknown>) => unknown)(args) : reply;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Customer page at 390 px (${theme}): Old purchases (Kaarbar), Edit → Correct previous balance with the password (nothing real saved)`, async ({ page }) => {
    test.setTimeout(90_000);
    const corrected: Record<string, unknown>[] = [];
    await mockRpc(page, 'admin_customers_v3', [
      {
        customer_key: FAKE_KEY, profile_id: null, full_name: 'E2E B50 Test Customer', email: '', phone: FAKE_PHONE, order_count: 1,
        total_spent: 300, total_due: 300, last_order_at: '2026-11-01T08:00:00Z', joined_at: null, all_orders: 1, hidden: false,
        note: null, alt_phone: null, added_by_hand: false, added_at: null,
      },
    ]);
    await mockRpc(page, 'admin_customer_orders_v2', []);
    await mockRpc(page, 'money_customer_dues', [
      { customer_key: FAKE_KEY, phone_key: FAKE_PHONE, order_due: 300, previous_left: 1200, latest_unpaid_order_id: null, latest_unpaid_order_number: null, last_reminder_at: null, last_reminder_amount: null, reminders: 0 },
    ]);
    await mockRpc(page, 'money_customer_history', () => ({
      phone_key: FAKE_PHONE,
      previous: [{ id: 'd1', amount: 1500, at: '2026-11-13T00:00:00Z', choice: 'kaarbar', kaarbar_amount: 1500, site_due_then: 0 }],
      previous_left: 1200,
      corrections: [{ id: 'c1', at: '2026-11-15T06:00:00Z', old_amount: 1500, new_amount: 1200, note: 'Typed wrong in Kaarbar', by: 'naeem' }],
      payments: [],
      reminders: [],
    }));
    await mockRpc(page, 'kaarbar_customer_old_bills', [
      {
        id: 'b1', kind: 'sale', bill_no: 'SS0877', date: '2026-05-18', items_total: 9700, bill_discount: 3601, delivery: 0, bill_total: 6099,
        lines: [
          { name: 'Test Serum A', quantity: 2, unit: null, rate: 2000, line_discount: 0, line_total: 4000 },
          { name: 'Test Lotion 473ml', quantity: 100, unit: 'ml', rate: 8.5, line_discount: 0, line_total: 850 },
        ],
      },
      { id: 'b2', kind: 'sale', bill_no: 'SS0858', date: '2025-11-12', items_total: 2100, bill_discount: 0, delivery: 130, bill_total: 2230, lines: [{ name: 'Test Cleanser', quantity: 1, unit: null, rate: 2750, line_discount: 650, line_total: 2100 }] },
    ]);
    await mockRpc(page, 'kaarbar_old_sales_status', {
      cutoff: '2026-09-30', items: [], choices: [], bill_keys: [], bills: 0, locked_months: [], last_products: null, last_sales: null,
    });
    await mockRpc(page, 'money_correct_previous_balance', (args) => {
      corrected.push(args);
      return { old: 1200, new: Number(args.p_new) };
    });

    await page.setViewportSize({ width: WIDTH, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
    await useSessionInPage(page, admin);
    await page.goto(`/admin/customers/${encodeURIComponent(FAKE_KEY)}`);
    await expect(page.getByTestId('customer-due-card')).toBeVisible({ timeout: 30_000 });

    // Old purchases (Batch 54: receipt cards; a tap opens the receipt page).
    const old = page.getByTestId('customer-old-purchases');
    await expect(old.getByTestId('merge-receipt')).toHaveCount(2);
    await expect(old.getByTestId('merge-receipt').first()).toContainText('SS0877');
    await expect(old.getByTestId('merge-receipt').first()).toContainText('৳6,099');
    await old.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/${theme}-05-customer-old-purchases.png` });
    await old.getByTestId('merge-receipt').first().click();
    await expect(page.getByTestId('old-receipt-page')).toContainText('100 ML × ৳8.50', { timeout: 30_000 });
    await expect(page.getByTestId('merge-totals')).toContainText('Bill discount');
    await page.getByTestId('merge-done').click();
    await expect(page.getByTestId('customer-due-card')).toBeVisible({ timeout: 30_000 });

    // Corrections list, then Edit → the sheet.
    await expect(page.getByTestId('customer-corrections')).toContainText('৳1,500 → ৳1,200');
    await expect(page.getByTestId('customer-corrections')).toContainText('Typed wrong in Kaarbar');
    await page.getByTestId('customer-previous-edit').click();
    await expect(page.getByTestId('correct-now')).toHaveText('৳1,200');
    await expect(page.getByTestId('correct-after')).toHaveText('Total due becomes ৳1,500. Cash and bKash do not change.');
    await page.getByTestId('correct-amount').fill('-5');
    await expect(page.getByTestId('correct-error')).toContainText('below 0');
    await page.getByTestId('correct-amount').fill('900');
    await page.getByTestId('correct-why').fill('Brought in twice');
    await expect(page.getByTestId('correct-after')).toHaveText('Total due becomes ৳1,200. Cash and bKash do not change.');
    await noSidewaysScroll(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-06-correct-previous-balance.png` });
    await page.getByTestId('correct-password').fill(E2E_ADMIN_PASSWORD);
    await page.getByTestId('confirm-sheet-confirm').click();
    await expect.poll(() => corrected.length).toBe(1);
    expect(corrected[0]).toEqual({ p_phone: FAKE_PHONE, p_new: 900, p_note: 'Brought in twice' });
  });
}

test('Profit & loss at 390 px: the old Kaarbar lines, with the note; the lines add up to Net profit', async ({ page }) => {
  test.setTimeout(60_000);
  const parts = {
    from: '2026-08-01', to: '2026-09-30', orders: 0, uncosted_orders: 0, items_missing_cost: 0, sales: 0, cost: 0, provisional: 0,
    delivery: 0, courier: 0, cost_adjustments: 0, expenses: 0, write_offs: 0, net_profit: 500, profit_share: 0, your_profit: 500,
    withdrawals: 0, left_in_business: 500, owner_money_in: 0, not_shop_money: 0, count_differences: 0, gross_profit: 400,
    old_bills: 3, old_sales_gross: 2400, old_bill_discounts: 600, old_sales: 1800, old_cost: 1400, old_delivery: 100, old_profit: 500,
  };
  await mockRpc(page, 'report_profit_loss', { from: '2026-08-01', to: '2026-09-30', parts, expenses_by_category: [], months: [], locked_months: [], start_date: '2026-11-13' });
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=reports&r=pnl');
  const table = page.getByTestId('pnl-table');
  await expect(table).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('pnl-old-note')).toContainText('Includes old Kaarbar sales (3 bills in these dates)');
  for (const [label, value] of [
    ['Old sales (Kaarbar)', '৳2,400'],
    ['Old bill discounts', '−৳600'],
    ['Old cost of goods (Kaarbar)', '−৳1,400'],
    ['Gross profit', '৳400'],
    ['Old delivery income (Kaarbar)', '৳100'],
    ['Net profit', '৳500'],
  ]) {
    await expect(table.getByRole('row').filter({ hasText: label }).first()).toContainText(value);
  }
  await noSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/light-07-profit-and-loss-old-lines.png`, fullPage: true });
});
