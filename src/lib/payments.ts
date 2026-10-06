import { supabase } from './supabase';

/* Batch 30 Part 3 — payments on an order (advance, partial, full, refund).
   Read from order_payments (migration-033); every write goes through a
   database function that checks the permission again. Until migration-033
   is run every read here returns null and the screens keep their old
   payment display. */

export type PaymentMethodId = 'bkash' | 'nagad' | 'cash' | 'bank' | 'cod_steadfast' | 'other';
export type PaymentKind = 'payment' | 'refund';
export type PaymentState = 'unpaid' | 'partly_paid' | 'paid' | 'refunded';

export interface OrderPayment {
  id: string;
  order_id: string;
  kind: PaymentKind;
  amount: number;
  method: PaymentMethodId;
  trx_id: string | null;
  paid_at: string;
  note: string | null;
  source: 'manual' | 'mark_paid' | 'status_paid' | 'steadfast_cod';
  created_by_username: string | null;
  updated_by_username: string | null;
}

export const PAYMENT_METHODS: { id: PaymentMethodId; label: string }[] = [
  { id: 'bkash', label: 'bKash' },
  { id: 'nagad', label: 'Nagad' },
  { id: 'cash', label: 'Cash' },
  { id: 'bank', label: 'Bank' },
  { id: 'cod_steadfast', label: 'COD via Steadfast' },
  { id: 'other', label: 'Other' },
];

/** Batch 32: how money can be "paid now" in New order / Edit order — the
 *  one place this list lives (it can become a shop setting later). */
export const PAID_NOW_METHODS: readonly PaymentMethodId[] = ['bkash', 'nagad', 'cash', 'bank'];

export const PAYMENT_METHOD_NAMES: Record<PaymentMethodId, string> = Object.fromEntries(
  PAYMENT_METHODS.map((m) => [m.id, m.label])
) as Record<PaymentMethodId, string>;

export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  unpaid: 'Unpaid',
  partly_paid: 'Partly paid',
  paid: 'Paid',
  refunded: 'Refunded',
};

export interface PaymentSummary {
  total: number;
  /** Money in minus refunds. */
  paid: number;
  refunded: number;
  /** Never below 0. */
  due: number;
  /** Paid beyond the total (0 when not over-paid). */
  overpaid: number;
  state: PaymentState;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The same rule as order_payment_summary() in migration-033. */
export function summarizePayments(total: number, payments: Pick<OrderPayment, 'kind' | 'amount'>[]): PaymentSummary {
  let moneyIn = 0;
  let moneyOut = 0;
  for (const p of payments) {
    if (p.kind === 'refund') moneyOut += Number(p.amount);
    else moneyIn += Number(p.amount);
  }
  const paid = round2(moneyIn - moneyOut);
  const state: PaymentState =
    moneyOut > 0 && paid <= 0 ? 'refunded' : paid > 0 && paid >= total ? 'paid' : paid > 0 ? 'partly_paid' : 'unpaid';
  return {
    total,
    paid,
    refunded: round2(moneyOut),
    due: round2(Math.max(total - paid, 0)),
    overpaid: round2(Math.max(paid - total, 0)),
    state,
  };
}

/** "Partly paid · ৳300 due" style text for lists. */
export function paymentStateText(summary: PaymentSummary, formatMoney: (n: number) => string): string {
  if (summary.state === 'partly_paid') return `Partly paid · ${formatMoney(summary.due)} due`;
  if (summary.state === 'paid' && summary.overpaid > 0) return `Paid · over ${formatMoney(summary.overpaid)}`;
  return PAYMENT_STATE_LABELS[summary.state];
}

function normalize(row: Record<string, unknown>): OrderPayment {
  return {
    id: row.id as string,
    order_id: row.order_id as string,
    kind: (row.kind as PaymentKind) ?? 'payment',
    amount: Number(row.amount),
    method: row.method as PaymentMethodId,
    trx_id: (row.trx_id as string | null) ?? null,
    paid_at: row.paid_at as string,
    note: (row.note as string | null) ?? null,
    source: row.source as OrderPayment['source'],
    created_by_username: (row.created_by_username as string | null) ?? null,
    updated_by_username: (row.updated_by_username as string | null) ?? null,
  };
}

const PAYMENT_SELECT = 'id, order_id, kind, amount, method, trx_id, paid_at, note, source, created_by_username, updated_by_username';

/** One order's payments, oldest first — null before migration-033. */
export async function fetchOrderPayments(orderId: string): Promise<OrderPayment[] | null> {
  const { data, error } = await supabase
    .from('order_payments')
    .select(PAYMENT_SELECT)
    .eq('order_id', orderId)
    .order('paid_at', { ascending: true });
  if (error) return null;
  return ((data ?? []) as Record<string, unknown>[]).map(normalize);
}

/** Every order's payments (staff list views) — null before migration-033. */
export async function fetchAllPayments(): Promise<Map<string, OrderPayment[]> | null> {
  const { data, error } = await supabase.from('order_payments').select(PAYMENT_SELECT);
  if (error) return null;
  const map = new Map<string, OrderPayment[]>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const p = normalize(row);
    const list = map.get(p.order_id) ?? [];
    list.push(p);
    map.set(p.order_id, list);
  }
  return map;
}

/** The customer's own order page: amounts only, never notes. Null before
 *  migration-033 (or not their order). */
export async function fetchPaymentSummary(orderId: string): Promise<PaymentSummary | null> {
  const { data, error } = await supabase.rpc('order_payment_summary', { p_order_id: orderId });
  const row = (data as Record<string, unknown>[] | null)?.[0];
  if (error || !row) return null;
  const total = Number(row.total);
  const paid = Number(row.paid);
  return {
    total,
    paid,
    refunded: Number(row.refunded),
    due: Number(row.due),
    overpaid: round2(Math.max(paid - total, 0)),
    state: row.payment_state as PaymentState,
  };
}

export interface PaymentInput {
  amount: number;
  method: PaymentMethodId;
  trxId: string;
  /** ISO time; null = now. */
  paidAt: string | null;
  note: string;
  kind: PaymentKind;
}

export async function addOrderPayment(orderId: string, input: PaymentInput): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_add_order_payment', {
    p_order_id: orderId,
    p_amount: input.amount,
    p_method: input.method,
    p_trx_id: input.trxId.trim() || null,
    p_paid_at: input.paidAt,
    p_note: input.note.trim() || null,
    p_kind: input.kind,
  });
  return { error: error?.message ?? null };
}

export async function markOrderFullyPaid(
  orderId: string,
  method: PaymentMethodId,
  trxId: string,
  note: string
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_mark_order_fully_paid', {
    p_order_id: orderId,
    p_method: method,
    p_trx_id: trxId.trim() || null,
    p_note: note.trim() || null,
  });
  return { error: error?.message ?? null };
}

export async function updateOrderPayment(paymentId: string, input: PaymentInput): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_update_order_payment', {
    p_payment_id: paymentId,
    p_amount: input.amount,
    p_method: input.method,
    p_trx_id: input.trxId.trim() || null,
    p_paid_at: input.paidAt,
    p_note: input.note.trim() || null,
  });
  return { error: error?.message ?? null };
}

export async function deleteOrderPayment(paymentId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_delete_order_payment', { p_payment_id: paymentId });
  return { error: error?.message ?? null };
}
