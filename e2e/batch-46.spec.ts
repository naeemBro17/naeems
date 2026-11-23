import { mkdirSync, readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, select, useSessionInPage } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 46: Steadfast payouts add up, and promo codes count only real
// orders.
//
// The live shop is never changed: e2e/sql/batch-46-payouts-promo.sql runs
// against today's live functions (Batch 61: no old migration is replayed) inside ONE transaction that is
// always rolled back — the throwaway product, promo code, orders and payout
// never exist outside it, and no real promo code count or payout changes.
// The payout screen test reads only made-up payouts (answered in the
// browser) and opens one existing order page; nothing is saved.

const SHOTS = 'reports/batch-46-screens';

// Batch 47: the offline helper (service worker) caches Supabase reads;
// once it controls the page it answers the second page itself and the
// made-up payout data below never reaches it.
test.use({ serviceWorkers: 'block' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');

test('database: payouts add up (delivered, prepaid, returned, courier only, deleted order), COD payment follows the payout, promo counted only by a real order and given back on cancel / delete (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const tests = readFileSync('e2e/sql/batch-46-payouts-promo.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(30);
  // Nothing of it stayed.
  const admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  const left = await select<unknown[]>(admin.accessToken, 'products?select=id&sku=like.E2E-B46-*');
  expect(left.data).toHaveLength(0);
  const codes = await select<unknown[]>(admin.accessToken, 'promo_codes?select=id&code=like.E2E-B46-*');
  expect(codes.data).toHaveLength(0);
});

/* ------------------------------------------------- the payout screen (390) */

function line(id: string, invoice: string, cod: number, charge: number, fee: number, extra: Record<string, unknown> = {}) {
  return {
    id, payout_id: 'p-b46', consignment_id: `c-${id}`, invoice, order_id: `o-${id}`, cod_collected: cod,
    delivery_charge: charge, cod_fee: fee, other_deduction: 0, net_paid: Math.round((cod - charge - fee) * 100) / 100,
    expected_cod: cod, match_status: 'matched', match_reason: null, note: null, line_kind: 'order', ...extra,
  };
}

// Made-up numbers in the shape of the real 1 Nov payout: a normal order, a
// prepaid one, NM-3315 (courier only), NM-1721 (returned, order deleted)
// and an order that was deleted and not settled.
const PAYOUT = {
  id: 'p-b46', steadfast_payment_id: 'SFC-B46', paid_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  total_amount: 2000 - 60 - 20 - 60 - 75 - 47.5 + (800 - 60 - 8), parcel_count: 5,
  steadfast_payout_items: [
    line('1', 'NM-5001', 2000, 60, 20),
    line('2', 'NM-5002', 0, 60, 0),
    line('3', 'NM-3315', 0, 75, 0, { order_id: null, line_kind: 'courier_only', note: 'Not a shop sale: courier only (the delivery charge was paid back)' }),
    line('4', 'NM-1721', 0, 47.5, 0, { order_id: null, line_kind: 'returned', note: 'Returned parcel (order deleted): no sale; the charge counts as a delivery cost' }),
    line('5', 'NM-5005', 800, 60, 8, { order_id: null, match_status: 'to_check', match_reason: 'order_not_found', note: 'Order not found' }),
  ],
};

test('payout screen at 390 px: courier-only and returned lines in grey, only the deleted order "to check", total adds up; a prepaid order says Steadfast collected nothing', async ({ page }) => {
  test.setTimeout(120_000);
  const admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  await page.route(/\/rest\/v1\/steadfast_payouts\?/, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    const one = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill(json(one ? PAYOUT : [PAYOUT]));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto('/admin/payouts/p-b46');
  const table = page.getByTestId('payout-table');
  await expect(table).toBeVisible({ timeout: 20_000 });
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(2)).toContainText('Not a shop sale: courier only');
  await expect(rows.nth(3)).toContainText('Returned parcel (order deleted)');
  await expect(table.locator('tr.is-check')).toHaveCount(1);
  await expect(rows.nth(4)).toContainText('To check: Order not found');
  await expect(page.getByTestId('payout-pill')).toHaveText('1 to check');
  await expect(page.getByTestId('payout-total')).toHaveText('৳2,470');
  await expect(page.getByTestId('payout-summary')).toContainText('3 orders');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/payout-detail-390.png`, fullPage: true });

  // An order Steadfast only charged (prepaid): never "Steadfast paid −৳61".
  const recent = await select<{ order_number: string }[]>(admin.accessToken, 'orders?select=order_number&status=eq.delivered&steadfast_consignment_id=not.is.null&order=created_at.desc&limit=1');
  const number = recent.data?.[0]?.order_number;
  test.skip(!number, 'No delivered order to open.');
  await page.route(/\/rest\/v1\/order_courier_costs\?/, (route) =>
    route.fulfill(json({ net_received: -60.76, total_kept: 60.76, paid_at: '2026-10-16T10:00:00Z', payout_id: 'p-b46', steadfast_payouts: { steadfast_payment_id: 'SFC-B46' } }))
  );
  await page.goto(`/admin/orders/${number}`);
  const paid = page.getByTestId('order-steadfast-paid');
  await expect(paid).toBeVisible({ timeout: 20_000 });
  await expect(paid).toContainText('Steadfast collected nothing and kept ৳61 in fees');
  await expect(paid).not.toContainText('−৳');
  await paid.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/order-prepaid-390.png` });
});
