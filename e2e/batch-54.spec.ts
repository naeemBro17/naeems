import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 54: "Merge old data" on a customer's page.
//
// The live shop is never changed. The database rules run in
// e2e/sql/batch-54.sql together with the whole Batch 54 migration inside
// ONE transaction that is always rolled back. The screens are driven at
// 390 px with a made-up party statement drawn here as a real PDF in
// Kaarbar's newer layout; every kaarbar_* / money call they make is
// answered in the browser, so nothing is saved and no real name appears in
// a screenshot.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-54-screens';
const WIDTH = 390;

let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

/* ------------------------------------------------------ the database rules */

test('database: Super Admin + password, items then bills in one call (all or nothing), linked to the customer, history only, undo keeps locked months and products (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const migration = readFileSync('supabase/migration-055-batch54.sql', 'utf8').replace(/\r\n/g, '\n');
  const body = migration.slice(migration.indexOf('\nBEGIN;\n') + 8, migration.lastIndexOf('\nCOMMIT;\n'));
  const tests = readFileSync('e2e/sql/batch-54.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${body}\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(25);
});

/* ------------------------------------------------------- made-up statement */

// Kaarbar's newer layout (the column edges of a real statement).
const TX = { date: 30, part: 109.1, total: 261.2, paid: 340.3, due: 419.4, bal: 498.4 };
const IT = { name: 109.1, total: 261.2, qty: 340.3, rate: 419.4, disc: 498.4 };

/** A party statement drawn as a real PDF: 3 bills up to the cut-off (one
 *  lost a line, one has an item that is not on the site) and 1 after it. */
async function statementPdf(opts: { name: string; phone: string; receivables: string }): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const at = (s: string, x: number, y: number) => page.drawText(s, { x, y, size: 9, font });
  at(`Party Statement of ${opts.name}`, 31.5, 744.4);
  at('Total Sales (Sales - Sales Return):', 340.1, 740.7);
  at('Tk. 9,730', 522, 740.7);
  // The newer layout: "Phone" and "No:" on two lines, the number between.
  at('Phone', 32.2, 704.7);
  at(opts.phone, 84.4, 698.7);
  at('No:', 32.2, 693.4);
  at('Total Receivables:', 340.1, 661.9);
  at(`Tk. ${opts.receivables}`, 522, 661.9);
  at('Total Transactions : 4', 24, 621.4);
  at('Report Generated on: 20 Nov 2026 - 6:56 PM', 392.8, 621.4);
  let y = 598.9;
  const line = (cells: [string, number][], dy = 17) => {
    for (const [s, x] of cells) at(s, x, y);
    y -= dy;
  };
  line([['Date', TX.date], ['Particulars', TX.part], ['Total', TX.total], ['Rec/Paid Amt', TX.paid], ['Due', TX.due], ['Running Balance', TX.bal]], 24);
  const tx = (date: string, no: string, total: string, paid: string, due: string) =>
    line([[date, TX.date], [`Sale #${no}`, TX.part], [`Tk. ${total}`, TX.total], [`Tk. ${paid}`, TX.paid], [`Tk. ${due}`, TX.due], [`Tk. ${due}`, TX.bal]]);
  const head = () => line([['Items', IT.name], ['Total', IT.total], ['Quantity', IT.qty], ['Rate', IT.rate], ['Discount', IT.disc]]);
  const item = (name: string[], total: string, qty: string, rate: string, disc: string[] = ['--']) => {
    const n = Math.max(name.length, disc.length);
    for (let i = 0; i < n; i++) {
      const cells: [string, number][] = [];
      if (name[i]) cells.push([name[i], IT.name]);
      if (i === 0) cells.push([`Tk. ${total}`, IT.total], [qty, IT.qty], [`Tk. ${rate}`, IT.rate]);
      if (disc[i]) cells.push([disc[i], IT.disc]);
      line(cells, i === n - 1 ? 17 : 11);
    }
  };
  tx('10 Jan 2026', 'M-101', '2,000', '2,000', '0');
  head();
  item(['E2E Test Night Cream'], '2,000', '1', '2,000');
  tx('18 May 2026', 'M-102', '4,230', '4,230', '0');
  head();
  item(['E2E Test Gentle Cleanser 236 ML', '(Australia/USA)'], '2,100', '1', '2,750', ['Tk. 650', '(23.63%)']);
  item(['E2E Test Mystery Balm'], '2,000', '1', '2,000');
  item(['Delivery Charge'], '130', '1', '130');
  at('Remarks:', 108.2, y);
  at('Paid in full', 157.2, y);
  y -= 24;
  // M-103 lost a ৳1,400 line in the export: it does not add up.
  tx('25 Sep 2026', 'M-103', '3,000', '0', '3,000');
  head();
  item(['E2E Test Night Cream'], '1,600', '1', '1,600');
  tx('05 Oct 2026', 'M-104', '500', '500', '0');
  head();
  item(['E2E Test Night Cream'], '500', '1', '500');
  return Buffer.from(await doc.save());
}

/* --------------------------------------------------------- the answers */

const FAKE_PHONE = '01799954501';
const FAKE_KEY = `ph:${FAKE_PHONE}`;
const P = (n: number) => `00000000-0000-4000-8000-00000000540${n}`;
const I = (n: number) => `00000000-0000-4000-8000-0000000054a${n}`;
const CHOICES = [
  { product_id: P(1), variant_id: P(6), name: 'Test Gentle Cleanser', option: '236 ml', is_active: true, stock_unit: 'pcs', pack_size: 1, cost_per_pack: 1500, made_by_import: false },
  { product_id: P(3), variant_id: P(8), name: 'Test Night Cream', option: '100 ml', is_active: true, stock_unit: 'pcs', pack_size: 1, cost_per_pack: 1600, made_by_import: false },
  { product_id: P(4), variant_id: null, name: 'Test Lip Balm', option: null, is_active: true, stock_unit: 'pcs', pack_size: 1, cost_per_pack: 280, made_by_import: false },
];
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

function item(id: string, name: string, product: string, variant: string | null, cost: number, how = 'auto') {
  return { id, name_key: key(name), kaarbar_name: name, kaarbar_price: 0, product_id: product, variant_id: variant, made_product_id: how === 'hidden' ? product : null, match_how: how, cost_per_pack: cost, unit_costs: {}, bill_lines: 2 };
}

interface World {
  previous: number;
  merged: Record<string, unknown>[] | null;
  items: Record<string, unknown>[] | null;
  undone: boolean;
  savedRows: Record<string, unknown>[] | null;
  corrected: number[];
}

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function answer(page: Page, w: World, ordersDue = 0): Promise<void> {
  const rpc = (fn: string, reply: (args: Record<string, unknown>) => unknown) =>
    page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), (route) => json(route, reply((route.request().postDataJSON() ?? {}) as Record<string, unknown>)));
  await rpc('admin_customers_v3', () => [
    {
      customer_key: FAKE_KEY, profile_id: null, full_name: 'E2E B54 Test Customer', email: '', phone: FAKE_PHONE, order_count: 0,
      total_spent: 0, total_due: ordersDue, last_order_at: null, joined_at: null, all_orders: 0, hidden: false,
      note: null, alt_phone: null, added_by_hand: true, added_at: '2026-11-13T00:00:00Z',
    },
  ]);
  await rpc('admin_customer_orders_v2', () => []);
  await rpc('money_customer_dues', () => [
    { customer_key: FAKE_KEY, phone_key: FAKE_PHONE, order_due: ordersDue, previous_left: w.previous, latest_unpaid_order_id: null, latest_unpaid_order_number: null, last_reminder_at: null, last_reminder_amount: null, reminders: 0 },
  ]);
  await rpc('money_customer_history', () => ({ phone_key: FAKE_PHONE, previous: [], previous_left: w.previous, corrections: [], payments: [], reminders: [] }));
  await rpc('money_correct_previous_balance', (args) => {
    w.previous = Number(args.p_new);
    w.corrected.push(w.previous);
    return { old: 0, new: w.previous };
  });
  await rpc('kaarbar_old_sales_status', () => ({
    cutoff: '2026-09-30',
    items: [
      item(I(1), 'E2E Test Gentle Cleanser 236 ML (Australia/USA)', P(1), P(6), 1500),
      item(I(3), 'E2E Test Night Cream', P(3), P(8), 1600),
      ...(w.merged ? [item(I(9), 'E2E Test Mystery Balm', P(9), null, 320, 'hidden')] : []),
    ],
    choices: [...CHOICES, ...(w.merged ? [{ ...CHOICES[2], product_id: P(9), name: 'E2E Mystery Balm (hidden)', is_active: false, made_by_import: true }] : [])],
    bill_keys: [],
    bills: 0,
    locked_months: [],
    last_products: null,
    last_sales: null,
  }));
  await rpc('kaarbar_merge_customer', (args) => {
    w.merged = (args.p_bills ?? []) as Record<string, unknown>[];
    w.items = (args.p_items ?? []) as Record<string, unknown>[];
    w.undone = false;
    return { import_id: 'm', added: w.merged.length, skipped: 0, total: 0, items_added: w.items.length, items_updated: 0, hidden_made: 1 };
  });
  await rpc('kaarbar_undo_customer_merge', () => {
    const removed = w.merged?.length ?? 0;
    w.undone = true;
    return { removed, total: 0, kept: [] };
  });
  await rpc('kaarbar_save_items', (args) => {
    w.savedRows = (args.p_rows ?? []) as Record<string, unknown>[];
    return { added: 0, updated: 1, hidden_made: 0 };
  });
  await rpc('kaarbar_customer_old_bills', () =>
    !w.merged || w.undone
      ? []
      : w.merged
          .map((b, n) => ({
            ...b,
            id: `00000000-0000-4000-8000-0000000054b${n}`,
            merged_at: '2026-11-20T10:00:00Z',
            from_merge: true,
            lines: ((b.lines ?? []) as Record<string, unknown>[]).map((l) => {
              const hidden = l.name_key === key('E2E Test Mystery Balm');
              return {
                name: l.kaarbar_name, quantity: l.quantity, unit: l.unit, rate: l.rate, line_discount: l.line_discount, line_total: l.line_total,
                item_id: hidden ? I(9) : l.name_key === key('E2E Test Night Cream') ? I(3) : I(1), name_key: l.name_key,
                match_how: hidden ? 'hidden' : 'auto', product_name: hidden ? 'E2E Mystery Balm (hidden)' : 'Test Night Cream', option: null,
              };
            }),
          }))
          .sort((a, b) => String((b as Record<string, unknown>).date).localeCompare(String((a as Record<string, unknown>).date)))
  );
}

async function open(page: Page, theme: 'light' | 'dark', width = WIDTH): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await useSessionInPage(page, admin);
  await page.goto(`/admin/customers/${encodeURIComponent(FAKE_KEY)}`);
  await expect(page.getByTestId('customer-due-card')).toBeVisible({ timeout: 30_000 });
}

async function upload(page: Page, pdf: Buffer): Promise<void> {
  await expect(page.getByTestId('merge-old-card')).toBeVisible();
  await page.getByTestId('merge-old-file').setInputFiles({ name: 'statement.pdf', mimeType: 'application/pdf', buffer: pdf });
  await expect(page.getByTestId('merge-review')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('merge-chips')).toBeVisible({ timeout: 30_000 });
}

/** Before a screenshot: no toast left and every sheet / card animation done. */
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

/** How many things on the screen are the brand orange (CLAUDE.md: one). */
async function orangeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    let n = 0;
    for (const el of Array.from(document.querySelectorAll('.adm-main *'))) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const m = /rgba?\((\d+), (\d+), (\d+)/.exec(s.backgroundColor);
      if (m && Number(m[1]) > 230 && Number(m[2]) > 80 && Number(m[2]) < 140 && Number(m[3]) < 90) n++;
    }
    return n;
  });
}

async function password(page: Page, button: string): Promise<void> {
  await page.getByTestId('kb-password').fill(E2E_ADMIN_PASSWORD);
  await page.getByRole('button', { name: button, exact: true }).click();
}

async function correct(page: Page, amount: string): Promise<void> {
  await page.getByTestId('merge-due-edit').click();
  await page.getByTestId('correct-amount').fill(amount);
  await page.getByTestId('correct-password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('confirm-sheet-confirm').click();
  await expect(page.getByTestId('confirm-sheet')).toBeHidden();
}

/* ------------------------------------------------------------- the screens */

for (const theme of ['light', 'dark'] as const) {
  test(`Merge old data at 390 px (${theme}): upload → review → Add as new → + Add a missing item → Merge → old purchases → change a match → Undo (nothing real saved)`, async ({ page }) => {
    test.setTimeout(240_000);
    const w: World = { previous: 3000, merged: null, items: null, undone: false, savedRows: null, corrected: [] };
    await answer(page, w);
    await open(page, theme);

    // Screen 1: the new section right after TO RECEIVE.
    const card = page.getByTestId('merge-old-card');
    await expect(card).toContainText("Bring in this customer's Kaarbar history");
    await expect(card).toContainText('Bills up to 30 Sep 2026 are shown here first. Nothing is saved until you press Merge.');
    await page.getByTestId('customer-due-card').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -60));
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-1-customer-merge-card.png` });

    // Screen 2: the review page.
    await upload(page, await statementPdf({ name: 'E2E B54 Test Customer', phone: FAKE_PHONE, receivables: '3,000' }));
    await expect(page).toHaveURL(/\/admin\/customers\/ph%3A01799954501\/merge$/);
    await expect(page.getByTestId('merge-sub')).toHaveText('E2E B54 Test Customer · statement of 20 Nov 2026');
    await expect(page.getByTestId('merge-wrong-customer')).toHaveCount(0);
    await expect(page.getByTestId('merge-chips')).toHaveText(/3 receipts\s*1 ready\s*1 needs a product\s*1 doesn't add up/);
    await expect(page.getByTestId('merge-later')).toHaveText('1 later bill is already on the site and is left out.');
    const receipts = page.getByTestId('merge-receipt');
    await expect(receipts).toHaveCount(3);
    await expect(receipts.nth(0)).toContainText('Sale #M-103');
    await expect(receipts.nth(0)).toContainText("Doesn't add up: ৳1,400 less than Kaarbar's total. Tap to check.");
    await expect(receipts.nth(0)).toContainText('Unpaid');
    await expect(receipts.nth(0)).toContainText('Bal: ৳3,000');
    await expect(receipts.nth(1)).toContainText('Paid in full');
    await expect(receipts.nth(1)).toContainText('1 item is not on the site');
    await expect(receipts.nth(2)).toContainText('Ready');
    await expect(receipts.nth(2)).toContainText('Bal: ৳0');
    await expect(page.getByTestId('merge-go')).toBeDisabled();
    await expect(page.getByTestId('merge-go')).toHaveText('Merge 3 receipts');
    await expect(page.getByTestId('merge-go-note')).toHaveText('Fix the 2 marked receipts first');
    await expect(page.getByTestId('merge-due-kaarbar')).toHaveText('৳3,000');
    await expect(page.getByTestId('merge-due-site')).toHaveText('৳3,000');
    await expect(page.getByTestId('merge-due-chip')).toHaveText('Same');
    await noSidewaysScroll(page);
    expect(await orangeCount(page), 'nothing orange while Merge is off').toBe(0);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-2-review.png` });
    await settle(page);
    await page.getByTestId('merge-due').screenshot({ path: `${SHOTS}/${theme}-5a-due-same.png` });

    // Screen 5 and 6: the site's due through the existing "Correct previous balance" sheet.
    await correct(page, '2200');
    await expect(page.getByTestId('merge-due-chip')).toHaveText('৳800 apart');
    await expect(page.getByTestId('merge-due')).toContainText("Fix the receipts, or edit the site's due, until they match.");
    await settle(page);
    await page.getByTestId('merge-due').screenshot({ path: `${SHOTS}/${theme}-5b-due-apart.png` });
    await correct(page, '0');
    await expect(page.getByTestId('merge-due-chip')).toHaveText('Site has ৳0');
    await settle(page);
    await page.getByTestId('merge-due').screenshot({ path: `${SHOTS}/${theme}-5c-due-site-zero.png` });
    await page.getByTestId('merge-due-edit').click();
    await expect(page.getByTestId('correct-kaarbar')).toHaveText(/Kaarbar says ৳3,000\s*Use this/);
    await page.getByTestId('correct-use-kaarbar').click();
    await expect(page.getByTestId('correct-amount')).toHaveValue('3000');
    await expect(page.getByTestId('correct-after')).toHaveText('Total due becomes ৳3,000. Cash and bKash do not change.');
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-6-correct-with-kaarbar.png` });
    await page.getByTestId('correct-password').fill(E2E_ADMIN_PASSWORD);
    await page.getByTestId('confirm-sheet-confirm').click();
    await expect(page.getByTestId('merge-due-chip')).toHaveText('Same');
    expect(w.corrected).toEqual([2200, 0, 3000]);

    // A receipt that lost a line: + Add a missing item.
    await receipts.nth(0).click();
    await expect(page).toHaveURL(/\/merge\/sale%3AM-103$/);
    await expect(page.getByTestId('merge-check')).toHaveText("Doesn't add up: ৳1,400 less than Kaarbar's total.");
    await page.getByTestId('merge-add-line').click();
    await page.getByTestId('merge-line-name').fill('E2E Test Night Cream');
    await page.getByTestId('merge-line-rate').fill('1400');
    await page.getByTestId('merge-line-total').fill('1400');
    await page.getByTestId('merge-line-save').click();
    await expect(page.getByTestId('merge-check')).toHaveText("Adds up to Kaarbar's total");
    await expect(page.getByTestId('merge-line')).toHaveCount(2);
    await expect(page.getByTestId('merge-line-remove')).toHaveCount(1);
    await page.getByTestId('merge-done').click();
    await expect(page.getByTestId('merge-review')).toBeVisible();

    // Screen 3 and 4: an item not on the site → Add as new.
    await receipts.nth(1).click();
    await expect(page).toHaveURL(/\/merge\/sale%3AM-102$/);
    await expect(page.getByTestId('merge-receipt-paid')).toHaveText('Paid');
    await expect(page.getByTestId('merge-match-none')).toHaveText('Not on the site');
    await expect(page.getByTestId('merge-line').first()).toContainText('1 × ৳2,750 · discount ৳650');
    await expect(page.getByTestId('merge-line').first().getByTestId('merge-match')).toContainText('Test Gentle Cleanser — 236 ml');
    await expect(page.getByTestId('merge-check')).toHaveText("Adds up to Kaarbar's total");
    await noSidewaysScroll(page);
    expect(await orangeCount(page), 'nothing orange on a receipt').toBe(0);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-3-receipt.png` });
    await page.getByTestId('merge-add-new').click();
    await expect(page.getByTestId('merge-add-name')).toHaveValue('E2E Test Mystery Balm');
    await page.getByTestId('merge-add-name').fill('E2E Mystery Balm (hidden)');
    await page.getByTestId('merge-add-price').fill('320');
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-4-add-new.png` });
    await page.getByTestId('merge-add-go').click();
    await expect(page.getByTestId('merge-match-none')).toHaveCount(0);
    await expect(page.getByTestId('merge-line').nth(1).getByTestId('merge-match')).toHaveText(/E2E Mystery Balm \(hidden\)\s*Hidden/);
    await page.getByTestId('merge-done').click();

    // Everything ready: Merge (the one orange button), with the password.
    await expect(page.getByTestId('merge-chips')).toHaveText(/3 receipts\s*3 ready/);
    await expect(page.getByTestId('merge-go')).toBeEnabled();
    expect(await orangeCount(page), 'one orange element: Merge').toBe(1);
    await page.getByTestId('merge-go').click();
    await expect(page.getByTestId('confirm-sheet')).toContainText('They are added to E2E B54 Test Customer\'s old purchases as history. Stock, money and dues do not change.');
    await password(page, 'Merge');
    await expect.poll(() => w.merged).not.toBeNull();
    const bills = w.merged as { bill_no: string; paid_amount: number; due_amount: number; note: string | null; bill_total: number; bill_discount: number; lines: { name_key: string; line_total: number }[] }[];
    expect(bills.map((b) => b.bill_no)).toEqual(['M-103', 'M-102', 'M-101']);
    expect(bills[0]).toMatchObject({ paid_amount: 0, due_amount: 3000, bill_total: 3000, bill_discount: 0 });
    expect(bills[0].lines.map((l) => l.line_total)).toEqual([1600, 1400]);
    expect(bills[1]).toMatchObject({ note: 'Paid in full', paid_amount: 4230, due_amount: 0 });
    expect(w.items).toEqual([
      expect.objectContaining({ name_key: key('E2E Test Mystery Balm'), choice: 'hidden', cost_per_pack: 320, product_name: 'E2E Mystery Balm (hidden)' }),
    ]);

    // Screen 7: back on the customer page, the old purchases.
    await expect(page.getByTestId('customer-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('merge-summary')).toContainText('3 receipts · ৳9,230');
    await expect(page.getByTestId('merge-summary')).toContainText('Merged 20 Nov 2026');
    await expect(page.getByTestId('customer-old-purchases').getByTestId('merge-receipt')).toHaveCount(3);
    await expect(page.getByTestId('merge-old-card')).toHaveCount(0);
    await page.getByTestId('customer-old-purchases').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -60));
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-7-old-purchases.png` });

    // A merged receipt: numbers read-only, the match can change (password).
    await page.getByTestId('customer-old-purchases').getByTestId('merge-receipt').nth(1).click();
    await expect(page.getByTestId('old-receipt-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('merge-add-line')).toHaveCount(0);
    await expect(page.getByTestId('merge-line-maths')).toHaveCount(0);
    await expect(page.getByTestId('merge-line').nth(1).getByTestId('merge-match')).toHaveText(/E2E Mystery Balm \(hidden\)\s*Hidden/);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-3s-saved-receipt.png` });
    await page.getByTestId('merge-line').nth(1).getByTestId('merge-match').click();
    await expect(page.getByTestId('kb-picker-note')).toHaveText('Changes this item in every old receipt (2).');
    await page.getByTestId('kb-picker-choice').filter({ hasText: 'Test Lip Balm' }).click();
    await password(page, 'Save');
    await expect.poll(() => w.savedRows).not.toBeNull();
    expect(w.savedRows).toEqual([expect.objectContaining({ name_key: key('E2E Test Mystery Balm'), choice: 'hand', product_id: P(4), cost_per_pack: 320 })]);
    await page.getByTestId('merge-done').click();

    // Undo this merge.
    await page.getByTestId('merge-undo').click();
    await expect(page.getByTestId('confirm-sheet')).toContainText("Removes these 3 receipts from E2E B54 Test Customer's old purchases. Products and buying prices stay.");
    await password(page, 'Undo');
    await expect(page.getByTestId('merge-old-card')).toBeVisible();
    expect(w.undone).toBe(true);
  });
}

test('the statement of another customer: a red notice and Merge stays off', async ({ page }) => {
  test.setTimeout(90_000);
  const w: World = { previous: 3000, merged: null, items: null, undone: false, savedRows: null, corrected: [] };
  await answer(page, w);
  await open(page, 'light');
  await upload(page, await statementPdf({ name: 'Someone Else', phone: '01799954999', receivables: '3,000' }));
  await expect(page.getByTestId('merge-wrong-customer')).toHaveText('This statement is for Someone Else (01799954999), not this customer.');
  await expect(page.getByTestId('merge-go')).toBeDisabled();
});

for (const theme of ['light', 'dark'] as const) {
  test(`Due box when only the site has a due (${theme}), and the review page at 1280 px`, async ({ page }) => {
    test.setTimeout(90_000);
    const w: World = { previous: 0, merged: null, items: null, undone: false, savedRows: null, corrected: [] };
    await answer(page, w, 1200);
    await open(page, theme);
    await upload(page, await statementPdf({ name: 'E2E B54 Test Customer', phone: FAKE_PHONE, receivables: '0' }));
    await expect(page.getByTestId('merge-due-chip')).toHaveText('Kaarbar has ৳0');
    await settle(page);
    await page.getByTestId('merge-due').screenshot({ path: `${SHOTS}/${theme}-5d-due-kaarbar-zero.png` });
    // "Use this" would make the previous balance negative: hidden.
    await page.getByTestId('merge-due-edit').click();
    await expect(page.getByTestId('correct-kaarbar')).toHaveText('Kaarbar says ৳0');
    await expect(page.getByTestId('correct-use-kaarbar')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId('merge-receipt')).toHaveCount(3);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-2-review-1280.png` });
    // On a computer the bar sits beside the sidebar, not under it.
    const bar = await page.locator('.km-bar').boundingBox();
    const side = await page.locator('.adm-sidebar').boundingBox();
    expect(bar && side ? bar.x >= side.x + side.width - 1 : false).toBe(true);
  });
}
