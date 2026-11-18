import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import writeXlsxFile from 'write-excel-file/node';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 49: Admin → Import from Kaarbar.
//
// The live shop is never changed. The real database rules (Super Admin
// only, the password, customers never overwritten, dues never changed,
// Bill No de-duplication, PROFIT SHARE, the start-date money rule, month
// locks, both undos) run in e2e/sql/batch-49.sql together with the whole
// Batch 49 migration, inside ONE transaction that is always rolled back.
// The screen is driven at phone width with made-up Kaarbar files; the
// kaarbar_* database calls and the money lists are answered in the browser,
// so nothing is imported and no real name appears in a screenshot.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-49-screens';
const WIDTH = 360;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

/* ------------------------------------------------------ the database rules */

test('database: Super Admin only, password, customers import / undo, expenses import / undo, Bill No, PROFIT SHARE, start date, month locks (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const migration = readFileSync('supabase/migration-050-batch49.sql', 'utf8').replace(/\r\n/g, '\n');
  const body = migration.slice(migration.indexOf('\nBEGIN;\n') + 8, migration.lastIndexOf('\nCOMMIT;\n'));
  const tests = readFileSync('e2e/sql/batch-49.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${body}\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(40);
});

/* ---------------------------------------------------------- made-up files */

type Cell = { value: string | number | Date | null; type?: typeof Number | typeof String | typeof Date; format?: string } | null;

const text = (value: string): Cell => ({ value, type: String });
const num = (value: number): Cell => ({ value, type: Number });
const when = (y: number, m: number, d: number): Cell => ({ value: new Date(Date.UTC(y, m - 1, d, 11, 15)), type: Date, format: 'dd/mm/yyyy hh:mm' });

async function partyFile(): Promise<Buffer> {
  const rows: Cell[][] = [
    [null, null, null, null],
    [text('Party Name'), text('Contact'), text('Receivable'), text('Payable')],
    [text('Test Rahim Uddin'), text('01711-000001'), num(1500), num(0)],
    [text('Test Karim Store'), text('+880 1711 000002'), num(0), num(0)],
    [text('Test Karim Home'), text('8801711000002'), num(200), num(0)],
    [text('Test No Phone Shop'), null, num(0), num(0)],
    [text('Test Supplier Traders'), text('01811000003'), num(0), num(52000)],
    [text('Cash'), null, num(0), num(0)],
    [text('Walk-in'), null, num(0), num(0)],
    [text('Test Old Customer'), text('01911-000004'), num(1250), num(0)],
    [text('Test Nadia Akter'), text('01611000005'), num(0), num(0)],
  ];
  return writeXlsxFile(rows, { sheet: 'All Party Report' }).toBuffer();
}

async function expenseFile(): Promise<Buffer> {
  const rows: Cell[][] = [
    [],
    [text('Date'), text('Bill No'), text('Type'), text('Category'), text('Payment Mode'), text('Total Amount'), text('Notes/Remarks')],
    [when(2026, 11, 17), text('105'), text('Expense'), text('Utilities'), text('Cash'), num(800), null],
    [when(2026, 11, 15), text('97'), text('Expense'), text('Mobile Recharge'), text('bKash'), num(300), text('রিচার্জ — দুই নম্বরে\nsecond line')],
    [when(2026, 11, 14), text('101'), text('Expense'), text('PROFIT SHARE'), text('Cash'), num(10000), text('October share')],
    [when(2026, 11, 16), text('102'), text('Payment In'), text('Food'), text('Cash'), num(500), null],
    [when(2026, 11, 13), text('103'), text('Expense'), text('Food'), text('Card'), num(400), null],
    [when(2026, 10, 2), text('12'), text('Expense'), text('Shipping Cost'), text('Cash'), num(1200), text('Courier to Sylhet')],
    [when(2026, 9, 20), text('5'), text('Expense'), text('Subscriptions (Ai / Services)'), text('Cash'), num(2000), null],
    [when(2026, 8, 5), text('104'), text('Expense'), text('Gifts'), text('Cash'), num(700), null],
    [when(2026, 11, 16), text('106'), text('Expense'), text('food'), text('Cash'), num(250), text('Team lunch')],
  ];
  return writeXlsxFile(rows, { sheet: 'Expense Report' }).toBuffer();
}

/* --------------------------------------------------------- browser answers */

interface Captured {
  customers: unknown[] | null;
  expenses: unknown[] | null;
}

const ACCOUNTS = [
  { id: '00000000-0000-4000-8000-0000000000a1', name: 'Cash', kind: 'cash', payment_method: 'cash', sort_order: 1, archived: false },
  { id: '00000000-0000-4000-8000-0000000000a2', name: 'bKash', kind: 'bkash', payment_method: 'bkash', sort_order: 2, archived: false },
  { id: '00000000-0000-4000-8000-0000000000a3', name: 'With Steadfast', kind: 'steadfast', payment_method: 'cod_steadfast', sort_order: 9, archived: false },
];
const CATEGORIES = ['Food', 'Utilities', 'Subscriptions'].map((name, i) => ({ id: `00000000-0000-4000-8000-0000000000c${i}`, name, sort_order: i, archived: false }));
const INVESTORS = [
  { id: '00000000-0000-4000-8000-0000000000b1', name: 'Test Investor One', phone: null, kind: 'investor', note: null },
  { id: '00000000-0000-4000-8000-0000000000b2', name: 'Test Investor Two', phone: null, kind: 'investor', note: null },
];

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function answerKaarbar(page: Page, captured: Captured): Promise<void> {
  const status = {
    start_date: '2026-11-13',
    today: '2026-11-18',
    locked_months: ['2026-08'],
    bill_nos: ['105'],
    last_customers: null,
    last_expenses: null,
  };
  await page.route(/\/rest\/v1\/rpc\/kaarbar_/, async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    const body = (route.request().postDataJSON() ?? {}) as { p_rows?: { n: number; phone_key: string | null }[] };
    if (name === 'kaarbar_status') return json(route, status);
    if (name === 'kaarbar_customers_check') {
      return json(
        route,
        (body.p_rows ?? []).map((r) =>
          r.phone_key === '01911000004'
            ? { n: r.n, site_key: 'ph:01911000004', site_name: 'Test Old Customer (site)', site_due: 1000 }
            : { n: r.n, site_key: null, site_name: null, site_due: 0 }
        )
      );
    }
    if (name === 'kaarbar_import_customers') {
      captured.customers = body.p_rows ?? [];
      return json(route, { import_id: 'x', added: (body.p_rows ?? []).length, skipped: 0 });
    }
    if (name === 'kaarbar_import_expenses') {
      captured.expenses = body.p_rows ?? [];
      return json(route, { import_id: 'y', added: (body.p_rows ?? []).length, skipped: 0, total: 0, new_categories: 2 });
    }
    return route.abort();
  });
  await page.route(/\/rest\/v1\/money_accounts\?/, (route) => json(route, ACCOUNTS));
  await page.route(/\/rest\/v1\/money_categories\?/, (route) => json(route, CATEGORIES));
  await page.route(/\/rest\/v1\/parties_payable\?/, (route) => json(route, INVESTORS));
}

async function openScreen(page: Page): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height: 780 });
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=kaarbar');
  await expect(page.locator('.adm-page-header__title')).toHaveText('Import from Kaarbar', { timeout: 30_000 });
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
}

/* ------------------------------------------------------------- the screen */

test('before the Batch 49 SQL is run, the screen says so plainly', async ({ page }) => {
  await page.route(/\/rest\/v1\/rpc\/kaarbar_status/, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.kaarbar_status' }) })
  );
  await openScreen(page);
  await expect(page.getByTestId('kb-needs-update')).toContainText('needs the Batch 49 database update (migration-050)');
  await expect(page.getByTestId('kb-customers')).toHaveCount(0);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/01-needs-the-batch-49-update.png` });
});

test('Customers at 360 px: groups, counts, search, same-phone pair, dues to check, import with the password (nothing real saved)', async ({ page }) => {
  test.setTimeout(120_000);
  const captured: Captured = { customers: null, expenses: null };
  await answerKaarbar(page, captured);
  await openScreen(page);
  await page.screenshot({ path: `${SHOTS}/02-screen-before-a-file.png` });

  await page.getByTestId('kb-customers-file').setInputFiles({ name: 'All Party Report.xlsx', mimeType: XLSX, buffer: await partyFile() });
  const preview = page.getByTestId('kb-customers-preview');
  await expect(preview).toBeVisible({ timeout: 15_000 });
  const count = (id: string) => page.getByTestId(`kb-count-${id}`).locator('b');
  await expect(count('new')).toHaveText('2');
  await expect(count('existing')).toHaveText('1');
  await expect(count('samePhone')).toHaveText('2');
  await expect(count('noPhone')).toHaveText('1');
  await expect(count('supplier')).toHaveText('1');
  await expect(count('cashName')).toHaveText('2');

  const row = (name: string) => page.getByTestId('kb-customer-row').filter({ has: page.getByRole('checkbox', { name: `Import ${name}`, exact: true }) });
  await expect(row('Test Rahim Uddin')).toContainText('01711000001');
  await expect(row('Test Karim Store')).toContainText('01711000002');
  await expect(row('Test Rahim Uddin').getByRole('checkbox')).toBeChecked();
  await expect(row('Test No Phone Shop').getByRole('checkbox')).toBeChecked();
  await expect(row('Test Supplier Traders').getByRole('checkbox')).not.toBeChecked();
  await expect(row('Walk-in').getByRole('checkbox')).not.toBeChecked();
  await expect(row('Test Old Customer').getByRole('checkbox')).toBeDisabled();
  await expect(row('Test Old Customer')).toContainText('on the site as Test Old Customer (site)');
  await expect(row('Test Karim Store').getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('kb-customers-import')).toHaveText('Import 3…');
  await noSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/03-customers-preview.png`, fullPage: true });

  // Same phone: tick one, then the other — only one stays ticked.
  await row('Test Karim Store').getByRole('checkbox').check();
  await row('Test Karim Home').getByRole('checkbox').check();
  await expect(row('Test Karim Store').getByRole('checkbox')).not.toBeChecked();
  await expect(row('Test Karim Home').getByRole('checkbox')).toBeChecked();

  // Search and the group chips.
  await page.getByLabel('Search the parties').fill('1811');
  await expect(page.getByTestId('kb-customer-row')).toHaveCount(1);
  await page.getByLabel('Search the parties').fill('');
  await page.getByRole('button', { name: /^Same phone/ }).click();
  await expect(page.getByTestId('kb-customer-row')).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/04-customers-same-phone-pair.png` });
  await page.getByRole('button', { name: /^All/ }).click();

  // Dues: information only, both numbers.
  const dues = page.getByTestId('kb-due-check');
  await dues.locator('summary').click();
  await expect(dues.getByTestId('kb-due-row').filter({ hasText: 'Test Old Customer' })).toContainText('Kaarbar ৳1,250');
  await expect(dues.getByTestId('kb-due-row').filter({ hasText: 'Test Old Customer' })).toContainText('Site ৳1,000');
  await dues.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/05-customers-dues-to-check.png` });

  // Import → Careful actions + password.
  await page.getByTestId('kb-customers-import').click();
  await expect(page.getByTestId('kb-password')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/06-customers-import-password.png` });
  await page.getByTestId('kb-password').fill(E2E_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect.poll(() => captured.customers).not.toBeNull();
  const sent = captured.customers as { name: string; phone_key: string | null }[];
  expect(sent.map((r) => r.name).sort()).toEqual(['Test Karim Home', 'Test Nadia Akter', 'Test No Phone Shop', 'Test Rahim Uddin']);
  expect(sent.find((r) => r.name === 'Test No Phone Shop')?.phone_key).toBeNull();
  // No due, receivable or payable is ever sent.
  expect(JSON.stringify(sent)).not.toMatch(/receivable|payable|due/i);
});

test('Expenses at 360 px: counts, accounts going down, totals, PROFIT SHARE choice, locked month and unknown mode left out (nothing real saved)', async ({ page }) => {
  test.setTimeout(120_000);
  const captured: Captured = { customers: null, expenses: null };
  await answerKaarbar(page, captured);
  await openScreen(page);
  await page.getByTestId('kb-expenses-file').setInputFiles({ name: 'Expense Report.xlsx', mimeType: XLSX, buffer: await expenseFile() });
  const preview = page.getByTestId('kb-expenses-preview');
  await expect(preview).toBeVisible({ timeout: 15_000 });
  const count = (id: string) => page.getByTestId(`kb-count-${id}`).locator('b');
  await expect(count('new')).toHaveText('4 · ৳3,750');
  await expect(page.getByTestId('kb-count-new')).toContainText('(2 history)');
  await expect(count('profitShare')).toHaveText('1 · ৳10,000');
  await expect(count('already')).toHaveText('1');
  await expect(count('notExpense')).toHaveText('1');
  await expect(count('locked')).toHaveText('1');
  await expect(count('noAccount')).toHaveText('1');

  // Before the PROFIT SHARE row is placed: Cash −250, bKash −300.
  const down = page.getByTestId('kb-decreases');
  await expect(down).toContainText('Cash goes down (1)');
  await expect(down).toContainText('−৳250');
  await expect(down).toContainText('bKash goes down (1)');
  await expect(page.getByTestId('kb-categories')).toContainText('Mobile Recharge');
  await expect(page.getByTestId('kb-categories').locator('.inv-line', { hasText: 'food' })).not.toContainText('new category');
  await expect(page.getByTestId('kb-categories').locator('.inv-line', { hasText: 'Shipping Cost' })).toContainText('new category');
  await noSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/07-expenses-preview.png`, fullPage: true });

  // PROFIT SHARE: two investors, the note names neither — left out until picked.
  const share = page.getByTestId('kb-profit-share');
  await expect(share.getByTestId('kb-share-row').locator('select')).toHaveValue('');
  await expect(page.getByTestId('kb-expenses-import')).toHaveText('Import 4…');
  await share.getByTestId('kb-share-row').locator('select').selectOption({ label: 'Me — owner withdrawal' });
  await expect(page.getByTestId('kb-expenses-import')).toHaveText('Import 5…');
  await expect(down).toContainText('−৳10,250');
  await share.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/08-expenses-profit-share.png` });

  // The full list, newest first, with the note kept as written.
  const list = page.getByTestId('kb-expense-row');
  await expect(list.first()).toContainText('Bill 105');
  await expect(list.filter({ hasText: 'Bill 97' }).locator('.kb-note')).toHaveText('রিচার্জ — দুই নম্বরে\nsecond line');
  await expect(list.filter({ hasText: 'Bill 104' })).toContainText('month is locked');
  await page.getByRole('button', { name: /^Month is locked/ }).click();
  await expect(list).toHaveCount(1);
  await page.getByRole('button', { name: /^All/ }).click();
  await list.filter({ hasText: 'Bill 97' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/09-expenses-list.png` });

  await page.getByTestId('kb-expenses-import').click();
  await expect(page.getByTestId('kb-password')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/10-expenses-import-password.png` });
  await page.getByTestId('kb-password').fill(E2E_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect.poll(() => captured.expenses).not.toBeNull();
  const sent = captured.expenses as { bill_no: string; kind: string; account_id: string; date: string; note: string }[];
  expect(sent.map((r) => r.bill_no).sort()).toEqual(['101', '106', '12', '5', '97']);
  expect(sent.find((r) => r.bill_no === '101')?.kind).toBe('owner_withdrawal');
  expect(sent.filter((r) => r.kind === 'expense')).toHaveLength(4);
  expect(sent.find((r) => r.bill_no === '97')).toMatchObject({ account_id: ACCOUNTS[1].id, date: '2026-11-15', note: 'রিচার্জ — দুই নম্বরে\nsecond line' });
});

test('a customer account never sees the screen', async ({ page }) => {
  const customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  let asked = false;
  await page.route(/\/rest\/v1\/rpc\/kaarbar_/, (route) => {
    asked = true;
    return route.abort();
  });
  await page.setViewportSize({ width: WIDTH, height: 780 });
  await useSessionInPage(page, customer);
  await page.goto('/admin?tab=kaarbar');
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('kb-customers')).toHaveCount(0);
  await expect(page.getByText('Import from Kaarbar')).toHaveCount(0);
  expect(asked).toBe(false);
});
