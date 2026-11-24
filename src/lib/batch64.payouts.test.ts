import { describe, expect, it } from 'vitest';
import {
  syncSteadfastPayouts,
  type CourierCostRow,
  type OrderForMatch,
  type PayoutItemRow,
  type PayoutRow,
  type PayoutStore,
  type StoredPayout,
} from '../../supabase/functions/_shared/steadfastPayouts';

// Batch 64 Part 5: a payout whose lines were already saved while it was
// "processing" is skipped by later syncs (no detail call), but its status
// from Steadfast's list is still saved, so it no longer stays "processing".

class Store implements PayoutStore {
  payouts = new Map<string, PayoutRow & { id: string }>();
  touched: { paymentId: string; status: string | undefined }[] = [];
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
  async touchPayout(paymentId: string, at: string, steadfastStatus?: string): Promise<void> {
    this.touched.push({ paymentId, status: steadfastStatus });
    const p = this.payouts.get(paymentId);
    if (!p) return;
    p.last_synced_at = at;
    if (steadfastStatus !== undefined) p.steadfast_status = steadfastStatus;
  }
  async findOrders(): Promise<OrderForMatch[]> {
    return [];
  }
  async ordersInOtherPayouts(): Promise<Set<string>> {
    return new Set();
  }
  async upsertItems(_rows: PayoutItemRow[]): Promise<void> {}
  async upsertCourierCosts(_rows: CourierCostRow[]): Promise<void> {}
  async saveBalance(): Promise<void> {}
}

function steadfast(listStatus: string) {
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    '/get_balance': { status: 200, current_balance: 100 },
    '/payments': { status: 200, data: [{ id: 33372895, created_at: '2026-11-19 19:37:10', amount: '6836', total_consignment: 1, status: listStatus }] },
    '/payments/33372895': {
      status: 200,
      data: { id: 33372895, status: listStatus, consignments: [{ consignment_id: 1, invoice: 'NM-9', cod_amount: 7000, delivery_charge: 130, cod_charge: 34 }] },
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

describe('Batch 64: a stored payout gets its new status from the list', () => {
  it('"processing" with its lines saved, now "paid" in the list → the store gets "paid", no detail call', async () => {
    const store = new Store();
    await syncSteadfastPayouts(steadfast('processing').get, store);
    const first = store.payouts.get('33372895');
    expect(first?.items_synced).toBe(true);
    expect(first?.steadfast_status).toBe('processing');

    const later = steadfast('paid');
    await syncSteadfastPayouts(later.get, store);
    expect(later.calls).not.toContain('/payments/33372895');
    expect(store.touched[store.touched.length - 1]).toEqual({ paymentId: '33372895', status: 'paid' });
    expect(store.payouts.get('33372895')?.steadfast_status).toBe('paid');
  });

  it('the same status as stored → only "seen again", no status write', async () => {
    const store = new Store();
    await syncSteadfastPayouts(steadfast('paid').get, store);
    const again = steadfast('paid');
    await syncSteadfastPayouts(again.get, store);
    expect(again.calls).not.toContain('/payments/33372895');
    expect(store.touched[store.touched.length - 1]).toEqual({ paymentId: '33372895', status: undefined });
  });
});
