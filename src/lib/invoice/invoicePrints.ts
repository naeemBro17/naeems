// Batch 37: which invoices were printed (order_invoice_prints,
// migration-039) and the "All booked today, not printed yet" choice.
// Before migration-039 is run, printing still works — it just can't be
// remembered (every read here returns null, recording reports it).
import { supabase } from '../supabase';

/** "2026-10-09" in Dhaka time. */
export function dhakaDay(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

/** Midnight in Dhaka (UTC+6, no daylight saving) as an ISO time. */
export function dhakaDayStart(date: Date): string {
  return new Date(`${dhakaDay(date)}T00:00:00+06:00`).toISOString();
}

export function byOrderNumber(a: { order_number: string }, b: { order_number: string }): number {
  return a.order_number.localeCompare(b.order_number, 'en', { numeric: true });
}

/**
 * Orders booked with Steadfast today (their "shipped" History line is from
 * today, Dhaka time) and never printed, lowest order number first.
 */
export function pickBookedToday<T extends { id: string; order_number: string; steadfast_consignment_id: string | null }>(
  orders: T[],
  shippedAt: Map<string, string>,
  printedAt: Map<string, string>,
  now: Date
): T[] {
  const today = dhakaDay(now);
  return orders
    .filter((o) => {
      const shipped = shippedAt.get(o.id);
      return Boolean(o.steadfast_consignment_id) && shipped !== undefined && dhakaDay(new Date(shipped)) === today && !printedAt.has(o.id);
    })
    .sort(byOrderNumber);
}

/** order id → when it was last moved to "shipped" today. */
export async function fetchShippedToday(now = new Date()): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('order_status_history')
    .select('order_id, changed_at')
    .eq('new_status', 'shipped')
    .gte('changed_at', dhakaDayStart(now));
  const map = new Map<string, string>();
  if (error) return map;
  for (const row of (data ?? []) as { order_id: string; changed_at: string }[]) {
    const seen = map.get(row.order_id);
    if (!seen || seen < row.changed_at) map.set(row.order_id, row.changed_at);
  }
  return map;
}

/** order id → when its invoice was last printed; null before migration-039. */
export async function fetchInvoicePrints(): Promise<Map<string, string> | null> {
  const { data, error } = await supabase.from('order_invoice_prints').select('order_id, printed_at');
  if (error) return null;
  const map = new Map<string, string>();
  for (const row of (data ?? []) as { order_id: string; printed_at: string }[]) {
    const seen = map.get(row.order_id);
    if (!seen || seen < row.printed_at) map.set(row.order_id, row.printed_at);
  }
  return map;
}

/** Remembers the print (and adds "Invoice printed" to each order's History). */
export async function recordInvoicePrints(orderIds: string[]): Promise<{ ok: boolean; error: string | null }> {
  if (orderIds.length === 0) return { ok: true, error: null };
  const { error } = await supabase.rpc('record_invoice_prints', { p_order_ids: orderIds });
  if (error) {
    const notReady = error.code === 'PGRST202' || error.code === '42883' || /record_invoice_prints/.test(error.message);
    return { ok: false, error: notReady ? 'The print was not remembered (the database addition is not applied yet).' : error.message };
  }
  return { ok: true, error: null };
}
