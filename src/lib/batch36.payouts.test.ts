import { describe, expect, it } from 'vitest';
import {
  matchItems,
  parseBalance,
  parsePaymentDetail,
  parsePaymentsList,
  readPayoutItem,
  syncSteadfastPayouts,
  toPaisa,
  type CourierCostRow,
  type FetchAnswer,
  type OrderForMatch,
  type PayoutItemRow,
  type PayoutRow,
  type PayoutStore,
  type StoredPayout,
} from '../../supabase/functions/_shared/steadfastPayouts';
import {
  monthTotals,
  overdueOrders,
  payoutFeesPaisa,
  payoutPill,
  takaExact,
  takaWhole,
  type Payout,
  type PayoutItem,
} from './payouts';

// Batch 36 Part 1: Steadfast payouts. Steadfast is a fake here — nothing
// is ever sent to the real API.

function order(over: Partial<OrderForMatch> & { order_number: string }): OrderForMatch {
  return {
    id: `id-${over.order_number}`,
    status: 'delivered',
    total: 1000,
    collect_mode: 'cod',
    steadfast_consignment_id: null,
    steadfast_cod_amount: null,
    paid_before_courier: 0,
    ...over,
  };
}

const ORDERS: OrderForMatch[] = [
  order({ order_number: 'NM-1722', total: 2299, steadfast_consignment_id: '9001', steadfast_cod_amount: 2299 }),
  order({ order_number: 'NM-1639', total: 1300, steadfast_consignment_id: '9002', steadfast_cod_amount: 1300 }),
  order({ order_number: 'NM-1450', total: 3699, steadfast_consignment_id: '9003', steadfast_cod_amount: 3699 }),
  order({ order_number: 'NM-1451', total: 1530, steadfast_consignment_id: '9004', status: 'cancelled' }),
];

/** Steadfast's answers for a fake account with two payouts. */
function fakeSteadfast(): { get: (path: string) => Promise<FetchAnswer>; calls: string[] } {
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    '/get_balance': { status: 200, current_balance: 12480.5 },
    '/payments': {
      status: 200,
      data: [
        { id: 48213, created_at: '2026-10-08 16:10:00', amount: '5835.55', total_consignment: 3 },
        { id: 47990, created_at: '2026-10-04 12:00:00', amount: '1328.70', total_consignment: 2 },
      ],
    },
    '/payments/48213': {
      status: 200,
      data: {
        id: 48213,
        consignments: [
          { consignment_id: 9001, invoice: 'NM-1722', cod_amount: 2299, delivery_charge: 130, cod_charge: 22.99 },
          { consignment_id: 9002, invoice: 'NM-1639', cod_amount: 1300, delivery_charge: 130, cod_charge: 13 },
          { consignment_id: 9003, invoice: 'NM-1450', cod_amount: 3699, delivery_charge: 130, cod_charge: 36.99 },
        ],
      },
    },
    '/payments/47990': {
      status: 200,
      data: {
        id: 47990,
        consignments: [
          { consignment_id: 9004, invoice: 'NM-1451', cod_amount: 1530, delivery_charge: 130, cod_charge: 15.3 },
          // Not our order, and a COD different from what we booked.
          { consignment_id: 9999, invoice: 'XX-1', cod_amount: 100, delivery_charge: 70, cod_charge: 1 },
        ],
      },
    },
  };
  return {
    calls,
    get: async (path: string) => {
      calls.push(path);
      const body = answers[path];
      return body === undefined ? { ok: false, status: 404, body: null } : { ok: true, status: 200, body };
    },
  };
}

class MemoryStore implements PayoutStore {
  payouts = new Map<string, PayoutRow & { id: string }>();
  items = new Map<string, PayoutItemRow>();
  costs = new Map<string, CourierCostRow>();
  balance: number | null = null;

  async storedPayouts(ids: string[]): Promise<Map<string, StoredPayout>> {
    const out = new Map<string, StoredPayout>();
    for (const id of ids) {
      const p = this.payouts.get(id);
      if (!p) continue;
      const hasToCheck = [...this.items.values()].some((i) => i.payout_id === p.id && i.match_status === 'to_check');
      out.set(id, { id: p.id, itemsSynced: p.items_synced, hasToCheck });
    }
    return out;
  }
  async upsertPayout(row: PayoutRow): Promise<string> {
    const id = this.payouts.get(row.steadfast_payment_id)?.id ?? `p-${row.steadfast_payment_id}`;
    this.payouts.set(row.steadfast_payment_id, { ...row, id });
    return id;
  }
  async touchPayout(paymentId: string, at: string): Promise<void> {
    const p = this.payouts.get(paymentId);
    if (p) p.last_synced_at = at;
  }
  async findOrders(invoices: string[], cids: string[]): Promise<OrderForMatch[]> {
    return ORDERS.filter((o) => invoices.includes(o.order_number) || cids.includes(o.steadfast_consignment_id ?? ''));
  }
  async ordersInOtherPayouts(orderIds: string[], payoutId: string): Promise<Set<string>> {
    return new Set(
      [...this.items.values()]
        .filter((i) => i.payout_id !== payoutId && i.order_id && orderIds.includes(i.order_id) && i.match_reason !== 'duplicate')
        .map((i) => i.order_id as string)
    );
  }
  async upsertItems(rows: PayoutItemRow[]): Promise<void> {
    for (const r of rows) this.items.set(`${r.payout_id}|${r.item_key}`, r);
  }
  async upsertCourierCosts(rows: CourierCostRow[]): Promise<void> {
    for (const r of rows) this.costs.set(r.order_id, r);
  }
  async saveBalance(balance: number | null): Promise<void> {
    if (balance !== null) this.balance = balance;
  }
}

describe('reading Steadfast payout answers', () => {
  it('balance, list and one payout', () => {
    expect(parseBalance({ status: 200, current_balance: 12480.5 })).toBe(12480.5);
    expect(parseBalance({ status: 200 })).toBeNull();
    const list = parsePaymentsList({ data: [{ id: 1, amount: '10.50', created_at: '2026-10-08 16:10:00' }] });
    expect(list.payouts[0]).toMatchObject({ paymentId: '1', amountPaisa: 1050, paidAt: '2026-10-08T10:10:00.000Z' });
    expect(list.hasMore).toBe(false);
    const paged = parsePaymentsList({ data: { data: [{ id: 2 }], current_page: 1, last_page: 3 } });
    expect(paged.payouts).toHaveLength(1);
    expect(paged.hasMore).toBe(true);
    const detail = parsePaymentDetail({ data: { id: 5, consignments: [{ consignment_id: 1, invoice: 'NM-1', cod_amount: 500 }] } });
    expect(detail.items).toHaveLength(1);
  });

  it('net from Steadfast wins; anything unexplained is "other"', () => {
    const item = readPayoutItem({ consignment_id: 1, invoice: 'NM-1', cod_amount: 1000, delivery_charge: 130, cod_charge: 10, payable_amount: 800 });
    expect(item).toMatchObject({ codPaisa: 100000, deliveryChargePaisa: 13000, codFeePaisa: 1000, otherPaisa: 6000, netPaisa: 80000 });
  });

  it('missing COD fee is worked out as 1% and flagged', () => {
    const item = readPayoutItem({ consignment_id: 1, invoice: 'NM-1', cod_amount: 1530, delivery_charge: 130 });
    expect(item).toMatchObject({ codFeePaisa: 1530, netPaisa: 153000 - 13000 - 1530, feeEstimated: true });
  });
});

describe('matching payout parcels to our orders', () => {
  const items = [
    readPayoutItem({ consignment_id: 9001, invoice: 'NM-1722', cod_amount: 2299, delivery_charge: 130, cod_charge: 22.99 }),
    readPayoutItem({ consignment_id: 9002, invoice: 'NM-1639', cod_amount: 1250, delivery_charge: 130, cod_charge: 12.5 }),
    readPayoutItem({ consignment_id: 7777, invoice: 'NM-0000', cod_amount: 500, delivery_charge: 70, cod_charge: 5 }),
    readPayoutItem({ consignment_id: 9004, invoice: 'NM-1451', cod_amount: 1530, delivery_charge: 130, cod_charge: 15.3 }),
    readPayoutItem({ consignment_id: 9003, invoice: 'NM-1450', cod_amount: 3699, delivery_charge: 130, cod_charge: 36.99 }),
  ].filter((i) => i !== null);

  it('Matched / COD differs / unknown invoice / cancelled order / already paid', () => {
    const m = matchItems(items, ORDERS, new Set(['id-NM-1450']));
    expect(m.map((x) => [x.invoice, x.status, x.reason])).toEqual([
      ['NM-1722', 'matched', null],
      ['NM-1639', 'to_check', 'cod_differs'],
      ['NM-0000', 'to_check', 'order_not_found'],
      ['NM-1451', 'to_check', 'order_cancelled'],
      ['NM-1450', 'to_check', 'duplicate'],
    ]);
  });

  it('expected COD falls back to the Batch 32 rule (total − paid; pay later = 0)', () => {
    const a = order({ order_number: 'NM-A', total: 1500, paid_before_courier: 500 });
    const b = order({ order_number: 'NM-B', total: 1500, collect_mode: 'pay_later' });
    const parcels = [
      readPayoutItem({ consignment_id: 1, invoice: 'NM-A', cod_amount: 1000, delivery_charge: 70, cod_charge: 10 }),
      readPayoutItem({ consignment_id: 2, invoice: 'NM-B', cod_amount: 0, delivery_charge: 70, cod_charge: 0 }),
    ].filter((i) => i !== null);
    expect(matchItems(parcels, [a, b], new Set()).map((x) => x.status)).toEqual(['matched', 'matched']);
  });
});

describe('the sync', () => {
  it('stores everything once, even when run twice', async () => {
    const steadfast = fakeSteadfast();
    const store = new MemoryStore();
    const first = await syncSteadfastPayouts(steadfast.get, store);
    expect(first).toMatchObject({ ok: true, balance: 12480.5, payoutsSeen: 2, payoutsNew: 2, itemsSaved: 5 });
    const second = await syncSteadfastPayouts(steadfast.get, store);
    expect(second.payoutsNew).toBe(0);
    expect(store.payouts.size).toBe(2);
    expect(store.items.size).toBe(5);
    expect(store.costs.size).toBe(4);
    // Only GETs, and never anything that books or changes a parcel.
    expect(steadfast.calls.every((c) => c === '/get_balance' || c.startsWith('/payments'))).toBe(true);
    // 48213 was complete and matched: its parcels are not read again.
    expect(steadfast.calls.filter((c) => c === '/payments/48213')).toHaveLength(1);
  });

  it('per-order courier cost and net, to the paisa', async () => {
    const store = new MemoryStore();
    await syncSteadfastPayouts(fakeSteadfast().get, store);
    const cost = store.costs.get('id-NM-1722');
    expect(cost).toMatchObject({ cod_collected: 2299, delivery_charge: 130, cod_fee: 22.99, total_kept: 152.99, net_received: 2146.01 });
    const sum = [...store.items.values()]
      .filter((i) => i.payout_id === 'p-48213')
      .reduce((t, i) => t + toPaisa(i.net_paid), 0);
    expect(sum).toBe(toPaisa(2146.01) + toPaisa(1300 - 130 - 13) + toPaisa(3699 - 130 - 36.99));
  });
});

function item(over: Partial<PayoutItem>): PayoutItem {
  return {
    id: 'i',
    payout_id: 'p',
    consignment_id: null,
    invoice: 'NM-1',
    order_id: 'o',
    cod_collected: 0,
    delivery_charge: 0,
    cod_fee: 0,
    other_deduction: 0,
    net_paid: 0,
    expected_cod: null,
    match_status: 'matched',
    match_reason: null,
    note: null,
    ...over,
  };
}

describe('the payouts page numbers', () => {
  const october: Payout = {
    id: 'a',
    steadfast_payment_id: '48213',
    paid_at: '2026-10-08T10:10:00Z',
    total_amount: 3302.48,
    parcel_count: 2,
    items: [
      item({ cod_collected: 2299, delivery_charge: 130, cod_fee: 22.99, net_paid: 2146.01 }),
      item({ cod_collected: 1300, delivery_charge: 130, cod_fee: 13, other_deduction: 0.53, net_paid: 1156.47, match_status: 'to_check', match_reason: 'cod_differs' }),
    ],
  };
  const september: Payout = { ...october, id: 'b', paid_at: '2026-09-30T19:00:00Z', items: [item({ cod_collected: 999, net_paid: 999 })] };

  it('month totals are the exact sum of the parcels (Dhaka month)', () => {
    const t = monthTotals([october, september], '2026-10');
    // 30 Sep 19:00 UTC is 1 Oct in Dhaka.
    expect(t.orders).toBe(3);
    expect(t.codPaisa).toBe(229900 + 130000 + 99900);
    expect(t.chargesPaisa).toBe(13000 + 13000 + 53);
    expect(t.codFeePaisa).toBe(2299 + 1300);
    expect(t.receivedPaisa).toBe(214601 + 115647 + 99900);
    expect(t.codPaisa - t.chargesPaisa - t.codFeePaisa).toBe(t.receivedPaisa);
  });

  it('fees and the pill', () => {
    expect(payoutFeesPaisa(october)).toBe(13000 + 2299 + 13000 + 1300 + 53);
    expect(payoutPill(october)).toEqual({ tone: 'amber', text: '1 to check' });
    expect(payoutPill({ items: [item({})] })).toEqual({ tone: 'green', text: 'Matched' });
  });

  it('whole taka on screen, exact on hover', () => {
    expect(takaWhole(198045)).toBe('৳1,980');
    expect(takaExact(198045)).toBe('৳1,980.45');
    expect(takaExact(-15299)).toBe('-৳152.99');
  });

  it('the 7-day unpaid alert appears and disappears', () => {
    const now = new Date('2026-10-15T06:00:00Z');
    const rows = [
      { order_id: '1', order_number: 'NM-1450', delivered_at: '2026-10-05T06:00:00Z' },
      { order_id: '2', order_number: 'NM-1460', delivered_at: '2026-10-12T06:00:00Z' },
    ];
    expect(overdueOrders(rows, now).map((r) => r.order_number)).toEqual(['NM-1450']);
    // Paid (no longer returned by the database) → the alert is gone.
    expect(overdueOrders(rows.slice(1), now)).toEqual([]);
  });
});
