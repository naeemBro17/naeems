import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import {
  makeTestProduct,
  passwordSession,
  placeTestOrder,
  removeTestProducts,
  rpc,
  useSessionInPage,
  withTestProductsShown,
  type TestSession,
} from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 65: note to customer + "Customer paid delivery charge" on returns.
//
// The database rules are tested in e2e/sql/batch-65.sql (one transaction,
// always rolled back). The screens use ONE made-up order on a made-up
// product (deleted in afterAll). What the screens read about the note and
// the return is changed in the browser, and every save (send note, mark
// seen, mark returned, change the amount) is answered in the browser, so
// nothing about this batch is written to Supabase. No real Storage file is
// downloaded (./fixtures).

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-65-screens';
const NOTE = 'Your parcel leaves tomorrow morning.\nThe rider will call you before he comes.';
/** Columns migration-062 adds; taken out of the real read (they may not
 *  exist yet) and answered from the test's own state. */
const NEW_COLUMNS = ['note_to_customer', 'note_to_customer_at', 'note_to_customer_seen_at', 'return_delivery_paid'];

let admin: TestSession;
let customer: TestSession;
let order: { id: string; orderNumber: string };
let productId = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  const product = await makeTestProduct();
  productId = product.id;
  order = await withTestProductsShown([product.id], () => placeTestOrder(customer.accessToken, product.id, 1));
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  if (order) {
    const res = await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: [order.id] });
    expect(res.ok, res.error ?? '').toBe(true);
  }
  if (productId) await removeTestProducts(admin.accessToken);
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) };
}

/** Answers an RPC in the browser; returns the arguments of every call. */
async function mockRpc(page: Page, fn: string, reply: (args: Record<string, unknown>) => unknown): Promise<Record<string, unknown>[]> {
  const calls: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push(args);
    await route.fulfill(json(reply(args)));
  });
  return calls;
}

/** The real read of the test order, with `fields()` laid over it. */
async function orderFields(page: Page, fields: () => Record<string, unknown>): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith('/rest/v1/orders') && url.searchParams.get('id') === `eq.${order.id}`,
    async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const url = new URL(route.request().url());
      const select = (url.searchParams.get('select') ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c !== '' && !NEW_COLUMNS.includes(c));
      url.searchParams.set('select', select.join(','));
      const response = await route.fetch({ url: url.toString() });
      const body: unknown = await response.json();
      const extra = fields();
      const merged = Array.isArray(body)
        ? body.map((r: Record<string, unknown>) => ({ ...r, ...extra }))
        : body && typeof body === 'object'
          ? { ...(body as Record<string, unknown>), ...extra }
          : body;
      await route.fulfill({ response, json: merged });
    }
  );
}

/** The shop reads its theme once when the page loads (ThemeContext), so a
 *  later system change does not switch it: set both. */
async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, scheme);
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
}

/** Orange-filled elements inside `root` (the shop's #ff7a45 or the admin's
 *  --adm-or #f2592a). */
async function orangeCount(page: Page, root: string): Promise<number> {
  return page.evaluate((sel) => {
    const scope = document.querySelector(sel);
    if (!scope) return -1;
    const orange = ['rgb(255, 122, 69)', 'rgb(242, 89, 42)'];
    return [...scope.querySelectorAll('*')].filter((el) => {
      const bg = getComputedStyle(el).backgroundColor;
      const r = el.getBoundingClientRect();
      return orange.includes(bg) && r.width > 0 && r.height > 0;
    }).length;
  }, root);
}

/* ------------------------------------------------------------- database */

test('database: note set / edit / remove, seen, own orders only, returns with ৳80 paid, balance check (rolled back)', async () => {
  test.setTimeout(240_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  // The migration runs first in the same transaction (safe to run more
  // than once), so this works before and after Naeem has run it.
  const migration = readFileSync('supabase/migration-062-batch65.sql', 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
  const script = readFileSync('e2e/sql/batch-65.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${migration}\n${script}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(45);
});

/* ------------------------------------------------------- customer side */

/** The note as the database would hand it to her, until she has seen it. */
async function noteFromNaeem(page: Page, sentAt: string) {
  const state = { seen: false };
  const unseen = await mockRpc(page, 'my_unseen_order_note', () =>
    state.seen ? [] : [{ order_id: order.id, order_number: order.orderNumber, note: NOTE, note_at: sentAt }]
  );
  const seen = await mockRpc(page, 'mark_order_note_seen', () => {
    state.seen = true;
    return null;
  });
  await orderFields(page, () => ({ note_to_customer: NOTE, note_to_customer_at: sentAt, note_to_customer_seen_at: null }));
  return { state, unseen, seen };
}

test('Customer: the card shows once on Home; OK marks it seen; after a reload it is gone', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsTestCustomer(page, { walletNoteSeen: true });
  const { unseen, seen } = await noteFromNaeem(page, new Date().toISOString());
  await page.goto('/shop');

  const pop = page.getByTestId('order-note-popup');
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(`Order ${order.orderNumber}`);
  await expect(pop).toContainText('A note about your order');
  await expect(pop).toContainText('The rider will call you before he comes.');
  await expect(pop).toContainText("Note from Naeem's");
  await expect(page.getByRole('button', { name: 'View order' })).toBeFocused();
  expect(await orangeCount(page, '[data-testid="order-note-popup"]'), 'one orange button: View order').toBe(1);
  await page.waitForTimeout(400);
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/01-popup-home-390-light.png` });
  await setTheme(page, 'dark');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/02-popup-home-390-dark.png` });
  await setTheme(page, 'light');

  // The wallet card never shows with it.
  await expect(page.getByTestId('wallet-open-note')).toHaveCount(0);
  expect(unseen.length, 'asked once per app load').toBe(1);

  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(pop).toHaveCount(0);
  expect(seen.map((c) => c.p_order_id)).toEqual([order.id]);

  await page.reload();
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('order-note-popup')).toHaveCount(0);
});

test('Customer: Escape closes the card like OK', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsTestCustomer(page, { walletNoteSeen: true });
  const { seen } = await noteFromNaeem(page, new Date().toISOString());
  await page.goto('/account');
  await expect(page.getByTestId('order-note-popup')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('order-note-popup')).toHaveCount(0);
  expect(seen.length).toBe(1);
});

test('Customer: View order lands on the order with the note shown (My Orders at 390 px)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsTestCustomer(page, { walletNoteSeen: true });
  const { seen } = await noteFromNaeem(page, '2026-11-24T16:20:00Z');
  await page.goto('/orders');
  await expect(page.getByTestId('order-note-popup')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'View order' }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${order.id}$`), { timeout: 15_000 });

  const box = page.getByTestId('order-note');
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(box).toContainText("Note from Naeem's");
  await expect(box).toContainText('24 Nov, 10:20 PM');
  // Line breaks are kept.
  const lines = await box.locator('.onote__text').evaluate((el) => getComputedStyle(el).whiteSpace);
  expect(lines).toBe('pre-line');
  await expect(page.getByTestId('order-note-popup')).toHaveCount(0);
  expect(seen.length).toBeGreaterThanOrEqual(1);
  expect(seen.every((c) => c.p_order_id === order.id)).toBe(true);
  // No long or short dash in what the customer reads (the order number is data).
  const text = (await box.innerText()).replace(order.orderNumber, '');
  expect(text).not.toMatch(/[—–]/);
  await box.scrollIntoViewIfNeeded();
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/03-order-note-my-orders-390.png` });
});

test('Staff and visitors never get the card (no call made)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await mockRpc(page, 'my_unseen_order_note', () => [
    { order_id: order.id, order_number: order.orderNumber, note: NOTE, note_at: new Date().toISOString() },
  ]);
  await page.goto('/shop');
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('order-note-popup')).toHaveCount(0);
  await useSessionInPage(page, admin);
  await page.goto('/shop');
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('order-note-popup')).toHaveCount(0);
  expect(calls.length).toBe(0);
});

/* ---------------------------------------------------------- admin side */

async function adminOrderPage(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await useSessionInPage(page, admin);
  await page.goto(`/admin/orders/${order.orderNumber}`);
}

const SIZES: { width: number; label: string }[] = [
  { width: 390, label: '390' },
  { width: 1440, label: '1440' },
];

async function shootCard(page: Page, state: string): Promise<void> {
  const card = page.getByTestId('note-to-customer');
  for (const size of SIZES) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: size.width, height: 900 });
      await setTheme(page, scheme);
      await page.waitForTimeout(150);
      // Centred, so the page's sticky header never covers the card's top.
      await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await card.screenshot({ path: `${SHOTS}/admin-card-${state}-${size.label}-${scheme}.png` });
    }
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, 'light');
}

test('Admin: Note to customer card, empty → typing → Send note → sent → Seen; Back does not ask to discard', async ({ page }) => {
  test.setTimeout(120_000);
  const state: { note: string | null; at: string | null; seen: string | null } = { note: null, at: null, seen: null };
  await orderFields(page, () => ({ note_to_customer: state.note, note_to_customer_at: state.at, note_to_customer_seen_at: state.seen }));
  const sent = await mockRpc(page, 'admin_set_note_to_customer', (args) => {
    const text = String(args.p_note ?? '').trim();
    state.note = text === '' ? null : text;
    state.at = text === '' ? null : new Date().toISOString();
    state.seen = null;
    return null;
  });
  await adminOrderPage(page, 390);

  const card = page.getByTestId('note-to-customer');
  await expect(card).toBeVisible({ timeout: 20_000 });
  // Directly above "Tracking number and note".
  const order2 = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="note-to-customer"]');
    const b = document.querySelector('section[aria-label="Tracking number and note"]');
    return a && b ? a.nextElementSibling === b : false;
  });
  expect(order2, 'the card sits right above Tracking number and note').toBe(true);
  await expect(card.getByRole('button', { name: 'Send note' })).toBeDisabled();
  await noSideScroll(page);
  await shootCard(page, '1-empty');

  await card.getByLabel('Note to customer').fill(NOTE);
  await expect(card).toContainText(`${NOTE.length} / 500`);
  expect(await orangeCount(page, '[data-testid="note-to-customer"]'), 'no orange button in the note card').toBe(0);
  await shootCard(page, '2-typing');

  await card.getByRole('button', { name: 'Send note' }).click();
  await expect(page.getByTestId('note-to-customer-text')).toContainText('The rider will call you', { timeout: 15_000 });
  expect(sent.map((c) => c.p_note)).toEqual([NOTE]);
  await expect(card).toContainText('Sent');
  await expect(page.getByTestId('note-to-customer-seen')).toHaveCount(0);
  await shootCard(page, '3-sent');

  state.seen = new Date(Date.now() + 60_000).toISOString();
  await page.reload();
  await expect(page.getByTestId('note-to-customer-seen')).toBeVisible({ timeout: 20_000 });
  await shootCard(page, '4-seen');

  // Edit → Cancel, then Remove.
  await card.getByRole('button', { name: 'Edit' }).click();
  await expect(card.getByLabel('Note to customer')).toHaveValue(NOTE);
  await card.getByRole('button', { name: 'Cancel' }).click();
  await card.getByRole('button', { name: 'Remove' }).click();
  await expect(card.getByLabel('Note to customer')).toBeVisible({ timeout: 15_000 });
  expect(sent[sent.length - 1].p_note).toBe('');

  // Typing here never makes Back ask "Discard changes?".
  await card.getByLabel('Note to customer').fill('half typed');
  await page.getByRole('button', { name: 'Back to orders' }).first().click();
  await expect(page.getByText('Discard changes?')).toHaveCount(0);
});

test('Admin: Mark returned with ৳80 paid: the math, the call, then the Profit line and the Edit row', async ({ page }) => {
  test.setTimeout(120_000);
  const state = { status: 'delivered', paid: 0 };
  await orderFields(page, () => ({ status: state.status, return_delivery_paid: state.paid, note_to_customer: null }));
  await mockRpc(page, 'order_profit', () =>
    state.status === 'returned'
      ? {
          status: 'returned', costed: true, items_missing_cost: 0, sale: 0, cost: 0, provisional: 0, delivery: 0,
          return_delivery_paid: state.paid, courier: 120, courier_known: true, courier_kind: 'exact', courier_charge: 120,
          cod_fee: 0, bill_paid_separately: 0, profit: state.paid - 120, margin: null, counted_at: new Date().toISOString(),
          filled_adjustments: 0,
        }
      : {
          status: 'delivered', costed: true, items_missing_cost: 0, sale: 1000, cost: 600, provisional: 0, delivery: 80,
          courier: 120, courier_known: true, courier_kind: 'exact', courier_charge: 110, cod_fee: 10, bill_paid_separately: 0,
          profit: 360, margin: 36, counted_at: new Date().toISOString(), filled_adjustments: 0,
        }
  );
  const marked = await mockRpc(page, 'admin_mark_order_returned', (args) => {
    state.status = 'returned';
    state.paid = Number(args.p_customer_paid_delivery ?? 0);
    return true;
  });
  const changed = await mockRpc(page, 'admin_set_return_delivery_paid', (args) => {
    state.paid = Number(args.p_amount ?? 0);
    return null;
  });

  // The phone keyboard takes the lower part: a 390 × 500 screen.
  await adminOrderPage(page, 390);
  await expect(page.getByTestId('careful-return')).toBeVisible({ timeout: 20_000 });
  await page.setViewportSize({ width: 390, height: 500 });
  await page.getByTestId('careful-return').click();
  await expect(page.getByTestId('return-effects')).toContainText('1 item goes back to stock. The order counts no sale.');
  const field = page.getByTestId('return-delivery-paid');
  await field.fill('8a0');
  await expect(field).toHaveValue('80');
  const fontSize = await field.evaluate((el) => getComputedStyle(el).fontSize);
  expect(fontSize, '16 px so phones do not zoom').toBe('16px');
  const math = page.getByTestId('return-loss');
  await expect(math).toContainText('Courier charge');
  await expect(math).toContainText('Loss on this return');
  await expect(math).toContainText('৳40');
  await field.focus();
  await page.screenshot({ path: `${SHOTS}/05-mark-returned-390x500.png` });
  // The sheet scrolls: its confirm button can be reached.
  await page.getByTestId('confirm-sheet-input').fill(order.orderNumber.replace(/\D/g, ''));
  await page.getByTestId('confirm-sheet-confirm').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('confirm-sheet-confirm')).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/06-mark-returned-390x500-bottom.png` });
  await field.fill('150');
  await expect(math).toContainText('Gain on this return');
  await expect(math).toContainText('৳30');
  await field.fill('80');
  await page.getByTestId('confirm-sheet-confirm').click();

  await expect(page.getByTestId('order-step-label')).toHaveText('Returned', { timeout: 20_000 });
  expect(marked).toHaveLength(1);
  expect(marked[0]).toMatchObject({ p_order_id: order.id, p_customer_paid_delivery: 80 });

  await page.setViewportSize({ width: 390, height: 844 });
  const row = page.getByTestId('return-paid-row');
  await expect(row).toContainText('Customer paid delivery charge ৳80');
  const profit = page.getByTestId('order-profit');
  await expect(page.getByTestId('order-profit-return-paid')).toContainText('Delivery charge paid on return');
  await expect(page.getByTestId('order-profit-return-paid')).toContainText('+৳80');
  await expect(profit).toContainText('less what the customer paid');
  await profit.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/07-profit-card-returned.png` });

  // Change it later.
  await page.getByTestId('return-paid-edit').click();
  const edit = page.getByTestId('return-delivery-paid-edit');
  await expect(edit).toHaveValue('80');
  await edit.fill('');
  await page.getByTestId('confirm-sheet-confirm').click();
  await expect(row).toContainText('Customer paid no delivery charge', { timeout: 15_000 });
  expect(changed[0]).toMatchObject({ p_order_id: order.id, p_amount: 0 });
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/08-returned-row-no-charge.png` });
});

test('Admin: Mark returned with nothing typed sends the old two arguments (works before migration-062)', async ({ page }) => {
  test.setTimeout(90_000);
  const state = { status: 'shipped' };
  await orderFields(page, () => ({ status: state.status, return_delivery_paid: 0 }));
  const marked = await mockRpc(page, 'admin_mark_order_returned', () => {
    state.status = 'returned';
    return true;
  });
  await adminOrderPage(page, 390);
  await page.getByTestId('careful-return').click({ timeout: 20_000 });
  await page.getByTestId('confirm-sheet-input').fill(order.orderNumber.replace(/\D/g, ''));
  await page.getByTestId('confirm-sheet-confirm').click();
  await expect(page.getByTestId('order-step-label')).toHaveText('Returned', { timeout: 20_000 });
  expect(Object.keys(marked[0]).sort()).toEqual(['p_note', 'p_order_id']);
  await expect(page.getByTestId('return-paid-row')).toContainText('Customer paid no delivery charge');
});
