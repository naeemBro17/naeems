import { readFileSync, writeFileSync } from 'node:fs';
import type { Download, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, pickStockedProduct, placeTestOrder, rpc, select, useSessionInPage, type TestSession } from './helpers/api';
import { BARCODE_REGION, QR_REGION, decodeRegion, pdfPageCount, pdfPageText, renderPdfPage } from './helpers/invoicePdf';
import { invoiceShop } from '../src/lib/invoice/invoiceShop';
import type { AppSettings } from '../src/types';

// Batch 37: the new invoice and bulk print, in the real admin screens.
// Steadfast is never called: test orders are the test customer's, "booked"
// with made-up consignment ids in the database only, and deleted in
// afterAll. Settings are never written — the one settings test changes
// them only in the page's own copy of the answer.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

let admin: TestSession;
let customer: TestSession;
let product: { id: string; name: string; stock: number };
const createdOrderIds: string[] = [];
let printsReady = false;

/** A test order booked with a made-up numeric consignment id. */
async function bookedOrder(): Promise<{ id: string; orderNumber: string; consignmentId: string }> {
  const order = await placeTestOrder(customer.accessToken, product.id, 1);
  createdOrderIds.push(order.id);
  const confirm = await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: order.id, p_new_status: 'confirmed' });
  expect(confirm.ok, confirm.error ?? '').toBe(true);
  const consignmentId = `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`;
  const res = await rpc(admin.accessToken, 'admin_record_steadfast_shipment', {
    p_order_id: order.id,
    p_consignment_id: consignmentId,
    p_tracking_code: 'E2EB37',
    p_tracking_link: '',
    p_courier_status: 'in_review',
  });
  expect(res.ok, res.error ?? '').toBe(true);
  return { ...order, consignmentId };
}

async function liveShop() {
  const rows = await select<{ key: string; value: string | null }[]>(admin.accessToken, 'app_settings?select=key,value');
  const settings = Object.fromEntries((rows.data ?? []).map((r) => [r.key, r.value ?? ''])) as Partial<AppSettings>;
  return invoiceShop(settings);
}

const SCREENS = 'reports/batch-37-samples';

/** Saves a screenshot for the report. Windows can briefly lock the old
 *  file (virus scan), so the write is tried a few times. */
async function saveScreen(page: Page, name: string): Promise<void> {
  const png = await page.screenshot();
  for (let attempt = 1; ; attempt += 1) {
    try {
      writeFileSync(`${SCREENS}/${name}`, png);
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      await page.waitForTimeout(500);
    }
  }
}

async function downloadFromDialog(page: Page, screenshot?: string): Promise<Uint8Array> {
  const dialog = page.getByTestId('invoice-dialog');
  await expect(dialog.getByTestId('invoice-ready')).toBeVisible({ timeout: 30_000 });
  if (screenshot) await saveScreen(page, screenshot);
  const [download] = await Promise.all([
    page.waitForEvent('download') as Promise<Download>,
    dialog.getByRole('button', { name: 'Download PDF' }).click(),
  ]);
  return new Uint8Array(readFileSync((await download.path()) as string));
}

test.beforeAll(async () => {
  test.setTimeout(90_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(10);
  printsReady = (await select(admin.accessToken, 'order_invoice_prints?select=id&limit=1')).ok;
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  if (createdOrderIds.length > 0) {
    await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
    await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: createdOrderIds });
    await rpc(admin.accessToken, 'admin_close_delete_lock');
  }
});

test('order page → Invoice: A4 PDF, barcode scans to the consignment ID, QR to the group link, label = billed-to', async ({ page }) => {
  test.setTimeout(90_000);
  const order = await bookedOrder();
  const shop = await liveShop();
  await useSessionInPage(page, admin);
  await page.goto(`/admin/orders/${order.orderNumber}`);
  await page.getByRole('button', { name: 'Invoice', exact: true }).click();
  const bytes = await downloadFromDialog(page, 'screen-invoice-dialog.png');

  expect(await pdfPageCount(bytes)).toBe(1);
  const image = await renderPdfPage(bytes, 1, 3);
  expect(decodeRegion(image, BARCODE_REGION, 'code128')).toBe(order.consignmentId);
  if (shop.community.show) expect(decodeRegion(image, QR_REGION, 'qr')).toBe(shop.community.link);

  const text = (await pdfPageText(bytes)).join(' ');
  expect(text).toContain(`INV-${order.orderNumber}`);
  expect(text).toContain('Amount to collect');
  expect(text).not.toMatch(/\bSKU\b/i);

  const detail = await select<{ address_line: string; thana: string; district: string; total: number }[]>(
    admin.accessToken,
    `orders?select=address_line,thana,district,total&id=eq.${order.id}`
  );
  const row = detail.data![0];
  // The label prints the street line and "Thana, District" as separate lines,
  // "Billed to" joins them — both from the same text.
  for (const part of [row.thana, row.district]) expect(text).toContain(part);
  expect(text).toContain(Number(row.total).toLocaleString('en-IN'));
  await page.getByRole('button', { name: 'Close dialog' }).click();
});

test('settings change (QR link, box switched off) reflects in the PDF', async ({ page }) => {
  test.setTimeout(90_000);
  const order = await bookedOrder();
  let link = 'https://example.com/naeems-club';
  let show = 'true';
  await page.route(/\/rest\/v1\/app_settings\?/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const rows = ((await res.json()) as { key: string; value: string }[]).filter(
      (r) => r.key !== 'invoice_community_link' && r.key !== 'invoice_show_community'
    );
    rows.push({ key: 'invoice_community_link', value: link }, { key: 'invoice_show_community', value: show });
    return route.fulfill({ response: res, body: JSON.stringify(rows) });
  });
  await useSessionInPage(page, admin);
  await page.goto(`/admin/orders/${order.orderNumber}`);
  await page.getByRole('button', { name: 'Invoice', exact: true }).click();
  let image = await renderPdfPage(await downloadFromDialog(page), 1, 3);
  expect(decodeRegion(image, QR_REGION, 'qr')).toBe(link);

  link = 'https://example.com/unused';
  show = 'false';
  await page.reload();
  await page.getByRole('button', { name: 'Invoice', exact: true }).click();
  const bytes = await downloadFromDialog(page);
  image = await renderPdfPage(bytes, 1, 3);
  expect(decodeRegion(image, QR_REGION, 'qr')).toBeNull();
  expect((await pdfPageText(bytes)).join(' ')).not.toContain('skincare community');
});

test('bulk print: 3 ticked orders → one PDF of 3 pages in order-number order; "booked today" picks them; Printed is remembered', async ({ page }) => {
  test.setTimeout(150_000);
  const orders = [await bookedOrder(), await bookedOrder(), await bookedOrder()];
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=orders');
  await page.getByRole('button', { name: 'More actions for Orders' }).click();
  await page.getByRole('menuitem', { name: 'Print invoices' }).click();
  await expect(page.getByTestId('print-bar')).toBeVisible();

  // "All booked today, not printed yet" includes all three new orders.
  await page.getByTestId('print-booked-today').click();
  const search = page.getByRole('searchbox').first();
  for (const o of orders) {
    await search.fill(o.orderNumber);
    await expect(page.getByTestId('order-row')).toHaveCount(1);
    await expect(page.getByTestId('print-check')).toBeChecked();
  }

  // Now exactly these three: clear, then tick each.
  await page.getByRole('button', { name: 'Clear selection' }).click();
  for (const o of [...orders].reverse()) {
    await search.fill(o.orderNumber);
    await page.getByTestId('print-check').check();
  }
  await search.fill('');
  await expect(page.getByTestId('print-selected')).toBeVisible();
  await saveScreen(page, 'screen-print-mode.png');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByTestId('print-selected').click();
  const bytes = await downloadFromDialog(page, 'screen-print-dialog.png');
  expect(await pdfPageCount(bytes)).toBe(3);
  const sorted = [...orders].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber, 'en', { numeric: true }));
  for (const [i, o] of sorted.entries()) {
    expect((await pdfPageText(bytes, i + 1)).join(' ')).toContain(`INV-${o.orderNumber}`);
    const image = await renderPdfPage(bytes, i + 1, 3);
    expect(decodeRegion(image, BARCODE_REGION, 'code128')).toBe(o.consignmentId);
  }

  test.skip(!printsReady, 'migration-039 not run yet: printing works, the Printed mark needs the database addition.');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await search.fill(orders[0].orderNumber);
  await expect(page.getByTestId('order-printed-mark')).toBeVisible({ timeout: 15_000 });
  const prints = await select<{ order_id: string }[]>(
    admin.accessToken,
    `order_invoice_prints?select=order_id&order_id=in.(${orders.map((o) => o.id).join(',')})`
  );
  expect(new Set((prints.data ?? []).map((p) => p.order_id)).size).toBe(3);

  // Printed orders drop out of "booked today, not printed yet".
  await page.getByRole('button', { name: 'More actions for Orders' }).click();
  await page.getByRole('menuitem', { name: 'Print invoices' }).click();
  await page.getByTestId('print-booked-today').click();
  for (const o of orders) {
    await search.fill(o.orderNumber);
    await expect(page.getByTestId('print-check')).not.toBeChecked();
  }

  // History shows the print.
  await page.goto(`/admin/orders/${orders[0].orderNumber}`);
  await page.getByTestId('history-toggle').click();
  await expect(page.getByText('Invoice printed').first()).toBeVisible();
});
