import { supabase } from './supabase';
import { formatTakaBd } from './adminNav';
import { PAYMENT_METHOD_NAMES, type OrderPayment, type PaymentMethodId } from './payments';
import {
  TRACK_STATUS,
  trackOrder,
  type TrackResult,
  type TrackStatus,
  type TrackingEvent,
} from '../../supabase/functions/_shared/orderTracking';
import type { Order, OrderStatusHistoryRow } from '../types';

export * from '../../supabase/functions/_shared/orderTracking';

/* Batch 35 Part 1 — the website side of the one status mapping: the
   status for a saved order, the stored tracking updates
   (order_tracking_events, migration-037) and the customer's payment rows.
   Every read falls back quietly when migration-037 hasn't been run: the
   pages then use what the steadfast function and the order itself give,
   exactly as before. */

type TrackOrder = Pick<Order, 'status' | 'steadfast_consignment_id' | 'steadfast_status'>;

/** The status for a saved order (lists: no texts, maybe a stored step). */
export function savedTrack(order: TrackOrder, extra: { events?: TrackingEvent[]; storedStep?: TrackStatus | null; courierStatus?: string | null } = {}): TrackResult {
  return trackOrder({
    status: order.status,
    booked: Boolean(order.steadfast_consignment_id),
    courierStatus: extra.courierStatus ?? order.steadfast_status,
    events: extra.events,
    storedStep: extra.storedStep ?? null,
  });
}

/** The admin name of a saved order's status. */
export function adminStatusName(order: TrackOrder, storedStep: TrackStatus | null = null): string {
  return TRACK_STATUS[savedTrack(order, { storedStep }).status].admin;
}

/** One stored update, as the customer may see it (friendly text only). */
export interface StoredUpdate {
  step: TrackStatus | null;
  text: string;
  at: string | null;
}

/** A payment as the customer may see it — never a TrxID or a note. */
export interface CustomerPayment {
  kind: 'payment' | 'refund';
  amount: number;
  method: PaymentMethodId;
  paid_at: string;
}

export interface OrderUpdates {
  tracking: StoredUpdate[];
  payments: CustomerPayment[];
}

/** The customer's stored updates for one order (their own order only —
 *  checked in the database). Null before migration-037. */
export async function fetchOrderUpdates(orderId: string): Promise<OrderUpdates | null> {
  const { data, error } = await supabase.rpc('customer_order_updates', { p_order_id: orderId });
  if (error || !Array.isArray(data)) return null;
  const tracking: StoredUpdate[] = [];
  const payments: CustomerPayment[] = [];
  for (const row of data as Record<string, unknown>[]) {
    if (row.kind === 'tracking' && typeof row.text === 'string') {
      tracking.push({ step: (row.step as TrackStatus | null) ?? null, text: row.text, at: (row.happened_at as string | null) ?? null });
    } else if ((row.kind === 'payment' || row.kind === 'refund') && row.happened_at) {
      payments.push({
        kind: row.kind,
        amount: Number(row.amount),
        method: (row.method as PaymentMethodId) ?? 'other',
        paid_at: row.happened_at as string,
      });
    }
  }
  return { tracking, payments };
}

/** The newest stored step per order (My orders / the admin Orders list):
 *  only In transit / Out for delivery matter there. Empty before
 *  migration-037. */
export async function fetchLatestSteps(): Promise<Map<string, TrackStatus>> {
  const map = new Map<string, TrackStatus>();
  const { data, error } = await supabase.rpc('order_latest_tracking_steps');
  if (error || !Array.isArray(data)) return map;
  for (const row of data as { order_id: string; step: TrackStatus }[]) map.set(row.order_id, row.step);
  return map;
}

/** Staff: every stored update of one order, the courier's own words too.
 *  Null before migration-037. */
export async function fetchStaffTrackingEvents(orderId: string): Promise<{ text: string; friendly: string | null; at: string | null }[] | null> {
  const { data, error } = await supabase
    .from('order_tracking_events')
    .select('courier_text, friendly_text, happened_at')
    .eq('order_id', orderId)
    .order('happened_at', { ascending: true });
  if (error) return null;
  return ((data ?? []) as { courier_text: string; friendly_text: string | null; happened_at: string | null }[]).map((r) => ({
    text: r.courier_text,
    friendly: r.friendly_text,
    at: r.happened_at,
  }));
}

/** "Payment received — ৳1,000 with bKash." for the customer's update list. */
export interface PaymentUpdate {
  title: string;
  text: string;
  at: string;
}

export function paymentUpdates(payments: Pick<CustomerPayment, 'kind' | 'amount' | 'method' | 'paid_at'>[]): PaymentUpdate[] {
  return payments
    .filter((p) => p.kind === 'payment' && p.amount > 0)
    .map((p) => ({
      title: 'Payment received',
      text: `${formatTakaBd(p.amount)} with ${PAYMENT_METHOD_NAMES[p.method] ?? 'Other'}. Thank you!`,
      at: p.paid_at,
    }));
}

/** Money in per method (refunds taken off), for "Paid with bKash − ৳1,000". */
export function paidByMethod(payments: Pick<OrderPayment, 'kind' | 'amount' | 'method'>[]): { method: PaymentMethodId; amount: number }[] {
  const totals = new Map<PaymentMethodId, number>();
  for (const p of payments) {
    const sign = p.kind === 'refund' ? -1 : 1;
    totals.set(p.method, (totals.get(p.method) ?? 0) + sign * Number(p.amount));
  }
  return [...totals.entries()].filter(([, amount]) => amount > 0).map(([method, amount]) => ({ method, amount }));
}

export interface PaymentPill {
  tone: 'amber' | 'green' | 'neutral';
  text: string;
}

/**
 * The payment pill under the big line on the customer's order page —
 * amounts straight from the existing payment summary (Batch 30/32):
 *   still to collect by the courier → amber "Pay on delivery: ৳X"
 *   fully paid                      → green "Paid in full: ৳X"
 *   pays later                      → neutral "Balance due: ৳X"
 */
export function customerPaymentPill(input: {
  total: number;
  due: number;
  paid: number;
  payLater: boolean;
  fallbackPaid: boolean;
  /** Already delivered: anything still owed is a balance, not "on delivery". */
  delivered?: boolean;
}): PaymentPill {
  if (input.due <= 0 || input.fallbackPaid) return { tone: 'green', text: `Paid in full: ${formatTakaBd(input.total)}` };
  if (input.payLater || input.delivered) return { tone: 'neutral', text: `Balance due: ${formatTakaBd(input.due)}` };
  return { tone: 'amber', text: `Pay on delivery: ${formatTakaBd(input.due)}` };
}

/** When each step was reached, where the site knows it: the order's own
 *  history and the first update that proves a step. */
export function stepTimes(
  order: Pick<Order, 'created_at' | 'steadfast_status_updated_at'>,
  history: Pick<OrderStatusHistoryRow, 'new_status' | 'changed_at'>[],
  updates: { step: TrackStatus | null; at: string | null }[],
  track: TrackResult
): Partial<Record<TrackStatus, string>> {
  const firstHistory = (status: string) => history.find((h) => h.new_status === status)?.changed_at;
  const firstUpdate = (step: TrackStatus) => updates.find((u) => u.step === step && u.at)?.at ?? undefined;
  const times: Partial<Record<TrackStatus, string>> = {};
  const set = (step: TrackStatus, value: string | null | undefined) => {
    if (value) times[step] = value;
  };
  set('processing', order.created_at);
  set('confirmed', firstHistory('confirmed'));
  set('in_transit', firstHistory('shipped') ?? firstUpdate('in_transit'));
  set('out_for_delivery', firstUpdate('out_for_delivery'));
  set(
    'delivered',
    firstHistory('delivered') ?? firstUpdate('delivered') ?? (track.status === 'delivered' ? order.steadfast_status_updated_at : null)
  );
  set('cancelled', firstHistory('cancelled'));
  set('returned', track.status === 'returned' ? (firstUpdate('returned') ?? order.steadfast_status_updated_at) : null);
  return times;
}
