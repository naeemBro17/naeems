import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allocatePayoutTotals,
  courierCostRow,
  matchItems,
  parcelNotDelivered,
  readPayoutItem,
  sumItems,
  type OrderForMatch,
} from '../../supabase/functions/_shared/steadfastPayouts';

// Batch 46: Steadfast payouts add up, and promo codes count only real
// orders. Nothing here talks to Steadfast or the database.

const calls: { table: string; op: string }[] = [];
let promoRow: Record<string, unknown> | null = null;

vi.mock('./supabase', () => {
  const builder = (table: string) => {
    const chain = {
      select: () => {
        calls.push({ table, op: 'select' });
        return chain;
      },
      eq: () => chain,
      maybeSingle: async () => ({ data: promoRow, error: null }),
      update: () => {
        calls.push({ table, op: 'update' });
        return chain;
      },
    };
    return chain;
  };
  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (fn: string) => {
        calls.push({ table: fn, op: 'rpc' });
        return { data: null, error: null };
      },
    },
  };
});

const { findValidPromoCode } = await import('./promoCodes');
const { monthTotals, payoutOrderCount, payoutToCheck, reasonText } = await import('./payouts');
type Payout = import('./payouts').Payout;
type PayoutItem = import('./payouts').PayoutItem;

function order(over: Partial<OrderForMatch> & { order_number: string }): OrderForMatch {
  return {
    id: `id-${over.order_number}`,
    status: 'delivered',
    total: 1000,
    collect_mode: 'cod',
    steadfast_consignment_id: null,
    steadfast_cod_amount: null,
    paid_before_courier: 0,
    steadfast_cod_paid: 0,
    ...over,
  };
}

/** Steadfast's real answer: per-parcel booked COD and status, fees only as
 *  payout totals (amount = COD collected, charges = COD fee, due_bills =
 *  delivery charges, total = paid). */
const RAW = [
  { consignment_id: 1, invoice: 'NM-5001', cod_amount: 2000, status: 'delivered' }, // normal
  { consignment_id: 2, invoice: 'NM-5002', cod_amount: 0, status: 'delivered' }, // paid in advance
  { consignment_id: 3, invoice: 'NM-5003', cod_amount: 1500, status: 'cancelled' }, // returned
  { consignment_id: 4, invoice: 'NM-5004', cod_amount: 0, status: 'delivered' }, // courier only (order deleted)
  { consignment_id: 5, invoice: 'NM-5005', cod_amount: 800, status: 'delivered' }, // order deleted
];
// Collected 2000 + 800 = ৳2,800; paid = 2,800 − 28 − 300 = ৳2,472.
const SUMMARY = { amountPaisa: 247200, feeTotalPaisa: 2800, deliveryTotalPaisa: 30000 };

const ORDERS = [
  order({ order_number: 'NM-5001', total: 2000, steadfast_cod_amount: 2000, steadfast_cod_paid: 2000 }),
  order({ order_number: 'NM-5002', total: 1800, steadfast_cod_amount: 0, paid_before_courier: 1800 }),
  order({ order_number: 'NM-5003', total: 1500, status: 'returned', steadfast_cod_amount: 1500 }),
];

function payoutLines() {
  const items = RAW.map((r) => readPayoutItem(r)!);
  const weights = items.map((i) => (i.invoice === 'NM-5004' || i.invoice === 'NM-5005' ? null : 60));
  return matchItems(allocatePayoutTotals(items, SUMMARY, weights), ORDERS, new Set());
}

describe('payouts add up', () => {
  it('a parcel Steadfast returned collected nothing, whatever COD it was booked with', () => {
    expect(parcelNotDelivered('cancelled')).toBe(true);
    expect(parcelNotDelivered('returned')).toBe(true);
    expect(parcelNotDelivered('delivered')).toBe(false);
    expect(parcelNotDelivered('partial_delivered')).toBe(false);
    expect(readPayoutItem(RAW[2])!.codPaisa).toBe(0);
    expect(readPayoutItem(RAW[0])!.codPaisa).toBe(200000);
  });

  it('normal, prepaid, returned, courier-only and deleted-order lines add up exactly to what was paid, with no invented charges', () => {
    const lines = payoutLines();
    const sum = sumItems(lines);
    expect(sum.netPaisa).toBe(SUMMARY.amountPaisa);
    expect(sum.codPaisa).toBe(280000); // Steadfast's own "amount"
    expect(sum.otherPaisa).toBe(0);
    expect(sum.codFeePaisa).toBe(2800);
    expect(sum.deliveryChargePaisa).toBe(30000);
  });

  it('the returned, prepaid and courier-only lines add no sale (nothing collected), only a charge', () => {
    const lines = payoutLines();
    for (const inv of ['NM-5002', 'NM-5003', 'NM-5004']) {
      const line = lines.find((l) => l.invoice === inv)!;
      expect(line.codPaisa).toBe(0);
      expect(line.netPaisa).toBe(-line.deliveryChargePaisa);
    }
  });

  it('a returned parcel matches its order (returned or cancelled here) when the order records no Steadfast cash', () => {
    const lines = payoutLines();
    expect(lines.find((l) => l.invoice === 'NM-5003')).toMatchObject({ status: 'matched', reason: null, expectedCodPaisa: 0 });
    const cancelled = matchItems([readPayoutItem(RAW[2])!], [order({ order_number: 'NM-5003', status: 'cancelled' })], new Set());
    expect(cancelled[0]).toMatchObject({ status: 'matched' });
    // …but is "to check" when the order still says Steadfast collected cash.
    const wrong = matchItems([readPayoutItem(RAW[2])!], [order({ order_number: 'NM-5003', steadfast_cod_paid: 1500 })], new Set());
    expect(wrong[0]).toMatchObject({ status: 'to_check', reason: 'cod_differs' });
  });

  it('its charge is the returned order\'s courier cost', () => {
    const line = payoutLines().find((l) => l.invoice === 'NM-5003')!;
    const cost = courierCostRow('p', null, line, '2026-11-17T00:00:00Z');
    expect(cost).toMatchObject({ order_id: 'id-NM-5003', cod_collected: 0 });
    expect(cost!.total_kept).toBeGreaterThan(0);
  });

  it('a line whose order was deleted is "to check: order not found" and has no order cost', () => {
    const line = payoutLines().find((l) => l.invoice === 'NM-5005')!;
    expect(line).toMatchObject({ orderId: null, status: 'to_check', reason: 'order_not_found' });
    expect(courierCostRow('p', null, line, '2026-11-17T00:00:00Z')).toBeNull();
  });

  it('a payout that paid MORE than COD − fees still adds up (a credit is a negative "other")', () => {
    const items = [readPayoutItem({ consignment_id: 9, invoice: 'NM-9', cod_amount: 1000, status: 'delivered' })!];
    const lines = allocatePayoutTotals(items, { amountPaisa: 100000 - 1000 - 6000 + 2500, feeTotalPaisa: 1000, deliveryTotalPaisa: 6000 }, [60]);
    expect(sumItems(lines).netPaisa).toBe(100000 - 1000 - 6000 + 2500);
    expect(lines[0].otherPaisa).toBe(-2500);
  });
});

describe('payout screens', () => {
  function item(over: Partial<PayoutItem>): PayoutItem {
    return {
      id: 'i', payout_id: 'p', consignment_id: null, invoice: 'NM-1', order_id: 'o', cod_collected: 0,
      delivery_charge: 0, cod_fee: 0, other_deduction: 0, net_paid: 0, expected_cod: null,
      match_status: 'matched', match_reason: null, note: null, line_kind: 'order', ...over,
    };
  }
  const payout: Payout = {
    id: 'p', steadfast_payment_id: 'SFC-1', paid_at: '2026-11-01T06:00:00Z', total_amount: 0, parcel_count: 3,
    items: [
      item({ cod_collected: 1000, net_paid: 900, delivery_charge: 90, cod_fee: 10 }),
      item({ invoice: 'NM-3315', order_id: null, line_kind: 'courier_only', delivery_charge: 75, net_paid: -75, note: null }),
      item({ invoice: 'NM-1721', order_id: null, line_kind: 'returned', delivery_charge: 47.5, net_paid: -47.5 }),
    ],
  };

  it('a courier-only or returned line is not an order, and never "to check"', () => {
    expect(payoutOrderCount(payout)).toBe(1);
    expect(payoutToCheck(payout)).toBe(0);
    expect(monthTotals([payout], '2026-11').orders).toBe(1);
    expect(reasonText(payout.items[1])).toBe('Not a shop sale: courier only');
    expect(reasonText(payout.items[2])).toMatch(/^Returned parcel/);
  });

  it('this month\'s money still counts every line exactly', () => {
    expect(monthTotals([payout], '2026-11').receivedPaisa).toBe(90000 - 7500 - 4750);
  });
});

describe('promo codes', () => {
  beforeEach(() => {
    calls.length = 0;
    promoRow = { code: 'SAVE10', discount_amount: 10, discount_type: 'percent', max_uses: 2, times_used: 1, expires_at: null, active: true };
  });

  it('checking or applying a code many times only reads it — it never counts a use', async () => {
    for (let n = 0; n < 5; n += 1) expect(await findValidPromoCode(' save10 ')).not.toBeNull();
    expect(calls.every((c) => c.table === 'promo_codes' && c.op === 'select')).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it('an expired, used-up, switched-off or unknown code all come back the same way (no reason)', async () => {
    const answers = [];
    promoRow = { ...promoRow, expires_at: '2020-01-01T00:00:00Z' };
    answers.push(await findValidPromoCode('SAVE10'));
    promoRow = { ...promoRow, expires_at: null, times_used: 2 };
    answers.push(await findValidPromoCode('SAVE10'));
    promoRow = { ...promoRow, times_used: 0, active: false };
    answers.push(await findValidPromoCode('SAVE10'));
    promoRow = null;
    answers.push(await findValidPromoCode('NOPE'));
    expect(answers).toEqual([null, null, null, null]);
  });

  it('the cart shows only the one generic message', () => {
    const page = readFileSync('src/features/checkout/OrderSummaryPage.tsx', 'utf8');
    const messages = [...page.matchAll(/setPromoError\('([^']*)'\)/g)].map((m) => m[1]);
    expect(messages).toEqual(['Invalid or expired code']);
  });

  it('only place_order counts a use, and nobody else may call the counter (migration-047)', () => {
    const sql = readFileSync('supabase/migration-047-batch46-payouts-promo.sql', 'utf8');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION increment_promo_usage\(text\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/AFTER UPDATE OF status, promo_code OR DELETE ON orders/);
    const site = ['src/features/checkout/OrderSuccessPage.tsx', 'src/features/checkout/OrderSummaryPage.tsx', 'src/lib/promoCodes.ts', 'src/lib/orders.ts']
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    expect(site).not.toMatch(/increment_promo_usage/);
  });
});
