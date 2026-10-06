import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codAmountFor, courierCod, normalizeCollectMode } from '../../supabase/functions/_shared/cod';
import { legacyPaymentMethod, orderPaymentTag, planPayment } from './paymentPlan';
import { canOpenSubPage, parseAdminSubPage, safeAdminNext, subPageFallback, subPageSection } from './adminPages';
import { dueSummary, homeDateLabel } from './homeStats';
import { steadfastBanner } from './orderEdit';
import { formatTakaBd } from './adminNav';
import type { OrderWithDetails, StaffPermission } from '../types';

const money = (n: number) => formatTakaBd(n);

describe('Batch 32 Part 1 — the one COD rule', () => {
  it('full COD: nothing paid, collect on delivery → the courier collects the total', () => {
    expect(courierCod(1000, 0, 'cod')).toBe(1000);
  });
  it('advance + rest COD → the courier collects the rest', () => {
    expect(courierCod(1000, 300, 'cod')).toBe(700);
  });
  it('fully paid → ৳0', () => {
    expect(courierCod(1000, 1000, 'cod')).toBe(0);
    expect(courierCod(1000, 1200, 'cod')).toBe(0);
  });
  it('pay later → ৳0', () => {
    expect(courierCod(1000, 0, 'pay_later')).toBe(0);
  });
  it('advance + pay later → ৳0', () => {
    expect(courierCod(1000, 300, 'pay_later')).toBe(0);
  });
  it('a missing / unknown mode is the normal rule (existing orders behave as before)', () => {
    expect(normalizeCollectMode(undefined)).toBe('cod');
    expect(normalizeCollectMode(null)).toBe('cod');
    expect(normalizeCollectMode('anything')).toBe('cod');
    expect(courierCod(1000, 0, null)).toBe(1000);
  });
  it('the booking amount (codAmountFor, used by the steadfast function) follows it', () => {
    expect(codAmountFor({ payment_status: 'unpaid', total: 4079, collect_mode: 'pay_later' }, 4079)).toBe(0);
    expect(codAmountFor({ payment_status: 'unpaid', total: 4079, collect_mode: 'cod' }, 4079)).toBe(4079);
    expect(codAmountFor({ payment_status: 'unpaid', total: 1000, collect_mode: 'cod' }, 700)).toBe(700);
    // Before migration-035 (no collect_mode): exactly the Batch 30 rule.
    expect(codAmountFor({ payment_status: 'unpaid', total: 1000 }, 700)).toBe(700);
    expect(codAmountFor({ payment_status: 'paid', total: 1000 }, null)).toBe(0);
  });
  it('the steadfast function reads collect_mode and books with codAmountFor', () => {
    const source = readFileSync('supabase/functions/steadfast/index.ts', 'utf8');
    expect(source).toContain('alt_phone, courier_note, collect_mode');
    expect(source).toMatch(/const codAmount = codAmountFor\(order,/);
    expect(source).toMatch(/cod_amount: codAmount,/);
  });
});

describe('Batch 32 Part 1 — the payment section summary', () => {
  it('nothing typed: paid 0, courier collects all', () => {
    expect(planPayment({ total: 1500, paidNowInput: '', mode: 'cod', formatMoney: money })).toEqual({
      paidNow: 0,
      remaining: 1500,
      courierCollects: 1500,
      dueAfterDelivery: 0,
      error: null,
    });
  });
  it('advance + pay later: courier ৳0, the rest due after delivery', () => {
    expect(planPayment({ total: 1500, paidNowInput: '500', mode: 'pay_later', formatMoney: money })).toMatchObject({
      paidNow: 500,
      remaining: 1000,
      courierCollects: 0,
      dueAfterDelivery: 1000,
    });
  });
  it('paid more than the total, or below 0 → an inline error and nothing counted', () => {
    const over = planPayment({ total: 1500, paidNowInput: '1600', mode: 'cod', formatMoney: money });
    expect(over.error).toBe(`Paid now can be at most ${money(1500)}.`);
    expect(over.paidNow).toBe(0);
    expect(planPayment({ total: 1500, paidNowInput: '-5', mode: 'cod', formatMoney: money }).error).toBe('Enter an amount of 0 or more.');
  });
  it('Edit order: earlier payments count, a new one can only fill what is left', () => {
    const plan = planPayment({ total: 1000, paidNowInput: '200', mode: 'cod', alreadyPaid: 300, formatMoney: money });
    expect(plan).toMatchObject({ paidNow: 200, remaining: 500, courierCollects: 500, dueAfterDelivery: 0 });
    expect(planPayment({ total: 1000, paidNowInput: '800', mode: 'cod', alreadyPaid: 300, formatMoney: money }).error).not.toBeNull();
  });
  it('the old payment column stays meaningful', () => {
    expect(legacyPaymentMethod({ total: 1000, paidNow: 1000, method: 'bkash', mode: 'cod' })).toBe('bkash');
    expect(legacyPaymentMethod({ total: 1000, paidNow: 1000, method: 'nagad', mode: 'cod' })).toBe('cash');
    expect(legacyPaymentMethod({ total: 1000, paidNow: 300, method: 'bkash', mode: 'cod' })).toBe('cod');
    expect(legacyPaymentMethod({ total: 1000, paidNow: 0, method: null, mode: 'pay_later' })).toBe('due');
  });
});

describe('Batch 32 Part 1 — the order list tag', () => {
  const tag = (paid: number, mode: 'cod' | 'pay_later', total = 2000) =>
    orderPaymentTag(
      { total, status: 'confirmed', collect_mode: mode },
      { paid, due: Math.max(total - paid, 0), state: paid >= total ? 'paid' : paid > 0 ? 'partly_paid' : 'unpaid' },
      money
    );
  it('reads as the brief says', () => {
    expect(tag(0, 'cod')).toBe('COD');
    expect(tag(2000, 'cod')).toBe('Paid');
    expect(tag(1000, 'cod')).toBe(`Advance ${money(1000)} · rest COD`);
    expect(tag(0, 'pay_later')).toBe('Due · pays later');
    expect(tag(1000, 'pay_later')).toBe(`Advance ${money(1000)} · ${money(1000)} due later`);
  });
  it('says nothing for cancelled or refunded orders', () => {
    expect(orderPaymentTag({ total: 10, status: 'cancelled' }, { paid: 0, due: 10, state: 'unpaid' }, money)).toBeNull();
    expect(orderPaymentTag({ total: 10, status: 'delivered' }, { paid: 0, due: 10, state: 'refunded' }, money)).toBeNull();
  });
});

describe('Batch 32 Part 1 — "COD on Steadfast should now be"', () => {
  const order = (overrides: Partial<OrderWithDetails>): OrderWithDetails =>
    ({
      total: 4079,
      status: 'shipped',
      steadfast_consignment_id: 'C1',
      steadfast_status: 'pending',
      steadfast_cod_amount: 4079,
      steadfast_outdated: [],
      collect_mode: 'cod',
      ...overrides,
    }) as OrderWithDetails;
  const pay = (paid: number) => ({ total: 4079, paid, refunded: 0, due: 4079 - paid, overpaid: 0, state: 'unpaid' as const });
  it('switching NM-1721 style order to pay later asks for ৳0 on Steadfast', () => {
    expect(steadfastBanner(order({ collect_mode: 'pay_later' }), pay(0))).toEqual({ fields: [], codShouldBe: 0 });
  });
  it('after "Done, I updated Steadfast" (COD 0 saved) nothing is left to do', () => {
    expect(steadfastBanner(order({ collect_mode: 'pay_later', steadfast_cod_amount: 0 }), pay(0))).toBeNull();
  });
  it('a normal order is unchanged', () => {
    expect(steadfastBanner(order({}), pay(0))).toBeNull();
    expect(steadfastBanner(order({}), pay(79))).toEqual({ fields: [], codShouldBe: 4000 });
  });
});

describe('Batch 32 Part 3 — admin pages', () => {
  it('reads each page link', () => {
    expect(parseAdminSubPage('/admin')).toBeNull();
    expect(parseAdminSubPage('/admin/')).toBeNull();
    expect(parseAdminSubPage('/admin/orders/new')).toEqual({ kind: 'new-order' });
    expect(parseAdminSubPage('/admin/orders/NM-1721/edit')).toEqual({ kind: 'edit-order', orderNumber: 'NM-1721' });
    expect(parseAdminSubPage('/admin/products/new')).toEqual({ kind: 'new-product' });
    expect(parseAdminSubPage('/admin/products/abc-123/edit')).toEqual({ kind: 'edit-product', productId: 'abc-123' });
    expect(parseAdminSubPage('/admin/customers/new')).toEqual({ kind: 'new-customer' });
    expect(parseAdminSubPage('/admin/customers/ph%3A01712345678')).toEqual({ kind: 'customer', customerKey: 'ph:01712345678' });
    expect(parseAdminSubPage('/admin/orders')).toBe('unknown');
    expect(parseAdminSubPage('/admin/whatever/1')).toBe('unknown');
  });
  it('lights the right section and goes back to its list', () => {
    expect(subPageSection({ kind: 'edit-order', orderNumber: 'NM-1' })).toBe('orders');
    expect(subPageFallback({ kind: 'new-product' })).toBe('/admin?tab=products');
    expect(subPageFallback({ kind: 'customer', customerKey: 'p:1' })).toBe('/admin?tab=customers');
  });
  it('the same permission as the button that leads there', () => {
    const access = (perms: StaffPermission[], isAdmin = false) => ({ isAdmin, can: (p: StaffPermission) => isAdmin || perms.includes(p) });
    expect(canOpenSubPage({ kind: 'new-order' }, access(['view_orders']))).toBe(false);
    expect(canOpenSubPage({ kind: 'new-order' }, access(['create_orders']))).toBe(true);
    expect(canOpenSubPage({ kind: 'edit-order', orderNumber: 'X' }, access(['view_orders', 'create_orders']))).toBe(false);
    expect(canOpenSubPage({ kind: 'edit-order', orderNumber: 'X' }, access(['edit_orders']))).toBe(true);
    expect(canOpenSubPage({ kind: 'edit-product', productId: 'x' }, access(['edit_categories']))).toBe(false);
    expect(canOpenSubPage({ kind: 'new-customer' }, access(['view_customers']))).toBe(false);
    expect(canOpenSubPage({ kind: 'new-customer' }, access(['manage_customers']))).toBe(true);
    expect(canOpenSubPage({ kind: 'customer', customerKey: 'p:1' }, access([], true))).toBe(true);
  });
  it('after signing in, only ever back into the admin', () => {
    expect(safeAdminNext('/admin/orders/new')).toBe('/admin/orders/new');
    expect(safeAdminNext(null)).toBe('/admin');
    expect(safeAdminNext('https://evil.example/admin')).toBe('/admin');
    expect(safeAdminNext('//evil.example')).toBe('/admin');
    expect(safeAdminNext('/cart')).toBe('/admin');
  });
});

describe('Batch 32 Part 5 — Admin Home', () => {
  it('"৳X due from N customers" counts only customers who owe something', () => {
    expect(dueSummary([{ total_due: 500 }, { total_due: 0 }, { total_due: null }, { total_due: 1250.5 }])).toEqual({
      total: 1750.5,
      customers: 2,
    });
    expect(dueSummary([])).toEqual({ total: 0, customers: 0 });
  });
  it("today's date in Bangladesh time", () => {
    // 20:30 UTC on 6 Oct is already 7 Oct in Dhaka.
    expect(homeDateLabel(new Date('2026-10-06T20:30:00Z'))).toBe('Wednesday 7 October');
  });
});
