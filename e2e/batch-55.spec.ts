import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page, Route } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 55: one customer, many numbers — extra numbers (screen 1), "Same
// person?" in Merge old data (screen 2) and Merge two customers (screen 3).
//
// The live shop is never changed. The database rules (and the one-time
// Nabila Nur fix, pointed at the test customer login) run in
// e2e/sql/batch-55.sql against today's live functions (Batch 61: no old migration is replayed) inside ONE
// transaction that is always rolled back. The screens use made-up
// customers: every customer / number / merge call they make is answered in
// the browser, so nothing is saved and no real name appears in a picture.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-55-screens';
const MOCKUP = resolve('reports/batch-55-screens/mockups/customer-tools-mockup.html');
const WIDTH = 390;

let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

/* ------------------------------------------------------ the database rules */

test('database: extra numbers, grouping, Merge two customers (money identical), refusals, and the Nabila Nur fix on a made-up login (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const fix = readFileSync('supabase/fix-batch55-nabila-nur.sql', 'utf8').replace(/\r\n/g, '\n');
  const fixDo = fix.slice(fix.indexOf('DO $fix$'), fix.indexOf('$fix$;') + '$fix$;'.length);
  // The same fix, pointed at the test customer login instead of the real one.
  const testFix = fixDo.replace(
    "c_profile constant uuid := 'f05af719-446e-4d9b-82ff-8d6626e803fe';",
    `c_profile constant uuid := (SELECT id FROM auth.users WHERE lower(email) = lower('${E2E_EMAIL}'));`
  );
  expect(testFix, 'the fix names its login once').not.toBe(fixDo);
  const tests = readFileSync('e2e/sql/batch-55.sql', 'utf8')
    .replace(/\r\n/g, '\n')
    .replace('{{NABILA_FIX}}', () => testFix)
    .replace('{{NABILA_FIX_INNER}}', () => `EXECUTE $nabila$\n${testFix.slice(0, -1)}\n$nabila$;`)
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(40);
});

/* ------------------------------------------------------------ the answers */

const KEEP = { key: 'ph:01799955301', name: 'Test Rumana Akter', phone: '01799955301' };
const DUP = { key: 'ph:01799955302', name: 'Test Rumana', phone: '01799955302' };
const LOGIN_ID = '00000000-0000-4000-8000-000000005501';

interface Num {
  phone: string;
  phone_key: string;
  is_main: boolean;
  source: string | null;
  orders: number;
  bills: number;
  money_rows: number;
  can_remove: boolean;
}

interface World {
  numbers: Num[];
  dupGone: boolean;
  added: { phone: string; source: string }[];
  merged: { keep: string; remove: string } | null;
}

const main = (phone: string): Num => ({ phone, phone_key: phone, is_main: true, source: null, orders: 3, bills: 0, money_rows: 0, can_remove: false });
const extra = (phone: string, source: string): Num => ({ phone, phone_key: phone, is_main: false, source, orders: 0, bills: 0, money_rows: 0, can_remove: true });

function customerRow(key: string, name: string, phone: string, orders: number, due: number, over: Record<string, unknown> = {}) {
  return {
    customer_key: key, profile_id: null, full_name: name, email: '', phone, order_count: orders, total_spent: 0, total_due: due,
    last_order_at: null, joined_at: null, all_orders: orders, hidden: false, note: null, alt_phone: null, added_by_hand: true,
    added_at: '2026-11-13T00:00:00Z', ...over,
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const P = (n: number) => `00000000-0000-4000-8000-0000000055c${n}`;

async function answer(page: Page, w: World): Promise<void> {
  const rpc = (fn: string, reply: (args: Record<string, unknown>) => unknown) =>
    page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), (route) => json(route, reply((route.request().postDataJSON() ?? {}) as Record<string, unknown>)));
  await rpc('admin_customers_v3', () => [
    customerRow(KEEP.key, KEEP.name, KEEP.phone, 3, 27),
    ...(w.dupGone ? [] : [customerRow(DUP.key, DUP.name, DUP.phone, 2, 0)]),
    customerRow('ph:01799955303', 'Test Rumana Sultana', '01799955303', 5, 1450),
    customerRow(`p:${LOGIN_ID}`, 'Test Rumana Login', '01799955304', 1, 0, { profile_id: LOGIN_ID, email: 'rumana.login@example.com', added_by_hand: false }),
    customerRow('n:test rumana no phone', 'Test Rumana No Phone', '', 0, 0),
  ]);
  await rpc('admin_customer_orders_v2', () => []);
  await rpc('money_customer_dues', () => [
    { customer_key: KEEP.key, phone_key: KEEP.phone, order_due: 27, previous_left: 0, latest_unpaid_order_id: null, latest_unpaid_order_number: null, last_reminder_at: null, last_reminder_amount: null, reminders: 0 },
  ]);
  await rpc('money_customer_history', () => ({ phone_key: KEEP.phone, previous: [], previous_left: 0, corrections: [], payments: [], reminders: [] }));
  await rpc('kaarbar_customer_old_bills', () => []);
  await rpc('admin_customer_numbers', () => w.numbers);
  await rpc('admin_add_customer_number', (args) => {
    const phone = String(args.p_phone);
    if (phone === DUP.phone && !w.dupGone) return { added: false, same: false, owner_key: DUP.key, owner_name: DUP.name, owner_orders: 2 };
    w.added.push({ phone, source: String(args.p_source) });
    w.numbers = [...w.numbers, extra(phone, String(args.p_source))];
    return { added: true };
  });
  await rpc('admin_remove_customer_number', (args) => {
    w.numbers = w.numbers.filter((n) => n.phone_key !== String(args.p_phone));
    return { removed: true };
  });
  await rpc('admin_merge_preview', () => ({
    keep: { orders: 3, due: 27, previous: 0, bills: 0 },
    remove: { orders: 2, due: 0, previous: 0, bills: 4 },
    after: { orders: 5, due: 27 },
  }));
  await rpc('admin_merge_customers', (args) => {
    w.merged = { keep: String(args.p_keep_key), remove: String(args.p_remove_key) };
    w.dupGone = true;
    w.numbers = [...w.numbers, { ...extra(DUP.phone, 'merge'), orders: 2, can_remove: false }];
    return { merge_id: 'm', kept_name: KEEP.name, removed_name: DUP.name, moved: 9 };
  });
  await rpc('kaarbar_old_sales_status', () => ({
    cutoff: '2026-09-30',
    items: [
      {
        id: P(1), name_key: 'e2etestnightcream', kaarbar_name: 'E2E Test Night Cream', kaarbar_price: 0, product_id: P(2), variant_id: null,
        made_product_id: null, match_how: 'auto', cost_per_pack: 1600, unit_costs: {}, bill_lines: 1,
      },
    ],
    choices: [{ product_id: P(2), variant_id: null, name: 'Test Night Cream', option: null, is_active: true, stock_unit: 'pcs', pack_size: 1, cost_per_pack: 1600, made_by_import: false }],
    bill_keys: [], bills: 0, locked_months: [], last_products: null, last_sales: null,
  }));
}

function world(numbers: Num[] = [main(KEEP.phone)]): World {
  return { numbers, dupGone: false, added: [], merged: null };
}

// Kaarbar's newer layout (the column edges of a real statement), 2 paid bills.
async function statementPdf(name: string, phone: string): Promise<Buffer> {
  const TX = { date: 30, part: 109.1, total: 261.2, paid: 340.3, due: 419.4, bal: 498.4 };
  const IT = { name: 109.1, total: 261.2, qty: 340.3, rate: 419.4, disc: 498.4 };
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([595, 842]);
  const at = (s: string, x: number, y: number) => pg.drawText(s, { x, y, size: 9, font });
  at(`Party Statement of ${name}`, 31.5, 744.4);
  at('Total Sales (Sales - Sales Return):', 340.1, 740.7);
  at('Tk. 3,200', 522, 740.7);
  at('Phone', 32.2, 704.7);
  if (phone) at(phone, 84.4, 698.7);
  at('No:', 32.2, 693.4);
  at('Total Receivables:', 340.1, 661.9);
  at('Tk. 0', 522, 661.9);
  at('Total Transactions : 2', 24, 621.4);
  at('Report Generated on: 18 Nov 2026 - 6:56 PM', 392.8, 621.4);
  let y = 598.9;
  const line = (cells: [string, number][], dy = 17) => {
    for (const [s, x] of cells) at(s, x, y);
    y -= dy;
  };
  line([['Date', TX.date], ['Particulars', TX.part], ['Total', TX.total], ['Rec/Paid Amt', TX.paid], ['Due', TX.due], ['Running Balance', TX.bal]], 24);
  for (const [date, no] of [['09 Nov 2025', 'T-840'], ['02 Feb 2026', 'T-912']]) {
    line([[date, TX.date], [`Sale #${no}`, TX.part], ['Tk. 1,600', TX.total], ['Tk. 1,600', TX.paid], ['Tk. 0', TX.due], ['Tk. 0', TX.bal]]);
    line([['Items', IT.name], ['Total', IT.total], ['Quantity', IT.qty], ['Rate', IT.rate], ['Discount', IT.disc]]);
    line([['E2E Test Night Cream', IT.name], ['Tk. 1,600', IT.total], ['1', IT.qty], ['Tk. 1,600', IT.rate], ['--', IT.disc]]);
  }
  return Buffer.from(await doc.save());
}

async function open(page: Page, theme: 'light' | 'dark', path: string, width = WIDTH): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await useSessionInPage(page, admin);
  await page.goto(path);
}

async function openCustomer(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await open(page, theme, `/admin/customers/${encodeURIComponent(KEEP.key)}`);
  await expect(page.getByTestId('customer-numbers')).toBeVisible({ timeout: 30_000 });
}

async function upload(page: Page, pdf: Buffer): Promise<void> {
  await expect(page.getByTestId('merge-old-card')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('merge-old-file').setInputFiles({ name: 'statement.pdf', mimeType: 'application/pdf', buffer: pdf });
  await expect(page.getByTestId('merge-review')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('merge-chips')).toBeVisible({ timeout: 30_000 });
}

/** Before a screenshot: no toast left and every animation done. */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)
  );
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
}

/** The things on the screen that are the brand orange (CLAUDE.md: one),
 *  by class name. */
async function orangeThings(page: Page, within = '.adm-main'): Promise<string[]> {
  return page.evaluate((root) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll(root.split(',').map((s) => `${s.trim()} *`).join(', ')))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const m = /rgba?\((\d+), (\d+), (\d+)/.exec(getComputedStyle(el).backgroundColor);
      if (m && Number(m[1]) > 230 && Number(m[2]) > 80 && Number(m[2]) < 140 && Number(m[3]) < 90) out.push(String(el.className) || el.tagName);
    }
    return out;
  }, within);
}

/** One picture: the mockup's screen n (left) next to ours (right). */
async function compare(page: Page, n: number, ours: Buffer): Promise<void> {
  const mock = await page.context().newPage();
  await mock.setViewportSize({ width: 1800, height: 960 });
  await mock.goto(`file:///${MOCKUP.replace(/\\/g, '/')}`);
  const theirs = await mock.locator(`#s${n}`).screenshot();
  await mock.setContent(
    `<body style="margin:0;background:#d9d9de;font:700 14px system-ui">` +
      `<div style="display:flex;gap:28px;padding:20px;align-items:flex-start">` +
      `<div><p>Mockup ${n}</p><img style="width:390px" src="data:image/png;base64,${theirs.toString('base64')}"></div>` +
      `<div><p>Built (390 px, light)</p><img style="width:390px;border-radius:28px" src="data:image/png;base64,${ours.toString('base64')}"></div>` +
      `</div></body>`
  );
  await mock.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
  await mock.screenshot({ path: `${SHOTS}/compare-${n}.png`, fullPage: true });
  await mock.close();
}

/* ---------------------------------------------- screen 1: phone numbers */

test('screen 1 at 390 px (light): add an extra number (right label), remove it; a number that belongs to someone else offers the merge', async ({ page }) => {
  test.setTimeout(150_000);
  const w = world();
  await answer(page, w);
  await openCustomer(page, 'light');

  const card = page.getByTestId('customer-numbers');
  await expect(card.getByTestId('customer-number')).toHaveCount(1);
  await expect(card.getByTestId('customer-number').first()).toContainText('01799 955301');
  await expect(card.getByTestId('customer-number').first()).toContainText('Main number · used for delivery');
  await expect(card.getByTestId('customer-number').first()).toContainText('Main');
  await expect(card).toContainText('Orders, dues and Kaarbar bills on any of these numbers belong to this customer.');
  // The phone line moved into the card; email / "(alternative)" / joined lines stay.
  await expect(page.locator('.adm-customer__facts')).not.toContainText('01799955301');
  await expect(page.getByTestId('customer-more')).toContainText('Merge with another customer');

  await page.getByTestId('customer-number-add').click();
  const sheet = page.getByTestId('customer-number-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Use this for the customer's old or second number.");
  await expect(page.locator('.km-sheet .sheet-close')).toBeHidden();
  await page.getByTestId('customer-number-input').fill('01799 955309');
  await page.getByTestId('customer-number-save').click();
  await expect(sheet).toBeHidden();
  await expect(card.getByTestId('customer-number')).toHaveCount(2);
  await expect(card.getByTestId('customer-number').nth(1)).toContainText('01799 955309');
  await expect(card.getByTestId('customer-number').nth(1)).toContainText('Other number');
  expect(w.added).toEqual([{ phone: '01799955309', source: 'added' }]);

  await page.getByTestId('customer-number-more').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Remove this number?');
  await expect(dialog).toContainText('01799 955309 will no longer be linked to Test Rumana Akter.');
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(card.getByTestId('customer-number')).toHaveCount(1);

  // Someone else's number: who has it, and the way to merge them.
  await page.getByTestId('customer-number-add').click();
  await page.getByTestId('customer-number-input').fill(DUP.phone);
  await page.getByTestId('customer-number-save').click();
  await expect(page.getByTestId('customer-number-owner')).toHaveText('01799 955302 belongs to Test Rumana (2 orders).');
  await expect(page.getByTestId('customer-number-save')).toHaveCount(0);
  await noSidewaysScroll(page);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/s1-add-number-owner-390-light.png` });
  await page.getByTestId('customer-number-join').click();
  await expect(page).toHaveURL(/\/admin\/customers\/ph%3A01799955301\/join\?pick=ph%3A01799955302$/);
  await expect(page.locator('.ct-who--on')).toContainText('Test Rumana');
  await expect(page.getByTestId('join-preview')).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`screen 1 picture (${theme}): main number + an old number from Kaarbar`, async ({ page }) => {
    test.setTimeout(90_000);
    const w = world([main(KEEP.phone), extra('01799955308', 'kaarbar')]);
    await answer(page, w);
    await openCustomer(page, theme);
    await expect(page.getByTestId('customer-number').nth(1)).toContainText('Old number · saved from Kaarbar');
    // The new sections add no orange (the page's own buttons are not this batch's).
    expect(await orangeThings(page, '[data-testid="customer-numbers"], [data-testid="customer-more"]'), 'nothing orange in PHONE NUMBERS / MORE').toEqual([]);
    await noSidewaysScroll(page);
    await page.getByTestId('customer-numbers').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -110));
    await settle(page);
    const shot = await page.screenshot({ path: `${SHOTS}/s1-numbers-390-${theme}.png` });
    if (theme === 'light') await compare(page, 1, shot);
    await page.getByTestId('customer-more').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/s1-more-390-${theme}.png` });
  });
}

/* ------------------------------------------ screen 2: same person? */

for (const theme of ['light', 'dark'] as const) {
  test(`screen 2 at 390 px (${theme}): the numbers are different → Yes, same person → the box goes and Merge is possible`, async ({ page }) => {
    test.setTimeout(150_000);
    const w = world();
    await answer(page, w);
    await openCustomer(page, theme);
    await upload(page, await statementPdf('Test Rumana', '01799955308'));

    const box = page.getByTestId('merge-number-question');
    await expect(box).toBeVisible();
    await expect(box).toContainText('The numbers are different');
    await expect(box).toContainText('Kaarbar');
    await expect(box).toContainText('Test Rumana · 01799 955308');
    await expect(box).toContainText('This customer');
    await expect(box).toContainText('Test Rumana Akter · 01799 955301');
    await expect(box).toContainText('Is this the same person with an old number?');
    await expect(page.getByText("If you say yes, 01799 955308 is saved as Test Rumana Akter's old number, and the receipts below can be merged.")).toBeVisible();
    await expect(page.getByTestId('merge-receipts')).toHaveClass(/ct-dim/);
    await expect(page.getByTestId('merge-go')).toBeDisabled();
    await expect(page.getByTestId('merge-go-note')).toHaveText('Answer the question above first');
    await expect(page.getByTestId('merge-wrong-customer')).toHaveCount(0);
    expect(await orangeThings(page), 'nothing orange while Merge is off').toEqual([]);
    await noSidewaysScroll(page);
    await settle(page);
    const shot = await page.screenshot({ path: `${SHOTS}/s2-same-person-390-${theme}.png` });
    if (theme === 'light') await compare(page, 2, shot);

    await page.getByTestId('merge-number-yes').click();
    await expect(page.locator('.toast')).toContainText("Saved 01799 955308 as Test Rumana Akter's old number");
    await expect(box).toHaveCount(0);
    await expect(page.getByTestId('merge-receipts')).not.toHaveClass(/ct-dim/);
    await expect(page.getByTestId('merge-go')).toBeEnabled();
    expect(w.added).toEqual([{ phone: '01799955308', source: 'kaarbar' }]);
  });
}

test('screen 2: the old number belongs to another customer → "Merge that customer into this one first" opens Merge with that customer picked; "No, wrong customer" merges nothing', async ({ page }) => {
  test.setTimeout(150_000);
  const w = world();
  await answer(page, w);
  await openCustomer(page, 'light');
  await upload(page, await statementPdf('Test Rumana', DUP.phone));
  await page.getByTestId('merge-number-yes').click();
  const box = page.getByTestId('merge-number-question');
  await expect(box).toContainText('01799 955302 belongs to Test Rumana (2 orders). Merge that customer into this one first.');
  await expect(page.getByTestId('merge-number-yes')).toHaveCount(0);
  await expect(page.getByTestId('merge-number-join')).toHaveText('Merge Test Rumana into Test Rumana Akter');
  await expect(page.getByTestId('merge-go')).toBeDisabled();
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/s2-belongs-to-390-light.png` });
  await page.getByTestId('merge-number-join').click();
  await expect(page).toHaveURL(/\/join\?pick=ph%3A01799955302$/);
  await expect(page.locator('.ct-who--on')).toContainText('Test Rumana');

  // Back to the statement, then "No, wrong customer".
  await page.goBack();
  await expect(page.getByTestId('merge-number-question')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('merge-number-no').click();
  await expect(page.locator('.toast')).toContainText('Nothing was merged.');
  await expect(page.getByTestId('customer-numbers')).toBeVisible({ timeout: 30_000 });
  expect(w.added).toEqual([]);
});

/* ------------------------------------------ screen 3: merge two customers */

for (const theme of ['light', 'dark'] as const) {
  test(`screen 3 at 390 px (${theme}): search, reasons, pick, preview, merge, toast, the removed customer is gone`, async ({ page }) => {
    test.setTimeout(150_000);
    const w = world();
    await answer(page, w);
    await open(page, theme, `/admin/customers/${encodeURIComponent(KEEP.key)}/join`);
    const pageEl = page.getByTestId('join-customer');
    await expect(pageEl).toContainText('Pick the duplicate record of Test Rumana Akter. Everything from it moves here, and the duplicate is removed.', { timeout: 30_000 });
    await expect(page.getByTestId('join-merge')).toBeDisabled();
    await expect(page.getByTestId('join-merge')).toHaveText('Merge into Test Rumana Akter');
    await page.getByTestId('join-search').fill('rumana');
    const results = page.getByTestId('join-result');
    await expect(results).toHaveCount(4);
    await expect(results.nth(0)).toContainText('Test Rumana');
    await expect(results.nth(0)).toContainText('01799 955302 · 2 orders · ৳0 due');
    await expect(results.nth(1)).toContainText('01799 955303 · 5 orders · ৳1,450 due');
    await expect(results.nth(2)).toContainText('Has a login. Open it and merge this customer into it.');
    await expect(results.nth(2)).toBeDisabled();
    await expect(results.nth(3)).toContainText("No phone number, so it can't be merged.");
    await expect(results.nth(3)).toBeDisabled();

    await results.nth(0).click();
    await expect(results.nth(0)).toContainText('Selected');
    const preview = page.getByTestId('join-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(/Orders\s*3\s*2/);
    await expect(preview).toContainText(/Due on orders\s*৳27\s*৳0/);
    await expect(preview).toContainText(/Previous balance\s*৳0\s*৳0/);
    await expect(preview).toContainText(/Kaarbar bills\s*0\s*4/);
    await expect(page.getByTestId('join-after')).toHaveText('5 orders · ৳27');
    await expect(pageEl).toContainText('Test Rumana Akter keeps their name, main number and address. 01799 955302 is added as their old number.');
    await expect(page.getByTestId('join-merge')).toBeEnabled();
    expect(await orangeThings(page), 'one orange thing: Merge into …').toEqual(['km-btn km-btn--orange']);
    await noSidewaysScroll(page);
    await page.getByTestId('join-search').blur();
    await settle(page);
    const shot = await page.screenshot({ path: `${SHOTS}/s3-join-390-${theme}.png` });
    if (theme === 'light') await compare(page, 3, shot);

    if (theme === 'light') {
      await page.setViewportSize({ width: 1280, height: 900 });
      await settle(page);
      await page.screenshot({ path: `${SHOTS}/s3-join-1280-light.png` });
      await page.setViewportSize({ width: WIDTH, height: 844 });
    }

    await page.getByTestId('join-merge').click();
    await expect(page.locator('.toast')).toContainText('Merged Test Rumana into Test Rumana Akter');
    expect(w.merged).toEqual({ keep: KEEP.key, remove: DUP.key });
    await expect(page.getByTestId('customer-numbers')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('customer-number').nth(1)).toContainText('Old number · from a merged customer');

    // The removed customer is gone from the list.
    await page.goto(`/admin/customers/${encodeURIComponent(KEEP.key)}/join`);
    await page.getByTestId('join-search').fill('rumana');
    await expect(page.getByTestId('join-result')).toHaveCount(3);
    await expect(page.getByTestId('join-result').filter({ hasText: '01799 955302' })).toHaveCount(0);
  });
}
