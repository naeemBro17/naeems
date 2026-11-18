import { supabase } from './supabase';
import { formatTakaBd } from './adminNav';
import { formatDhakaDateTime } from '../../supabase/functions/_shared/orderTracking';
import { MATCH_REASON_TEXT, bookedOutsideSite, toPaisa, type MatchReason } from '../../supabase/functions/_shared/steadfastPayouts';

/**
 * Batch 36 Part 1: Steadfast payouts on the admin side. Every read goes
 * through tables the database only shows to "View profit & costs" (the
 * Super Admin always) — migration-038. Until that migration is run the
 * page says so instead of breaking.
 */

/** Batch 46: what a payout line is — a parcel of an order ('order'), a
 *  parcel that was not a shop sale ('courier_only'), or a returned parcel
 *  whose order was deleted ('returned'). */
export type PayoutLineKind = 'order' | 'courier_only' | 'returned';

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
  line_kind: PayoutLineKind;
  /** Batch 47: settled by hand — why, his note, who and when (null when
   *  not settled, or before migration-048). */
  settle_reason?: SettleReason | null;
  settle_note?: string | null;
  settled_by_username?: string | null;
  settled_at?: string | null;
}

/** Batch 47: why a payout line was settled by hand. */
export type SettleReason = 'courier_charge' | 'returned' | 'paid_direct' | 'not_shop_sale' | 'order_deleted' | 'other';

export const SETTLE_REASONS: { id: SettleReason; label: string; hint: string }[] = [
  { id: 'courier_charge', label: 'Courier charge only', hint: 'No money was collected for this parcel.' },
  { id: 'returned', label: 'Returned parcel', hint: 'Nothing collected.' },
  { id: 'paid_direct', label: 'Paid to me directly', hint: 'I already received the money myself.' },
  { id: 'not_shop_sale', label: 'Not a shop sale', hint: "A friend's parcel — never counted as sales." },
  { id: 'order_deleted', label: 'Order deleted', hint: 'The order was removed from the site.' },
  { id: 'other', label: 'Other', hint: 'Write a short note.' },
];

const SETTLE_IDS = new Set<string>(SETTLE_REASONS.map((r) => r.id));

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
/** The same plus line_kind (migration-047). Until it is run the column is
 *  missing and the page reads without it. */
const ITEM_COLUMNS_B46 = `${ITEM_COLUMNS}, line_kind`;
/** Plus the settle columns (migration-048). */
const ITEM_COLUMNS_B47 = `${ITEM_COLUMNS_B46}, settle_reason, settle_note, settled_by_username, settled_at`;

/** A column the query asked for is not there yet. */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === '42703' || /column .* does not exist/i.test(error.message ?? ''));
}

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
    line_kind: row.line_kind === 'courier_only' || row.line_kind === 'returned' ? row.line_kind : 'order',
    settle_reason: typeof row.settle_reason === 'string' && SETTLE_IDS.has(row.settle_reason) ? (row.settle_reason as SettleReason) : null,
    settle_note: (row.settle_note as string | null | undefined) ?? null,
    settled_by_username: (row.settled_by_username as string | null | undefined) ?? null,
    settled_at: (row.settled_at as string | null | undefined) ?? null,
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

function payoutsQuery(columns: string) {
  const select: string = `id, steadfast_payment_id, paid_at, total_amount, parcel_count, steadfast_payout_items(${columns})`;
  return supabase.from('steadfast_payouts').select(select);
}

export async function fetchPayouts(): Promise<LoadState<Payout[]>> {
  let { data, error } = await payoutsQuery(ITEM_COLUMNS_B47).order('paid_at', { ascending: false, nullsFirst: false });
  if (isMissingColumn(error)) {
    ({ data, error } = await payoutsQuery(ITEM_COLUMNS_B46).order('paid_at', { ascending: false, nullsFirst: false }));
  }
  if (isMissingColumn(error)) {
    ({ data, error } = await payoutsQuery(ITEM_COLUMNS).order('paid_at', { ascending: false, nullsFirst: false }));
  }
  if (error) return isMissingSchema(error) ? { kind: 'no-db' } : { kind: 'error', message: error.message };
  return { kind: 'ready', data: ((data ?? []) as unknown as Record<string, unknown>[]).map(toPayout) };
}

export async function fetchPayout(id: string): Promise<LoadState<Payout | null>> {
  let { data, error } = await payoutsQuery(ITEM_COLUMNS_B47).eq('id', id).maybeSingle();
  if (isMissingColumn(error)) {
    ({ data, error } = await payoutsQuery(ITEM_COLUMNS_B46).eq('id', id).maybeSingle());
  }
  if (isMissingColumn(error)) {
    ({ data, error } = await payoutsQuery(ITEM_COLUMNS).eq('id', id).maybeSingle());
  }
  if (error) return isMissingSchema(error) ? { kind: 'no-db' } : { kind: 'error', message: error.message };
  return { kind: 'ready', data: data ? toPayout(data as unknown as Record<string, unknown>) : null };
}

/** Batch 47: a line settled — by hand (this screen) or by Batch 46. */
export function isSettled(item: Pick<PayoutItem, 'line_kind' | 'settled_at' | 'settle_reason'>): boolean {
  return item.line_kind !== 'order' || Boolean(item.settled_at) || Boolean(item.settle_reason);
}

/** "Settled by naeem · 17 Nov" (who / when, as far as known). */
export function settledByText(item: Pick<PayoutItem, 'settled_by_username' | 'settled_at'>): string | null {
  const parts = [item.settled_by_username ? `by ${item.settled_by_username}` : null, item.settled_at ? shortDhakaDate(item.settled_at) : null].filter(
    (p): p is string => p !== null
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

const SETTLE_NEEDS_UPDATE = 'Settling a line needs the Batch 47 database update (migration-048).';

/** Batch 47: settle a payout line (Super Admin; checked by the database). */
export async function settlePayoutLine(itemId: string, reason: SettleReason, note: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_settle_payout_line', { p_item_id: itemId, p_reason: reason, p_note: note.trim() || null });
  if (!error) return { error: null };
  if (isMissingSchema(error)) return { error: SETTLE_NEEDS_UPDATE };
  return { error: error.message || 'Could not settle this line.' };
}

/** Batch 47: undo a settle — the line goes back to what it was. */
export async function unsettlePayoutLine(itemId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_unsettle_payout_line', { p_item_id: itemId });
  if (!error) return { error: null };
  if (isMissingSchema(error)) return { error: SETTLE_NEEDS_UPDATE };
  return { error: error.message || 'Could not undo this.' };
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

/** Parcels booked directly on Steadfast's website (no invoice) are not
 *  orders of this site — they never count as "to check". */
export function isOutsideParcel(i: Pick<PayoutItem, 'match_reason' | 'invoice'>): boolean {
  return bookedOutsideSite({ reason: i.match_reason, invoice: i.invoice });
}

/** Lines that are orders (a courier-only parcel or a returned parcel whose
 *  order was deleted is not counted as an order). */
export function payoutOrderCount(payout: Pick<Payout, 'items' | 'parcel_count'>): number {
  if (payout.items.length === 0) return payout.parcel_count;
  return payout.items.filter((i) => i.line_kind === 'order').length;
}

export function payoutToCheck(payout: Pick<Payout, 'items'>): number {
  return payout.items.filter((i) => i.match_status === 'to_check' && !isOutsideParcel(i)).length;
}

/**
 * Batch 51: a payout paid before the money start date (the opening
 * balances, confirmed 13 Nov 2026) is already counted in those balances —
 * its money was received before the books began. Display only.
 */
export function coveredByOpening(paidAt: string | null, booksStart: string | null): boolean {
  if (!paidAt || !booksStart) return false;
  const day = new Date(new Date(paidAt).getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return day < booksStart.slice(0, 10);
}

/** The pill on a payout row / the detail page. "Booked on Steadfast" (grey)
 *  = every parcel in it was booked straight on Steadfast's website, so none
 *  is an order of this site; Batch 51: such a payout from before the money
 *  start date is covered by the opening balances and reads "Matched". */
export function payoutPill(
  payout: Pick<Payout, 'items'> & { paid_at?: string | null },
  booksStart: string | null = null
): { tone: 'green' | 'amber' | 'grey'; text: string } {
  const open = payoutToCheck(payout);
  if (open > 0) return { tone: 'amber', text: `${open} to check` };
  if (payout.items.length > 0 && payout.items.every(isOutsideParcel) && !coveredByOpening(payout.paid_at ?? null, booksStart)) {
    return { tone: 'grey', text: 'Booked on Steadfast' };
  }
  return { tone: 'green', text: 'Matched' };
}

/** Batch 51: the start date of the books, once confirmed (null before). */
export async function fetchBooksStart(): Promise<string | null> {
  const { data, error } = await supabase.from('money_books').select('start_date, confirmed_at').eq('id', 1).maybeSingle();
  if (error || !data) return null;
  const row = data as { start_date: string | null; confirmed_at: string | null };
  return row.confirmed_at ? row.start_date : null;
}

/** Batch 51: the words under the Steadfast balance — the count and the
 *  amount always agree. */
export function balanceLine(balance: number | null, unpaidCount: number): string {
  if (balance !== null && Math.round(balance * 100) === 0) return 'Nothing waiting from Steadfast';
  if (unpaidCount > 0) return `From ${unpaidCount} delivered order${unpaidCount === 1 ? '' : 's'}`;
  return 'Waiting from Steadfast';
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
      if (i.line_kind === 'order') totals.orders += 1;
      totals.codPaisa += toPaisa(i.cod_collected);
      totals.chargesPaisa += toPaisa(i.delivery_charge) + toPaisa(i.other_deduction);
      totals.codFeePaisa += toPaisa(i.cod_fee);
      totals.receivedPaisa += toPaisa(i.net_paid);
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

export const LINE_KIND_TEXT: Record<Exclude<PayoutLineKind, 'order'>, string> = {
  courier_only: 'Not a shop sale: courier only',
  returned: 'Returned parcel (order deleted): its charge counts as a delivery cost',
};

export function reasonText(
  item: Pick<PayoutItem, 'match_reason' | 'note' | 'invoice' | 'line_kind' | 'settled_at' | 'settle_reason'>
): string | null {
  if (item.line_kind !== 'order') return item.note ?? LINE_KIND_TEXT[item.line_kind];
  // Batch 47: settled by hand but still linked to its order.
  if (isSettled(item)) return item.note;
  if (!item.match_reason) return null;
  if (isOutsideParcel(item)) return 'Booked directly on Steadfast, not from this site';
  return item.note ?? MATCH_REASON_TEXT[item.match_reason];
}
