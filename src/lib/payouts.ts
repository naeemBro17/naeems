import { supabase } from './supabase';
import { formatTakaBd } from './adminNav';
import { formatDhakaDateTime } from '../../supabase/functions/_shared/orderTracking';
import { MATCH_REASON_TEXT, toPaisa, type MatchReason } from '../../supabase/functions/_shared/steadfastPayouts';

/**
 * Batch 36 Part 1: Steadfast payouts on the admin side. Every read goes
 * through tables the database only shows to "View profit & costs" (the
 * Super Admin always) — migration-038. Until that migration is run the
 * page says so instead of breaking.
 */

export interface PayoutItem {
  id: string;
  payout_id: string;
  consignment_id: string | null;
  invoice: string | null;
  order_id: string | null;
  cod_collected: number;
  delivery_charge: number;
  cod_fee: number;
  other_deduction: number;
  net_paid: number;
  expected_cod: number | null;
  match_status: 'matched' | 'to_check';
  match_reason: MatchReason | null;
  note: string | null;
}

export interface Payout {
  id: string;
  steadfast_payment_id: string;
  paid_at: string | null;
  total_amount: number;
  parcel_count: number;
  items: PayoutItem[];
}

export interface SyncState {
  current_balance: number | null;
  balance_at: string | null;
  last_sync_at: string | null;
  last_sync_error: string | null;
}

export interface UnpaidOrder {
  order_id: string;
  order_number: string;
  delivered_at: string;
}

export interface OrderPayoutInfo {
  net_received: number;
  total_kept: number;
  paid_at: string | null;
  payment_id: string | null;
  payout_id: string | null;
}

export type LoadState<T> = { kind: 'ready'; data: T } | { kind: 'no-db' } | { kind: 'error'; message: string };

const ITEM_COLUMNS =
  'id, payout_id, consignment_id, invoice, order_id, cod_collected, delivery_charge, cod_fee, other_deduction, net_paid, expected_cod, match_status, match_reason, note';

/** The table (or function) isn't there yet — migration-038 not run. */
export function isMissingSchema(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    error.code === 'PGRST202' ||
    /does not exist|schema cache/i.test(error.message ?? '')
  );
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toItem(row: Record<string, unknown>): PayoutItem {
  return {
    id: String(row.id),
    payout_id: String(row.payout_id),
    consignment_id: (row.consignment_id as string | null) ?? null,
    invoice: (row.invoice as string | null) ?? null,
    order_id: (row.order_id as string | null) ?? null,
    cod_collected: num(row.cod_collected),
    delivery_charge: num(row.delivery_charge),
    cod_fee: num(row.cod_fee),
    other_deduction: num(row.other_deduction),
    net_paid: num(row.net_paid),
    expected_cod: row.expected_cod === null || row.expected_cod === undefined ? null : num(row.expected_cod),
    match_status: row.match_status === 'matched' ? 'matched' : 'to_check',
    match_reason: (row.match_reason as MatchReason | null) ?? null,
    note: (row.note as string | null) ?? null,
  };
}

function toPayout(row: Record<string, unknown>): Payout {
  const items = Array.isArray(row.steadfast_payout_items)
    ? (row.steadfast_payout_items as Record<string, unknown>[]).map(toItem)
    : [];
  return {
    id: String(row.id),
    steadfast_payment_id: String(row.steadfast_payment_id),
    paid_at: (row.paid_at as string | null) ?? null,
    total_amount: num(row.total_amount),
    parcel_count: num(row.parcel_count),
    items,
  };
}

export async function fetchPayouts(): Promise<LoadState<Payout[]>> {
  const { data, error } = await supabase
    .from('steadfast_payouts')
    .select(`id, steadfast_payment_id, paid_at, total_amount, parcel_count, steadfast_payout_items(${ITEM_COLUMNS})`)
    .order('paid_at', { ascending: false, nullsFirst: false });
  if (error) return isMissingSchema(error) ? { kind: 'no-db' } : { kind: 'error', message: error.message };
  return { kind: 'ready', data: ((data ?? []) as Record<string, unknown>[]).map(toPayout) };
}

export async function fetchPayout(id: string): Promise<LoadState<Payout | null>> {
  const { data, error } = await supabase
    .from('steadfast_payouts')
    .select(`id, steadfast_payment_id, paid_at, total_amount, parcel_count, steadfast_payout_items(${ITEM_COLUMNS})`)
    .eq('id', id)
    .maybeSingle();
  if (error) return isMissingSchema(error) ? { kind: 'no-db' } : { kind: 'error', message: error.message };
  return { kind: 'ready', data: data ? toPayout(data as Record<string, unknown>) : null };
}

export async function fetchSyncState(): Promise<SyncState | null> {
  const { data, error } = await supabase
    .from('steadfast_sync_state')
    .select('current_balance, balance_at, last_sync_at, last_sync_error')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return {
    current_balance: row.current_balance === null ? null : num(row.current_balance),
    balance_at: (row.balance_at as string | null) ?? null,
    last_sync_at: (row.last_sync_at as string | null) ?? null,
    last_sync_error: (row.last_sync_error as string | null) ?? null,
  };
}

/** Delivered Steadfast orders in no payout yet (any age). */
export async function fetchUnpaidOrders(): Promise<UnpaidOrder[]> {
  const { data, error } = await supabase.rpc('steadfast_unpaid_orders', { p_days: 0 });
  if (error || !Array.isArray(data)) return [];
  return (data as UnpaidOrder[]).map((r) => ({ ...r }));
}

/** "Steadfast paid ৳X on 8 Oct" for one order, or null (not paid yet, or
 *  this person may not see it). */
export async function fetchOrderPayout(orderId: string): Promise<LoadState<OrderPayoutInfo | null>> {
  const { data, error } = await supabase
    .from('order_courier_costs')
    .select('net_received, total_kept, paid_at, payout_id, steadfast_payouts(steadfast_payment_id)')
    .eq('order_id', orderId)
    .maybeSingle();
  if (error) return isMissingSchema(error) ? { kind: 'no-db' } : { kind: 'error', message: error.message };
  if (!data) return { kind: 'ready', data: null };
  const row = data as Record<string, unknown>;
  const payout = row.steadfast_payouts as { steadfast_payment_id?: string } | null;
  return {
    kind: 'ready',
    data: {
      net_received: num(row.net_received),
      total_kept: num(row.total_kept),
      paid_at: (row.paid_at as string | null) ?? null,
      payout_id: (row.payout_id as string | null) ?? null,
      payment_id: payout?.steadfast_payment_id ?? null,
    },
  };
}

export interface SyncAnswer {
  ok: boolean;
  error?: string;
}

/** The Refresh button: the steadfast function reads Steadfast (GET only). */
export async function syncPayouts(): Promise<SyncAnswer> {
  const { data, error } = await supabase.functions.invoke('steadfast', { body: { action: 'payouts_sync' } });
  if (error) return { ok: false, error: 'Could not reach the server. Please try again.' };
  const answer = data as { ok?: boolean; error?: string | null } | null;
  return answer?.ok ? { ok: true } : { ok: false, error: answer?.error ?? 'Steadfast did not answer.' };
}

/* ---------------- Pure helpers (unit tested) ---------------- */

/** Fees = delivery charge + COD fee + other, exact in paisa. */
export function itemFeesPaisa(item: Pick<PayoutItem, 'delivery_charge' | 'cod_fee' | 'other_deduction'>): number {
  return toPaisa(item.delivery_charge) + toPaisa(item.cod_fee) + toPaisa(item.other_deduction);
}

export function payoutFeesPaisa(payout: Pick<Payout, 'items'>): number {
  return payout.items.reduce((sum, i) => sum + itemFeesPaisa(i), 0);
}

export function payoutToCheck(payout: Pick<Payout, 'items'>): number {
  return payout.items.filter((i) => i.match_status === 'to_check').length;
}

/** The pill on a payout row / the detail page. */
export function payoutPill(payout: Pick<Payout, 'items'>): { tone: 'green' | 'amber'; text: string } {
  const open = payoutToCheck(payout);
  if (open === 0) return { tone: 'green', text: 'Matched' };
  return { tone: 'amber', text: `${open} to check` };
}

/** "2026-10" in Dhaka time. */
export function dhakaMonthKey(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 6 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-10" → "October" (this year) or "October 2025". */
export function monthLabel(key: string, now: Date = new Date()): string {
  const [y, m] = key.split('-').map(Number);
  const name = MONTH_NAMES[(m ?? 1) - 1] ?? key;
  return y === Number(dhakaMonthKey(now.toISOString()).slice(0, 4)) ? name : `${name} ${y}`;
}

export interface MonthTotals {
  codPaisa: number;
  chargesPaisa: number;
  codFeePaisa: number;
  receivedPaisa: number;
  orders: number;
}

/** "This month": the exact sum of every parcel in that month's payouts.
 *  Anything Steadfast kept besides the delivery charge and COD fee is
 *  shown with the courier charges. */
export function monthTotals(payouts: readonly Payout[], key: string): MonthTotals {
  const totals: MonthTotals = { codPaisa: 0, chargesPaisa: 0, codFeePaisa: 0, receivedPaisa: 0, orders: 0 };
  for (const p of payouts) {
    if (!p.paid_at || dhakaMonthKey(p.paid_at) !== key) continue;
    for (const i of p.items) {
      totals.codPaisa += toPaisa(i.cod_collected);
      totals.chargesPaisa += toPaisa(i.delivery_charge) + toPaisa(i.other_deduction);
      totals.codFeePaisa += toPaisa(i.cod_fee);
      totals.receivedPaisa += toPaisa(i.net_paid);
      totals.orders += 1;
    }
  }
  return totals;
}

/** Months to pick from: this month, then every month with a payout. */
export function monthOptions(payouts: readonly Payout[], now: Date = new Date()): string[] {
  const keys = new Set<string>([dhakaMonthKey(now.toISOString())]);
  for (const p of payouts) if (p.paid_at) keys.add(dhakaMonthKey(p.paid_at));
  return [...keys].sort().reverse();
}

export const UNPAID_AFTER_DAYS = 7;

/** Delivered more than 7 days ago and still in no payout. */
export function overdueOrders(rows: readonly UnpaidOrder[], now: Date = new Date(), days = UNPAID_AFTER_DAYS): UnpaidOrder[] {
  const limit = now.getTime() - days * 24 * 60 * 60 * 1000;
  return rows.filter((r) => new Date(r.delivered_at).getTime() < limit);
}

/** Whole taka for the screen; the exact amount for a tooltip. */
export function takaWhole(paisa: number): string {
  return formatTakaBd(paisa / 100);
}

export function takaExact(paisa: number): string {
  const negative = paisa < 0;
  const abs = Math.abs(Math.round(paisa));
  const whole = formatTakaBd(Math.floor(abs / 100)).replace('৳', '');
  return `${negative ? '-' : ''}৳${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** "8 Oct" in Dhaka time. */
export function shortDhakaDate(iso: string): string {
  const full = formatDhakaDateTime(iso);
  return full.slice(0, full.indexOf(','));
}

/** "updated 10 min ago". */
export function updatedAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'not updated yet';
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'updated just now';
  if (minutes < 60) return `updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `updated ${hours} h ago`;
  return `updated ${shortDhakaDate(iso)}`;
}

export function reasonText(item: Pick<PayoutItem, 'match_reason' | 'note'>): string | null {
  if (!item.match_reason) return null;
  return item.note ?? MATCH_REASON_TEXT[item.match_reason];
}
