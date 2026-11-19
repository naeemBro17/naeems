import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ZONE_FEES,
  allocatePayoutTotals,
  courierCostRow,
  matchItems,
  paidSeparatelySide,
  parsePaymentsList,
  readPayoutItem,
  zoneWeight,
  type OrderForMatch,
  type PayoutItem,
} from '../../supabase/functions/_shared/steadfastPayouts';
import { courierLabel } from './inventory/courierLabel';

/** A parcel as Steadfast lists it inside a payout (no per-parcel bill). */
function parcel(invoice: string, cod: number): PayoutItem {
  const item = readPayoutItem({ consignment_id: invoice.replace(/\D/g, ''), invoice, cod_amount: cod, status: 'delivered' });
  if (!item) throw new Error('parcel not read');
  return item;
}

/** The payout totals exactly as Steadfast's /payments answer gives them. */
function payout(raw: Record<string, number | string>) {
  return parsePaymentsList([{ payment_id: 'SFC-TEST', ...raw }]).payouts[0];
}

const inside = zoneWeight({ delivery_zone: 'inside_dhaka', delivery_fee: 71 }, DEFAULT_ZONE_FEES);
const outside = zoneWeight({ delivery_zone: 'outside_dhaka', delivery_fee: 131 }, DEFAULT_ZONE_FEES);

const kept = (i: PayoutItem) => i.deliveryChargePaisa + i.codFeePaisa + i.otherPaisa + i.paidSeparatelyPaisa;
const sum = (items: PayoutItem[], f: (i: PayoutItem) => number) => items.reduce((t, i) => t + f(i), 0);

describe('Batch 53 Part 2.1: sharing a payout\'s bills', () => {
  it('SFC-33351521: NM-3917 = ৳105 + ৳9, NM-3890 = its own ৳65 paid separately; the payout still adds up', () => {
    const p = payout({ amount: 1000, charges: 9, due_bills: 105, paid_bills: 65, total: 886 });
    const [nm3890, nm3917] = allocatePayoutTotals([parcel('NM-3890', 0), parcel('NM-3917', 1000)], p, [inside, outside]);
    expect(kept(nm3917)).toBe(11400);
    expect(nm3917.deliveryChargePaisa).toBe(10500);
    expect(nm3917.codFeePaisa).toBe(900);
    expect(nm3917.netPaisa).toBe(88600);
    expect(kept(nm3890)).toBe(6500);
    expect(nm3890.paidSeparatelyPaisa).toBe(6500);
    // The ৳65 was not taken out of this payout: NM-3890 received nothing and lost nothing here.
    expect(nm3890.netPaisa).toBe(0);
    expect(nm3890.netPaisa + nm3917.netPaisa).toBe(88600);
  });

  it('SFC-33297699: NM-3330 and NM-3790 (both outside Dhaka) get ৳110 each — not worse than before', () => {
    const p = payout({ amount: 1600, charges: 14, due_bills: 220, paid_bills: 0, total: 1366 });
    const [nm3330, nm3790] = allocatePayoutTotals([parcel('NM-3330', 0), parcel('NM-3790', 1600)], p, [outside, outside]);
    expect(nm3330.deliveryChargePaisa).toBe(11000);
    expect(nm3790.deliveryChargePaisa).toBe(11000);
    expect(nm3790.codFeePaisa).toBe(1400);
    expect(nm3330.netPaisa + nm3790.netPaisa).toBe(136600);
  });

  it('one parcel: the numbers are Steadfast\'s own, both kinds of bill on it', () => {
    const p = payout({ amount: 2500, charges: 25, due_bills: 0, paid_bills: 110, total: 2475 });
    const [only] = allocatePayoutTotals([parcel('NM-1', 2500)], p, [outside]);
    expect(only.codFeePaisa).toBe(2500);
    expect(only.paidSeparatelyPaisa).toBe(11000);
    expect(only.netPaisa).toBe(247500);
    const p2 = payout({ amount: 900, charges: 8, due_bills: 105, paid_bills: 0, total: 787 });
    const [single] = allocatePayoutTotals([parcel('NM-2', 900)], p2, [outside]);
    expect(kept(single)).toBe(11300);
    expect(single.netPaisa).toBe(78700);
  });

  it('paid_bills larger than due_bills: still adds up, and the "paid" side is the bigger one', () => {
    const p = payout({ amount: 3270, charges: 32, due_bills: 65, paid_bills: 230, total: 3173 });
    const items = [parcel('NM-10', 0), parcel('NM-11', 0), parcel('NM-12', 3270)];
    const split = allocatePayoutTotals(items, p, [outside, outside, inside]);
    expect(sum(split, (i) => i.netPaisa)).toBe(317300);
    expect(sum(split, (i) => i.deliveryChargePaisa)).toBe(6500);
    expect(sum(split, (i) => i.paidSeparatelyPaisa)).toBe(23000);
    // The inside parcel (weight 70) is the ৳65 due bill; the two outside ones were paid separately.
    expect(split.map((i) => i.paidSeparatelyPaisa > 0)).toEqual([true, true, false]);
  });

  it('nothing to collect anywhere (all COD ৳0): no COD fee, bills still shared exactly', () => {
    const p = payout({ amount: 0, charges: 0, due_bills: 175, paid_bills: 0, total: -175 });
    const split = allocatePayoutTotals([parcel('NM-20', 0), parcel('NM-21', 0)], p, [inside, outside]);
    expect(split.every((i) => i.codFeePaisa === 0)).toBe(true);
    expect(sum(split, (i) => i.deliveryChargePaisa)).toBe(17500);
    expect(sum(split, (i) => i.netPaisa)).toBe(-17500);
  });

  it('rounding: odd paisa are given out so every payout adds up to the taka (and the paisa)', () => {
    const p = payout({ amount: 3001, charges: 31, due_bills: 100, paid_bills: 100, total: 2870 });
    const items = [parcel('NM-30', 1000), parcel('NM-31', 1000), parcel('NM-32', 1001), parcel('NM-33', 0)];
    const split = allocatePayoutTotals(items, p, [inside, inside, inside, null]);
    expect(sum(split, (i) => i.netPaisa)).toBe(287000);
    expect(sum(split, (i) => i.codFeePaisa)).toBe(3100);
    expect(sum(split, (i) => i.deliveryChargePaisa)).toBe(10000);
    expect(sum(split, (i) => i.paidSeparatelyPaisa)).toBe(10000);
    expect(split.every((i) => Number.isInteger(i.deliveryChargePaisa) && Number.isInteger(i.paidSeparatelyPaisa))).toBe(true);
  });

  it('the sum always equals the payout total, whatever the mix (many made-up payouts)', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    for (let k = 0; k < 300; k += 1) {
      const n = 1 + rand(8);
      const items = Array.from({ length: n }, (_, i) => parcel(`NM-${100 + i}`, rand(3) === 0 ? 0 : 100 + rand(5000)));
      const weights = items.map(() => [inside, outside, null][rand(3)]);
      const amount = sum(items, (i) => i.codPaisa) / 100;
      const charges = Math.round(amount * 0.01);
      const due = rand(4) * 55;
      const paid = rand(3) * 65;
      const total = amount - charges - due;
      const split = allocatePayoutTotals(items, payout({ amount, charges, due_bills: due, paid_bills: paid, total }), weights);
      expect(sum(split, (i) => i.netPaisa)).toBe(Math.round(total * 100));
      expect(sum(split, (i) => i.paidSeparatelyPaisa)).toBe(paid * 100);
      expect(sum(split, kept)).toBe((charges + due + paid) * 100);
    }
  });

  it('the "paid" side: same-weight parcels with nothing to collect go first; ties pick fewer parcels', () => {
    expect(paidSeparatelySide([0, 120000], [70, 70], 6000, 6500)).toEqual([true, false]);
    expect(paidSeparatelySide([120000, 0], [70, 70], 6000, 6500)).toEqual([false, true]);
    expect(paidSeparatelySide([100, 100], [70, 130], 10500, 0)).toEqual([false, false]);
    expect(paidSeparatelySide([100, 100], [70, 130], 0, 10500)).toEqual([true, true]);
  });

  it('the courier row: a bill paid outside the payout is in total_kept, not in net_received', () => {
    const p = payout({ amount: 1000, charges: 9, due_bills: 105, paid_bills: 65, total: 886 });
    const orders: OrderForMatch[] = [
      { id: 'o-3890', order_number: 'NM-3890', status: 'delivered', total: 0, collect_mode: 'pay_later', steadfast_consignment_id: '3890', steadfast_cod_amount: 0, paid_before_courier: 0, delivery_zone: 'inside_dhaka' },
    ];
    const [line] = matchItems(allocatePayoutTotals([parcel('NM-3890', 0), parcel('NM-3917', 1000)], p, [inside, outside]), orders, new Set());
    const row = courierCostRow('payout-1', null, line, '2026-11-19T00:00:00.000Z');
    expect(row).toMatchObject({ delivery_charge: 0, bill_paid_separately: 65, total_kept: 65, net_received: 0, split_rule: 'b53' });
  });

  it('zone weights come from Settings; no zone → the order\'s own fee; nothing → average of the others', () => {
    expect(zoneWeight({ delivery_zone: 'inside_dhaka', delivery_fee: 0 }, { inside: 60, outside: 120 })).toBe(60);
    expect(zoneWeight({ delivery_zone: 'outside_dhaka', delivery_fee: 0 }, { inside: 60, outside: 120 })).toBe(120);
    expect(zoneWeight({ delivery_zone: null, delivery_fee: 90 }, DEFAULT_ZONE_FEES)).toBe(90);
    expect(zoneWeight({ delivery_zone: 'hand_delivered', delivery_fee: 0 }, DEFAULT_ZONE_FEES)).toBeNull();
    expect(zoneWeight(null, DEFAULT_ZONE_FEES)).toBeNull();
  });
});

describe('Batch 53 Part 2.2: the label beside the courier amount', () => {
  it('one parcel / share / expected / no courier / not booked', () => {
    expect(courierLabel('exact', true)).toEqual({ label: 'From Steadfast', note: null });
    expect(courierLabel('share', true)).toEqual({ label: 'Share of payout', note: null });
    expect(courierLabel('expected', false)).toEqual({ label: 'Expected', note: 'Waiting for Steadfast payout' });
    expect(courierLabel('none', true)).toEqual({ label: 'No courier', note: null });
    expect(courierLabel('not_booked', false)).toEqual({ label: 'Not booked on Steadfast', note: null });
  });

  it('before the Batch 53 SQL is run (no kind): only "not known yet", as before', () => {
    expect(courierLabel(undefined, true)).toBeNull();
    expect(courierLabel(undefined, false)).toEqual({ label: 'Not known yet', note: null });
    expect(courierLabel('something else', false)).toEqual({ label: 'Not known yet', note: null });
  });
});
