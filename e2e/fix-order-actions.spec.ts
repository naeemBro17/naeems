import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Download, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, pickStockedProduct, placeTestOrder, rpc, select, useSessionInPage, type TestSession } from './helpers/api';
import { pdfPageCount } from './helpers/invoicePdf';

/*
 * Fix 1.38.1 — order page actions and the invoice fold line.
 * Orders are real test orders (deleted again at the end); Steadfast is
 * never called (bookings are recorded straight in the database).
 * The invoice PDF checks (one fold line, 3 / 12 / 20 items) are in
 * src/lib/fixOrderActions.invoice.test.ts — the PDF code needs Vite.
 */

test.describe.configure({ mode: 'serial' });

const SCREENS = 'reports/fix-order-actions-screens';

let admin: TestSession;
let customer: TestSession;
let product: { id: string; name: string; stock: number };
const createdOrderIds: string[] = [];

const hasAccounts = Boolean(E2E_ADMIN_EMAIL && E2E_ADMIN_PASSWORD && E2E_EMAIL && E2E_PASSWORD);

async function newOrder(): Promise<{ id: string; orderNumber: string }> {
  const order = await placeTestOrder(customer.accessToken, product.id, 1);
  createdOrderIds.push(order.id);
  return order;
}

async function setStatus(orderId: string, status: string): Promise<void> {
  const res = await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: orderId, p_new_status: status });
  expect(res.ok, res.error ?? '').toBe(true);
}

/** Booked with a made-up consignment id — the database only. */
async function bookedOrder(): Promise<{ id: string; orderNumber: string; consignmentId: string }> {
  const order = await newOrder();
  await setStatus(order.id, 'confirmed');
  const consignmentId = `E2E-FIX-${Date.now()}`;
  const res = await rpc(admin.accessToken, 'admin_record_steadfast_shipment', {
    p_order_id: order.id,
    p_consignment_id: consignmentId,
    p_tracking_code: 'E2EFIX',
    p_tracking_link: '',
    p_courier_status: 'in_review',
  });
  expect(res.ok, res.error ?? '').toBe(true);
  return { ...order, consignmentId };
}

async function orderStatus(orderId: string): Promise<string | null> {
  const res = await select<{ status: string }[]>(admin.accessToken, `orders?select=status&id=eq.${orderId}`);
  return res.data?.[0]?.status ?? null;
}

async function stock(): Promise<number> {
  const res = await select<{ stock_quantity: number }[]>(null, `products_view?select=stock_quantity&id=eq.${product.id}`);
  return res.data?.[0]?.stock_quantity ?? -1;
}

async function openOrder(page: Page, orderNumber: string): Promise<Locator> {
  await useSessionInPage(page, admin);
  await page.goto(`/admin/orders/${orderNumber}`);
  const el = page.getByTestId('admin-order-page');
  await expect(el.getByTestId('order-step-label')).toBeVisible({ timeout: 15_000 });
  return el;
}

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  mkdirSync(SCREENS, { recursive: true });
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(150);
    const buffer = target ? await target.screenshot() : await page.screenshot();
    writeFileSync(join(SCREENS, `${name}-${theme}.png`), buffer);
  }
}

test.beforeAll(async () => {
  if (!hasAccounts) return;
  test.setTimeout(60_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(10);
  await rpc(admin.accessToken, 'admin_close_delete_lock');
});

test.afterAll(async () => {
  if (!hasAccounts || createdOrderIds.length === 0) return;
  test.setTimeout(120_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
  await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: createdOrderIds });
  await rpc(admin.accessToken, 'admin_close_delete_lock');
});

/* ------------------------------------------------------- Careful actions */

test.describe('order page actions', () => {
  test.skip(!hasAccounts, 'Needs the test accounts in .env.e2e.');

  test('one tap on a careful action does nothing; Cancel needs the number typed; booked shows the Steadfast warning', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const order = await newOrder();
    const el = await openOrder(page, order.orderNumber);

    // No "Other actions" any more; Invoice near the top, Careful actions last.
    await expect(el.getByRole('region', { name: 'Other actions' })).toHaveCount(0);
    await expect(el.getByTestId('invoice-card')).toBeVisible();
    const careful = el.getByTestId('careful-actions');
    await expect(careful).toBeVisible();
    await shot(page, 'invoice-card', el.getByTestId('invoice-card'));
    await careful.scrollIntoViewIfNeeded();
    await shot(page, 'careful-actions', careful);

    // One tap: only a sheet opens. Nothing changed in the database.
    await careful.getByTestId('careful-cancel').click();
    const sheet = page.getByTestId('confirm-sheet');
    await expect(sheet).toBeVisible();
    expect(await orderStatus(order.id)).toBe('pending');
    const digits = order.orderNumber.replace(/\D/g, '');
    const confirm = sheet.getByTestId('confirm-sheet-confirm');
    await expect(confirm).toBeDisabled();
    await expect(sheet.getByTestId('cancel-effects')).toContainText('1 item goes back to stock.');
    await sheet.getByTestId('confirm-sheet-input').fill(digits.slice(0, -1));
    await expect(confirm).toBeDisabled();
    await sheet.getByTestId('confirm-sheet-input').fill(digits);
    await expect(confirm).toBeEnabled();
    await sheet.getByRole('button', { name: 'Keep order' }).click();
    await expect(sheet).toHaveCount(0);
    expect(await orderStatus(order.id)).toBe('pending');

    // Delete: one tap opens the confirmation only.
    await careful.getByTestId('careful-delete').click();
    await expect(page.getByRole('dialog', { name: `Delete order ${order.orderNumber}?` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete order', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await orderStatus(order.id)).toBe('pending');

    // A booked order put back to Confirmed: the warning names the consignment.
    const booked = await bookedOrder();
    await setStatus(booked.id, 'confirmed');
    const el2 = await openOrder(page, booked.orderNumber);
    await el2.getByTestId('careful-cancel').click();
    const warning = page.getByTestId('confirm-sheet-warning');
    await expect(warning).toContainText(`This parcel is booked with Steadfast (${booked.consignmentId}). Cancelling here does not cancel it at Steadfast.`);
    await page.getByTestId('confirm-sheet-input').fill(booked.orderNumber.replace(/\D/g, ''));
    await shot(page, 'cancel-sheet');
    await page.getByRole('button', { name: 'Keep order' }).click();
    expect(await orderStatus(booked.id)).toBe('confirmed');

    // In transit: Mark delivered asks first.
    await setStatus(booked.id, 'shipped');
    const el3 = await openOrder(page, booked.orderNumber);
    await expect(el3.getByTestId('careful-cancel')).toHaveCount(0);
    await el3.getByTestId('careful-deliver').click();
    await expect(page.getByTestId('confirm-sheet')).toBeVisible();
    expect(await orderStatus(booked.id)).toBe('shipped');
    await page.getByRole('button', { name: 'Keep', exact: true }).click();
    expect(await orderStatus(booked.id)).toBe('shipped');
  });

  test('Reopen puts the order back to its old status and takes the stock again; refused when stock is short', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const order = await newOrder();
    await setStatus(order.id, 'confirmed');
    const before = await stock();

    // Cancel through the page (number typed).
    let el = await openOrder(page, order.orderNumber);
    await el.getByTestId('careful-cancel').click();
    await page.getByTestId('confirm-sheet-input').fill(order.orderNumber.replace(/\D/g, ''));
    await page.getByTestId('confirm-sheet-confirm').click();
    await expect(el.getByTestId('reopen-card')).toBeVisible({ timeout: 15_000 });
    await expect(el.getByTestId('reopen-card')).toContainText(/Cancelled .+ by /);
    expect(await orderStatus(order.id)).toBe('cancelled');
    expect(await stock()).toBe(before + 1);
    await shot(page, 'reopen-card', el.getByTestId('reopen-card'));

    // Short stock: the database's answer is shown, nothing changes.
    await page.route('**/rest/v1/rpc/admin_reopen_order', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ code: 'P0001', message: `Only 0 in stock for ${product.name}.`, details: null, hint: null }),
      })
    );
    await el.getByTestId('reopen-order').click();
    await expect(page.getByTestId('reopen-effects')).toContainText('goes back to Confirmed');
    await page.getByTestId('confirm-sheet-confirm').click();
    await expect(page.getByText(`Only 0 in stock for ${product.name}.`)).toBeVisible();
    expect(await orderStatus(order.id)).toBe('cancelled');
    await page.unroute('**/rest/v1/rpc/admin_reopen_order');
    await page.getByRole('button', { name: 'Keep cancelled' }).click();

    // Real reopen.
    el = await openOrder(page, order.orderNumber);
    await el.getByTestId('reopen-order').click();
    await page.getByTestId('confirm-sheet-confirm').click();
    await expect(el.getByTestId('order-step-label')).toHaveText('Confirmed', { timeout: 15_000 });
    expect(await orderStatus(order.id)).toBe('confirmed');
    expect(await stock()).toBe(before);

    // Logged in the order history and the Activity Log.
    const history = await select<{ old_status: string; new_status: string; note: string | null }[]>(
      admin.accessToken,
      `order_status_history?select=old_status,new_status,note&order_id=eq.${order.id}&order=changed_at.desc&limit=1`
    );
    expect(history.data?.[0]).toMatchObject({ old_status: 'cancelled', new_status: 'confirmed' });
    const log = await select<{ summary: string }[]>(
      admin.accessToken,
      `activity_log?select=summary&entity_id=eq.${order.id}&order=created_at.desc&limit=1`
    );
    expect(log.data?.[0]?.summary).toContain('cancelled → confirmed');

    // A second reopen is refused: the order is no longer cancelled.
    const res = await rpc(admin.accessToken, 'admin_reopen_order', { p_order_id: order.id });
    expect(res.ok).toBe(false);
    expect(res.error ?? '').toContain('Only a cancelled order can be reopened.');
  });

  test('Delete: an unbooked order deletes from the page and from the list; a booked one needs the Safety Lock', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });

    // Page: a Confirmed order, never booked.
    const one = await newOrder();
    await setStatus(one.id, 'confirmed');
    const before = await stock();
    const el = await openOrder(page, one.orderNumber);
    await el.getByTestId('careful-delete').click();
    const digits = one.orderNumber.replace(/\D/g, '');
    await expect(page.getByRole('dialog')).toContainText(`Type ${digits} to confirm`);
    await page.getByTestId('delete-orders-input').fill(digits);
    await expect(page.getByTestId('delete-orders-input')).toHaveValue(digits);
    await page.getByRole('button', { name: 'Delete order', exact: true }).click();
    await expect(page).toHaveURL(/\/admin(\?|$)/, { timeout: 15_000 });
    expect(await orderStatus(one.id)).toBeNull();
    expect(await stock()).toBe(before + 1);

    // List: tick the row, type the number, delete.
    const two = await newOrder();
    await useSessionInPage(page, admin);
    await page.goto(`/admin?tab=orders&oq=${two.orderNumber}`);
    const row = page.getByTestId('order-row').filter({ hasText: two.orderNumber });
    await row.getByRole('checkbox', { name: `Select order ${two.orderNumber} for deletion` }).check();
    await page.getByRole('button', { name: 'Delete selected (1)' }).click();
    await page.getByTestId('delete-orders-input').fill(two.orderNumber.replace(/\D/g, ''));
    await page.getByRole('button', { name: 'Delete order', exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    expect(await orderStatus(two.id)).toBeNull();

    // Booked: locked on the page and in the database.
    const booked = await bookedOrder();
    const el2 = await openOrder(page, booked.orderNumber);
    await expect(el2.getByTestId('careful-delete')).toBeDisabled();
    await expect(el2.getByTestId('careful-actions')).toContainText('need the Safety Lock');
    const res = await rpc<{ deleted: boolean; reason: string | null }[]>(admin.accessToken, 'admin_delete_orders', {
      p_order_ids: [booked.id],
    });
    expect(res.data?.[0]?.deleted).toBe(false);
    expect(res.data?.[0]?.reason ?? '').toContain('Safety Locks');
  });

  test('Invoice card: Print and Download make the PDF; Share falls back to a download', async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => {
      const opened: string[] = [];
      (window as unknown as { __opened: string[] }).__opened = opened;
      window.open = ((url?: string | URL) => {
        opened.push(String(url ?? ''));
        return null;
      }) as typeof window.open;
      Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
    });
    const order = await bookedOrder();
    const el = await openOrder(page, order.orderNumber);
    const card = el.getByTestId('invoice-card');
    await expect(card.getByTestId('invoice-printed')).toContainText(`INV-${order.orderNumber} · A4 · Not printed yet`);
    await expect(card.getByTestId('invoice-print')).toHaveClass(/adm-btn--primary/);

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }) as Promise<Download>,
      card.getByTestId('invoice-download').click(),
    ]);
    const bytes = new Uint8Array(readFileSync((await download.path()) as string));
    expect(Buffer.from(bytes.slice(0, 4)).toString()).toBe('%PDF');
    expect(await pdfPageCount(bytes)).toBe(1);
    await expect(card.getByTestId('invoice-printed')).toContainText('last printed');

    const [shared] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }) as Promise<Download>,
      card.getByTestId('invoice-share').click(),
    ]);
    expect(shared.suggestedFilename()).toBe(`Invoice-${order.orderNumber}.pdf`);
    await expect(page.getByText('Sharing is not supported here, so the PDF was downloaded.')).toBeVisible();

    await card.getByTestId('invoice-print').click();
    await expect
      .poll(async () => {
        const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
        const frames = await page.getByTestId('invoice-print-frame').count();
        return opened.some((u) => u.startsWith('blob:')) || frames > 0;
      })
      .toBe(true);
  });
});
