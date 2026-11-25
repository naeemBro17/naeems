// Batch 36 Part 1: the PayoutStore (steadfastPayouts.ts) on the real
// database, used with the SERVICE ROLE client by the two Steadfast
// functions. The tables (migration-038) are readable only by people with
// "View profit & costs"; nobody but the service role can write them.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { DEFAULT_ZONE_FEES } from './steadfastPayouts.ts';
import type {
  CourierCostRow,
  OrderForMatch,
  PayoutItemRow,
  PayoutRow,
  PayoutStore,
  StoredPayout,
  ZoneFees,
} from './steadfastPayouts.ts';

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  total: number | string;
  collect_mode: string | null;
  steadfast_consignment_id: string | null;
  steadfast_cod_amount: number | string | null;
  delivery_fee: number | string | null;
  delivery_zone: string | null;
  return_delivery_paid?: number | string | null;
}

interface PaymentRow {
  order_id: string;
  kind: string;
  amount: number | string;
  source: string;
}

function fail(what: string, message: string): never {
  throw new Error(`${what}: ${message}`);
}

export function supabasePayoutStore(db: SupabaseClient): PayoutStore {
  return {
    async storedPayouts(paymentIds: string[]): Promise<Map<string, StoredPayout>> {
      const out = new Map<string, StoredPayout>();
      if (paymentIds.length === 0) return out;
      const { data, error } = await db
        .from('steadfast_payouts')
        .select('id, steadfast_payment_id, items_synced, steadfast_status')
        .in('steadfast_payment_id', paymentIds);
      if (error) fail('Reading payouts', error.message);
      const rows = (data ?? []) as { id: string; steadfast_payment_id: string; items_synced: boolean; steadfast_status: string | null }[];
      const ids = rows.map((r) => r.id);
      const toCheck = new Set<string>();
      if (ids.length > 0) {
        const { data: open, error: openErr } = await db
          .from('steadfast_payout_items')
          .select('payout_id')
          .in('payout_id', ids)
          .eq('match_status', 'to_check')
          // Parcels booked directly on Steadfast (not an NM- invoice)
          // will never match — they don't make the payout read again.
          .or('match_reason.neq.order_not_found,invoice.ilike.NM-*');
        if (openErr) fail('Reading payout items', openErr.message);
        for (const r of (open ?? []) as { payout_id: string }[]) toCheck.add(r.payout_id);
        // Batch 53: a payout last split by an older copy of this code (no
        // split_rule) is read once more, so its bills are shared the new way.
        const { data: old, error: oldErr } = await db
          .from('steadfast_payout_items')
          .select('payout_id')
          .in('payout_id', ids)
          .is('split_rule', null);
        if (oldErr) fail('Reading payout items', oldErr.message);
        for (const r of (old ?? []) as { payout_id: string }[]) toCheck.add(r.payout_id);
      }
      for (const r of rows) {
        out.set(r.steadfast_payment_id, {
          id: r.id,
          itemsSynced: r.items_synced,
          hasToCheck: toCheck.has(r.id),
          steadfastStatus: r.steadfast_status,
        });
      }
      return out;
    },

    async upsertPayout(row: PayoutRow): Promise<string> {
      const { data, error } = await db
        .from('steadfast_payouts')
        .upsert(row, { onConflict: 'steadfast_payment_id' })
        .select('id')
        .single();
      if (error || !data) fail('Saving a payout', error?.message ?? 'no row');
      return (data as { id: string }).id;
    },

    async touchPayout(paymentId: string, at: string, steadfastStatus?: string): Promise<void> {
      const change = steadfastStatus === undefined ? { last_synced_at: at } : { last_synced_at: at, steadfast_status: steadfastStatus };
      const { error } = await db.from('steadfast_payouts').update(change).eq('steadfast_payment_id', paymentId);
      if (error) fail('Updating a payout', error.message);
    },

    async findOrders(invoices: string[], consignmentIds: string[]): Promise<OrderForMatch[]> {
      const oldColumns = 'id, order_number, status, total, collect_mode, steadfast_consignment_id, steadfast_cod_amount, delivery_fee, delivery_zone';
      // Batch 65: return_delivery_paid (migration-062). Until that SQL is run
      // the column is missing ("42703") and the older list is read instead.
      const columns = `${oldColumns}, return_delivery_paid`;
      const read = async (field: 'order_number' | 'steadfast_consignment_id', values: string[]): Promise<OrderRow[]> => {
        const first = await db.from('orders').select(columns).in(field, values);
        const res = first.error?.code === '42703' ? await db.from('orders').select(oldColumns).in(field, values) : first;
        if (res.error) fail('Reading orders', res.error.message);
        return (res.data ?? []) as OrderRow[];
      };
      const found = new Map<string, OrderRow>();
      if (invoices.length > 0) {
        for (const o of await read('order_number', invoices)) found.set(o.id, o);
      }
      if (consignmentIds.length > 0) {
        for (const o of await read('steadfast_consignment_id', consignmentIds)) found.set(o.id, o);
      }
      const ids = [...found.keys()];
      const paid = new Map<string, number>();
      const viaSteadfast = new Map<string, number>();
      if (ids.length > 0) {
        const { data, error } = await db.from('order_payments').select('order_id, kind, amount, source').in('order_id', ids);
        if (error) fail('Reading payments', error.message);
        for (const p of (data ?? []) as PaymentRow[]) {
          if (p.source === 'steadfast_cod') {
            viaSteadfast.set(p.order_id, (viaSteadfast.get(p.order_id) ?? 0) + Number(p.amount));
            continue;
          }
          const amount = Number(p.amount) * (p.kind === 'refund' ? -1 : 1);
          paid.set(p.order_id, (paid.get(p.order_id) ?? 0) + amount);
        }
      }
      return [...found.values()].map((o) => ({
        id: o.id,
        order_number: o.order_number,
        status: o.status,
        total: Number(o.total),
        collect_mode: o.collect_mode,
        steadfast_consignment_id: o.steadfast_consignment_id,
        steadfast_cod_amount: o.steadfast_cod_amount === null ? null : Number(o.steadfast_cod_amount),
        paid_before_courier: Math.round((paid.get(o.id) ?? 0) * 100) / 100,
        delivery_fee: o.delivery_fee === null ? null : Number(o.delivery_fee),
        delivery_zone: o.delivery_zone,
        steadfast_cod_paid: Math.round((viaSteadfast.get(o.id) ?? 0) * 100) / 100,
        return_delivery_paid: o.return_delivery_paid === null || o.return_delivery_paid === undefined ? 0 : Number(o.return_delivery_paid),
      }));
    },

    async zoneFees(): Promise<ZoneFees> {
      const { data, error } = await db
        .from('app_settings')
        .select('key, value')
        .in('key', ['delivery_fee_inside_dhaka', 'delivery_fee_outside_dhaka']);
      if (error) fail('Reading delivery fees', error.message);
      const read = (key: string, fallback: number): number => {
        const row = ((data ?? []) as { key: string; value: unknown }[]).find((r) => r.key === key);
        const n = Number(row?.value);
        return Number.isFinite(n) && n > 0 ? n : fallback;
      };
      return {
        inside: read('delivery_fee_inside_dhaka', DEFAULT_ZONE_FEES.inside),
        outside: read('delivery_fee_outside_dhaka', DEFAULT_ZONE_FEES.outside),
      };
    },

    async ordersInOtherPayouts(orderIds: string[], payoutId: string): Promise<Set<string>> {
      const out = new Set<string>();
      if (orderIds.length === 0) return out;
      const { data, error } = await db
        .from('steadfast_payout_items')
        .select('order_id')
        .in('order_id', orderIds)
        .neq('payout_id', payoutId)
        .neq('match_reason', 'duplicate');
      if (error) fail('Reading payout items', error.message);
      for (const r of (data ?? []) as { order_id: string }[]) out.add(r.order_id);
      // .neq() leaves out NULL reasons too — read those separately.
      const { data: plain, error: plainErr } = await db
        .from('steadfast_payout_items')
        .select('order_id')
        .in('order_id', orderIds)
        .neq('payout_id', payoutId)
        .is('match_reason', null);
      if (plainErr) fail('Reading payout items', plainErr.message);
      for (const r of (plain ?? []) as { order_id: string }[]) out.add(r.order_id);
      return out;
    },

    async upsertItems(rows: PayoutItemRow[]): Promise<void> {
      if (rows.length === 0) return;
      const { error } = await db.from('steadfast_payout_items').upsert(rows, { onConflict: 'payout_id,item_key' });
      if (error) fail('Saving payout items', error.message);
    },

    async upsertCourierCosts(rows: CourierCostRow[]): Promise<void> {
      const { error } = await db.from('order_courier_costs').upsert(rows, { onConflict: 'order_id' });
      if (error) fail('Saving courier costs', error.message);
    },

    async saveBalance(balance: number | null, error: string | null, at: string): Promise<void> {
      const patch: Record<string, unknown> = { id: 1, last_sync_at: at, last_sync_error: error };
      if (balance !== null) {
        patch.current_balance = balance;
        patch.balance_at = at;
      }
      const { error: saveErr } = await db.from('steadfast_sync_state').upsert(patch, { onConflict: 'id' });
      if (saveErr) fail('Saving the balance', saveErr.message);
    },
  };
}
