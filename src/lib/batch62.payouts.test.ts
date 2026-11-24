import { describe, expect, it } from 'vitest';
import {
  payoutLinesDone,
  syncSteadfastPayouts,
  type CourierCostRow,
  type OrderForMatch,
  type PayoutItemRow,
  type PayoutRow,
  type PayoutStore,
  type StoredPayout,
} from '../../supabase/functions/_shared/steadfastPayouts';

// Batch 62: a payout Steadfast answers with no parcel lines yet (still
// "processing") is not marked synced, so the next sync asks for it again.

class Store implements PayoutStore {
  payouts = new Map<string, PayoutRow & { id: string }>();
  items = new Map<string, PayoutItemRow>();
  async storedPayouts(ids: string[]): Promise<Map<string, StoredPayout>> {
    const out = new Map<string, StoredPayout>();
    for (const id of ids) {
      const p = this.payouts.get(id);
      if (p) out.set(id, { id: p.id, itemsSynced: p.items_synced, hasToCheck: false, steadfastStatus: p.steadfast_status });
    }
    return out;
  }
  async upsertPayout(row: PayoutRow): Promise<string> {
    const id = this.payouts.get(row.steadfast_payment_id)?.id ?? `p-${row.steadfast_payment_id}`;
    this.payouts.set(row.steadfast_payment_id, { ...row, id });
    return id;
  }
  async touchPayout(): Promise<void> {}
  async findOrders(): Promise<OrderForMatch[]> {
    return [];
  }
  async ordersInOtherPayouts(): Promise<Set<string>> {
    return new Set();
  }
  async upsertItems(rows: PayoutItemRow[]): Promise<void> {
    for (const r of rows) this.items.set(`${r.payout_id}|${r.item_key}`, r);
  }
  async upsertCourierCosts(_rows: CourierCostRow[]): Promise<void> {}
  async saveBalance(): Promise<void> {}
}

function steadfast(withLines: boolean) {
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    '/get_balance': { status: 200, current_balance: 100 },
    '/payments': { status: 200, data: [{ id: 33372895, created_at: '2026-11-19 19:37:10', amount: '6836', total_consignment: 1, status: 'processing' }] },
    '/payments/33372895': {
      status: 200,
      data: {
        id: 33372895,
        status: 'processing',
        consignments: withLines ? [{ consignment_id: 1, invoice: 'NM-9', cod_amount: 7000, delivery_charge: 130, cod_charge: 34 }] : [],
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

describe('Batch 62: payout with no parcel lines', () => {
  it('payoutLinesDone: lines back = done; none and processing = not done; final with no parcels = done', () => {
    expect(payoutLinesDone({ steadfastStatus: 'processing', parcelCount: 1 }, 1)).toBe(true);
    expect(payoutLinesDone({ steadfastStatus: 'processing', parcelCount: 1 }, 0)).toBe(false);
    expect(payoutLinesDone({ steadfastStatus: 'paid', parcelCount: 1 }, 0)).toBe(false);
    expect(payoutLinesDone({ steadfastStatus: 'Paid', parcelCount: 0 }, 0)).toBe(true);
    expect(payoutLinesDone({ steadfastStatus: null, parcelCount: 0 }, 0)).toBe(false);
  });

  it('is asked again on the next sync, and matched once the lines come', async () => {
    const store = new Store();
    const empty = steadfast(false);
    await syncSteadfastPayouts(empty.get, store);
    expect(store.payouts.get('33372895')?.items_synced).toBe(false);
    await syncSteadfastPayouts(empty.get, store);
    expect(empty.calls.filter((c) => c === '/payments/33372895')).toHaveLength(2);

    const full = steadfast(true);
    await syncSteadfastPayouts(full.get, store);
    expect(store.payouts.get('33372895')?.items_synced).toBe(true);
    expect(store.items.size).toBe(1);
    await syncSteadfastPayouts(full.get, store);
    expect(full.calls.filter((c) => c === '/payments/33372895')).toHaveLength(1);
  });
});
