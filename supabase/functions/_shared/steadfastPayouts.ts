// Batch 36 Part 1: Steadfast payouts — what Steadfast collected, what it
// kept (delivery charge + 1% COD fee + anything else) and what reached
// Naeem, per order and per payout. Shared by the `steadfast` function (the
// "Refresh" button), `steadfast-refresh-all` (the 3-hourly job) and the
// unit tests. Nothing here talks to the network or the database itself:
// the caller hands in `fetchJson` (READ-ONLY Steadfast GETs) and a
// `PayoutStore`, so the whole sync can be tested with fakes.
//
// Endpoints (Steadfast API guide, all GET):
//   /get_balance           → { status, current_balance }
//   /payments              → the list of payouts (paged on some accounts)
//   /payments/{payment_id} → one payout with the parcels inside it
// The guide does not spell out every field of the two payment answers, so
// each reader below accepts the names Steadfast is known to use and keeps
// the raw answer next to what it understood (reports/batch-36.txt).
//
// Money is handled in whole paisa (integers) so totals are exact; it is
// stored as numeric(12,2) and shown as whole taka.

import { courierCod } from './cod.ts';

/** The COD fee Steadfast charges (1% of the COD collected). */
export const COD_FEE_RATE = 0.01;

/** ৳12.34 → 1234. Anything that isn't a finite number is 0. */
export function toPaisa(value: unknown): number {
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** 1234 → 12.34 (two decimals, for the database). */
export function fromPaisa(paisa: number): number {
  return Math.round(paisa) / 100;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** First present (non-null, non-empty) value among the given keys. */
function pick(obj: Json, keys: readonly string[]): unknown {
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function hasAny(obj: Json, keys: readonly string[]): boolean {
  return pick(obj, keys) !== undefined;
}

function text(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Steadfast dates come as ISO strings or "2026-10-08 16:10:00" (Dhaka). */
export function parseSteadfastDate(v: unknown): string | null {
  const raw = text(v);
  if (!raw) return null;
  const plain = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(raw);
  if (plain) {
    const time = plain[2].length === 5 ? `${plain[2]}:00` : plain[2];
    return new Date(`${plain[1]}T${time}+06:00`).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T00:00:00+06:00`).toISOString();
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/* ---------------- Reading Steadfast's answers ---------------- */

export function parseBalance(body: unknown): number | null {
  if (!isObject(body)) return null;
  const v = pick(body, ['current_balance', 'balance']);
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? fromPaisa(toPaisa(n)) : null;
}

export interface PayoutSummary {
  paymentId: string;
  paidAt: string | null;
  amountPaisa: number;
  parcelCount: number | null;
  steadfastStatus: string | null;
  /** Payout-level totals, when Steadfast gives them (its real answer:
   *  amount = COD collected, charges = COD fees, due_bills = delivery
   *  charges, total = what was paid; checked live in Batch 36). */
  codTotalPaisa: number | null;
  feeTotalPaisa: number | null;
  deliveryTotalPaisa: number | null;
  raw: Json;
}

const PAYMENT_ID_KEYS = ['payment_id', 'id', 'payment_invoice_id', 'invoice_id'] as const;
const PAYMENT_DATE_KEYS = ['paid_at', 'payment_date', 'date', 'created_at', 'updated_at'] as const;
// What reached Naeem. Steadfast's own answer calls it "total" ("amount" is
// the COD collected before charges).
const PAYMENT_AMOUNT_KEYS = ['total', 'net_amount', 'payable_amount', 'paid_amount', 'total_amount', 'amount'] as const;
const PAYMENT_COUNT_KEYS = ['total_consignment', 'total_consignments', 'consignment_count', 'parcel_count', 'total_parcel', 'count'] as const;

function optionalPaisa(obj: Json, key: string): number | null {
  return obj[key] === undefined || obj[key] === null || obj[key] === '' ? null : toPaisa(obj[key]);
}

function readPayoutSummary(obj: Json): PayoutSummary | null {
  const paymentId = text(pick(obj, PAYMENT_ID_KEYS));
  if (!paymentId) return null;
  const count = Number(pick(obj, PAYMENT_COUNT_KEYS));
  const hasNet = hasAny(obj, ['total', 'net_amount', 'payable_amount', 'paid_amount']);
  return {
    paymentId,
    paidAt: parseSteadfastDate(pick(obj, PAYMENT_DATE_KEYS)),
    amountPaisa: toPaisa(pick(obj, PAYMENT_AMOUNT_KEYS)),
    parcelCount: Number.isFinite(count) && count >= 0 ? Math.round(count) : null,
    steadfastStatus: text(pick(obj, ['status_label', 'status', 'payment_status'])),
    codTotalPaisa: hasNet ? optionalPaisa(obj, 'amount') : null,
    feeTotalPaisa: optionalPaisa(obj, 'charges'),
    deliveryTotalPaisa: optionalPaisa(obj, 'due_bills'),
    raw: obj,
  };
}

/** The list rows, wherever the answer keeps them: a bare array, `data`,
 *  `data.data` (Laravel paging) or `payments`. */
function listRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isObject(body)) return [];
  for (const key of ['data', 'payments', 'items', 'results']) {
    const v = body[key];
    if (Array.isArray(v)) return v;
    if (isObject(v)) {
      for (const inner of ['data', 'payments', 'items']) {
        if (Array.isArray(v[inner])) return v[inner] as unknown[];
      }
    }
  }
  return [];
}

/** The paging block, at the top or under `data`. */
function pagingOf(body: unknown): Json | null {
  if (!isObject(body)) return null;
  if (hasAny(body, ['last_page', 'next_page_url'])) return body;
  if (isObject(body.data) && hasAny(body.data, ['last_page', 'next_page_url'])) return body.data;
  if (isObject(body.meta) && hasAny(body.meta, ['last_page'])) return body.meta;
  return null;
}

export function parsePaymentsList(body: unknown, page = 1): { payouts: PayoutSummary[]; hasMore: boolean; paged: boolean } {
  const payouts = listRows(body)
    .filter(isObject)
    .map(readPayoutSummary)
    .filter((p): p is PayoutSummary => p !== null);
  const paging = pagingOf(body);
  let hasMore = false;
  if (paging) {
    const last = Number(paging.last_page);
    const current = Number(paging.current_page ?? page);
    if (Number.isFinite(last) && Number.isFinite(current)) hasMore = current < last;
    else hasMore = typeof paging.next_page_url === 'string' && paging.next_page_url !== '';
  }
  return { payouts, hasMore: hasMore && payouts.length > 0, paged: paging !== null };
}

export interface PayoutItem {
  consignmentId: string | null;
  invoice: string | null;
  codPaisa: number;
  deliveryChargePaisa: number;
  codFeePaisa: number;
  otherPaisa: number;
  netPaisa: number;
  /** True when the COD fee was not in the answer and was worked out as 1%. */
  feeEstimated: boolean;
  /** Steadfast gave this parcel's own delivery charge. */
  chargeGiven: boolean;
  raw: Json;
}

const COD_KEYS = ['cod_amount', 'collected_amount', 'cod', 'amount_to_collect', 'collection_amount'] as const;
const CHARGE_KEYS = ['delivery_charge', 'delivery_fee', 'charge', 'shipping_charge'] as const;
const FEE_KEYS = ['cod_charge', 'cod_fee', 'cod_charge_amount', 'cash_on_delivery_charge'] as const;
const OTHER_KEYS = ['return_charge', 'other_charge', 'other_deduction', 'adjustment', 'discount_charge'] as const;
const NET_KEYS = ['payable_amount', 'net_amount', 'net_payable', 'amount_payable', 'paid_amount', 'merchant_payable'] as const;

/**
 * One parcel in a payout. When Steadfast gives the net it paid, that is the
 * truth and anything not explained by the delivery charge and COD fee is
 * "other". When it does not, net = COD − charge − fee − other.
 */
export function readPayoutItem(obj: Json): PayoutItem | null {
  const consignmentId = text(pick(obj, ['consignment_id', 'cid', 'consignment']));
  const invoice = text(pick(obj, ['invoice', 'merchant_invoice', 'invoice_id', 'order_id']));
  if (!consignmentId && !invoice) return null;
  const codPaisa = toPaisa(pick(obj, COD_KEYS));
  const deliveryChargePaisa = Math.abs(toPaisa(pick(obj, CHARGE_KEYS)));
  const feeGiven = hasAny(obj, FEE_KEYS);
  let codFeePaisa = feeGiven ? Math.abs(toPaisa(pick(obj, FEE_KEYS))) : Math.round(codPaisa * COD_FEE_RATE);
  let otherPaisa = OTHER_KEYS.reduce((sum, k) => sum + Math.abs(toPaisa(obj[k])), 0);
  let netPaisa: number;
  if (hasAny(obj, NET_KEYS)) {
    netPaisa = toPaisa(pick(obj, NET_KEYS));
    const unexplained = codPaisa - deliveryChargePaisa - codFeePaisa - netPaisa;
    if (!feeGiven) {
      // The 1% guess never claims more than what is actually missing.
      codFeePaisa = Math.max(0, Math.min(codFeePaisa, codPaisa - deliveryChargePaisa - netPaisa));
      otherPaisa = Math.max(0, codPaisa - deliveryChargePaisa - codFeePaisa - netPaisa);
    } else {
      otherPaisa = Math.max(0, unexplained);
    }
  } else {
    netPaisa = codPaisa - deliveryChargePaisa - codFeePaisa - otherPaisa;
  }
  return {
    consignmentId,
    invoice,
    codPaisa,
    deliveryChargePaisa,
    codFeePaisa,
    otherPaisa,
    netPaisa,
    feeEstimated: !feeGiven,
    chargeGiven: hasAny(obj, CHARGE_KEYS),
    raw: obj,
  };
}

export function parsePaymentDetail(body: unknown): { summary: Partial<PayoutSummary>; items: PayoutItem[] } {
  let root: unknown = body;
  if (isObject(body) && isObject(body.data)) root = body.data;
  if (isObject(body) && isObject(body.payment)) root = body.payment;
  let rows: unknown[] = [];
  if (Array.isArray(root)) rows = root;
  else if (isObject(root)) {
    for (const key of ['consignments', 'items', 'parcels', 'details', 'data']) {
      if (Array.isArray(root[key])) {
        rows = root[key] as unknown[];
        break;
      }
    }
  }
  if (rows.length === 0 && isObject(body)) {
    for (const key of ['consignments', 'items', 'parcels']) {
      if (Array.isArray(body[key])) {
        rows = body[key] as unknown[];
        break;
      }
    }
  }
  const summary = isObject(root) ? readPayoutSummary(root) : null;
  return {
    summary: summary ?? {},
    items: rows.filter(isObject).map(readPayoutItem).filter((i): i is PayoutItem => i !== null),
  };
}

/* ---------------- Matching ---------------- */

export type MatchStatus = 'matched' | 'to_check';
export type MatchReason = 'cod_differs' | 'order_not_found' | 'order_cancelled' | 'duplicate';

export const MATCH_REASON_TEXT: Record<MatchReason, string> = {
  cod_differs: 'COD differs from the order',
  order_not_found: 'Order not found',
  order_cancelled: 'Order is cancelled here',
  duplicate: 'Already in another payout',
};

/** What the matcher needs to know about one of our orders. */
export interface OrderForMatch {
  id: string;
  order_number: string;
  status: string;
  total: number;
  collect_mode: string | null;
  steadfast_consignment_id: string | null;
  steadfast_cod_amount: number | null;
  /** Payments and refunds, minus the "COD via Steadfast" row itself. */
  paid_before_courier: number;
  /** The delivery fee on our order — the guide for splitting Steadfast's
   *  payout-level delivery charges between parcels. */
  delivery_fee?: number | null;
}

/** Our order numbers ("NM-1979", migration-021); the site books every
 *  parcel with one as its invoice. */
export const SITE_ORDER_NUMBER = /^NM-\d+$/i;

/** "Order not found" for a parcel whose invoice is not one of our order
 *  numbers (none, "N/A", or Steadfast's own code): it was booked directly
 *  on Steadfast's website, not from this site. */
export function bookedOutsideSite(item: { reason: MatchReason | null; invoice: string | null }): boolean {
  return item.reason === 'order_not_found' && !SITE_ORDER_NUMBER.test((item.invoice ?? '').trim());
}

/** Splits `totalPaisa` by weights, exactly (largest remainder). */
export function splitExactly(totalPaisa: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = safe.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? safe.map((w) => (totalPaisa * w) / sum) : safe.map(() => totalPaisa / safe.length);
  const floors = shares.map((s) => Math.floor(s));
  let left = totalPaisa - floors.reduce((a, b) => a + b, 0);
  const order = shares.map((s, i) => [s - Math.floor(s), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

/**
 * Steadfast's real payout answer gives the COD fee ("charges") and the
 * delivery charges ("due_bills") only as payout totals, not per parcel.
 * They are split here so every payout still adds up to the paisa: the COD
 * fee by each parcel's COD, the delivery charges by our own order's
 * delivery fee (inside / outside Dhaka) where known, otherwise equally.
 * Anything else Steadfast kept (paid − (COD − fee − delivery)) becomes
 * "other", split by COD. The per-order amounts are marked as estimates.
 */
export function allocatePayoutTotals<T extends PayoutItem>(
  items: readonly T[],
  summary: Pick<PayoutSummary, 'amountPaisa' | 'feeTotalPaisa' | 'deliveryTotalPaisa'>,
  deliveryWeights: readonly (number | null)[]
): T[] {
  if (items.length === 0 || items.some((i) => i.chargeGiven)) return [...items];
  if (summary.feeTotalPaisa === null && summary.deliveryTotalPaisa === null) return [...items];
  const cods = items.map((i) => i.codPaisa);
  const fees = summary.feeTotalPaisa === null ? items.map((i) => i.codFeePaisa) : splitExactly(summary.feeTotalPaisa, cods);
  const known = deliveryWeights.filter((w): w is number => w !== null && w > 0);
  const fallback = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const weights = deliveryWeights.map((w) => (w !== null && w > 0 ? w : fallback));
  const delivery = splitExactly(summary.deliveryTotalPaisa ?? 0, weights);
  const codSum = cods.reduce((a, b) => a + b, 0);
  const feeSum = fees.reduce((a, b) => a + b, 0);
  const deliverySum = delivery.reduce((a, b) => a + b, 0);
  const otherTotal = Math.max(0, codSum - feeSum - deliverySum - summary.amountPaisa);
  const others = otherTotal > 0 ? splitExactly(otherTotal, cods.some((c) => c > 0) ? cods : cods.map(() => 1)) : cods.map(() => 0);
  return items.map((item, i) => ({
    ...item,
    codFeePaisa: fees[i],
    deliveryChargePaisa: delivery[i],
    otherPaisa: others[i],
    netPaisa: item.codPaisa - fees[i] - delivery[i] - others[i],
    feeEstimated: true,
  }));
}

/** The COD we expected Steadfast to collect: what the parcel was booked
 *  with, else the shared Batch 32 rule. */
export function expectedCodPaisa(order: OrderForMatch): number {
  if (order.steadfast_cod_amount !== null && order.steadfast_cod_amount !== undefined) {
    return toPaisa(order.steadfast_cod_amount);
  }
  const mode = order.collect_mode === 'pay_later' ? 'pay_later' : 'cod';
  return toPaisa(courierCod(order.total, order.paid_before_courier, mode));
}

export interface MatchedItem extends PayoutItem {
  itemKey: string;
  orderId: string | null;
  orderNumber: string | null;
  expectedCodPaisa: number | null;
  status: MatchStatus;
  reason: MatchReason | null;
}

/**
 * Invoice → our order (the order number is the invoice we booked with);
 * the consignment id is the fallback. `paidElsewhere` = orders already in a
 * different payout.
 */
export function matchItems(
  items: readonly PayoutItem[],
  orders: readonly OrderForMatch[],
  paidElsewhere: ReadonlySet<string>
): MatchedItem[] {
  const byNumber = new Map(orders.map((o) => [o.order_number.toUpperCase(), o]));
  const byCid = new Map(
    orders.filter((o) => o.steadfast_consignment_id).map((o) => [String(o.steadfast_consignment_id), o])
  );
  const seenOrders = new Set<string>();
  const seenKeys = new Map<string, number>();
  return items.map((item) => {
    const baseKey = item.consignmentId ? `c:${item.consignmentId}` : `i:${(item.invoice ?? '').toUpperCase()}`;
    const repeat = seenKeys.get(baseKey) ?? 0;
    seenKeys.set(baseKey, repeat + 1);
    const itemKey = repeat === 0 ? baseKey : `${baseKey}#${repeat + 1}`;
    const order =
      (item.invoice ? byNumber.get(item.invoice.toUpperCase()) : undefined) ??
      (item.consignmentId ? byCid.get(item.consignmentId) : undefined) ??
      null;
    if (!order) {
      return { ...item, itemKey, orderId: null, orderNumber: null, expectedCodPaisa: null, status: 'to_check', reason: 'order_not_found' };
    }
    const expected = expectedCodPaisa(order);
    const base = { ...item, itemKey, orderId: order.id, orderNumber: order.order_number, expectedCodPaisa: expected };
    if (paidElsewhere.has(order.id) || seenOrders.has(order.id)) {
      return { ...base, status: 'to_check', reason: 'duplicate' };
    }
    seenOrders.add(order.id);
    if (order.status === 'cancelled') return { ...base, status: 'to_check', reason: 'order_cancelled' };
    if (expected !== item.codPaisa) return { ...base, status: 'to_check', reason: 'cod_differs' };
    return { ...base, status: 'matched', reason: null };
  });
}

/* ---------------- Totals ---------------- */

export interface MoneyTotals {
  codPaisa: number;
  deliveryChargePaisa: number;
  codFeePaisa: number;
  otherPaisa: number;
  netPaisa: number;
}

export function sumItems(items: readonly MoneyTotals[]): MoneyTotals {
  return items.reduce<MoneyTotals>(
    (t, i) => ({
      codPaisa: t.codPaisa + i.codPaisa,
      deliveryChargePaisa: t.deliveryChargePaisa + i.deliveryChargePaisa,
      codFeePaisa: t.codFeePaisa + i.codFeePaisa,
      otherPaisa: t.otherPaisa + i.otherPaisa,
      netPaisa: t.netPaisa + i.netPaisa,
    }),
    { codPaisa: 0, deliveryChargePaisa: 0, codFeePaisa: 0, otherPaisa: 0, netPaisa: 0 }
  );
}

/* ---------------- The sync ---------------- */

export interface FetchAnswer {
  ok: boolean;
  status: number;
  body: unknown;
}

/** READ-ONLY GET against Steadfast, path relative to the API base. */
export type SteadfastGet = (path: string) => Promise<FetchAnswer>;

export interface StoredPayout {
  id: string;
  itemsSynced: boolean;
  hasToCheck: boolean;
}

export interface PayoutRow {
  steadfast_payment_id: string;
  paid_at: string | null;
  total_amount: number;
  parcel_count: number;
  steadfast_status: string | null;
  raw: Json;
  items_synced: boolean;
  last_synced_at: string;
}

export interface PayoutItemRow {
  payout_id: string;
  item_key: string;
  consignment_id: string | null;
  invoice: string | null;
  order_id: string | null;
  cod_collected: number;
  delivery_charge: number;
  cod_fee: number;
  other_deduction: number;
  net_paid: number;
  expected_cod: number | null;
  fee_estimated: boolean;
  match_status: MatchStatus;
  match_reason: MatchReason | null;
  note: string | null;
  raw: Json;
}

export interface CourierCostRow {
  order_id: string;
  courier: 'steadfast';
  delivery_charge: number;
  cod_fee: number;
  other_deduction: number;
  total_kept: number;
  cod_collected: number;
  net_received: number;
  payout_id: string;
  paid_at: string | null;
  updated_at: string;
}

/** Where the sync keeps things. The Supabase version writes with the
 *  service role; the tests use an in-memory one. */
export interface PayoutStore {
  storedPayouts(paymentIds: string[]): Promise<Map<string, StoredPayout>>;
  /** Insert or update by steadfast_payment_id; returns our row id. */
  upsertPayout(row: PayoutRow): Promise<string>;
  /** Marks an already complete payout as seen again (nothing else changes). */
  touchPayout(paymentId: string, at: string): Promise<void>;
  findOrders(invoices: string[], consignmentIds: string[]): Promise<OrderForMatch[]>;
  /** Order ids already in a payout other than `payoutId`. */
  ordersInOtherPayouts(orderIds: string[], payoutId: string): Promise<Set<string>>;
  /** Insert or update by (payout_id, item_key). */
  upsertItems(rows: PayoutItemRow[]): Promise<void>;
  upsertCourierCosts(rows: CourierCostRow[]): Promise<void>;
  saveBalance(balance: number | null, error: string | null, at: string): Promise<void>;
}

export interface SyncResult {
  ok: boolean;
  balance: number | null;
  payoutsSeen: number;
  payoutsNew: number;
  detailsFetched: number;
  itemsSaved: number;
  toCheck: number;
  error: string | null;
}

/** How many list pages the first run may walk back through. */
export const MAX_PAYMENT_PAGES = 60;

/** ৳3,799.00 */
function moneyText(paisa: number): string {
  return `৳${fromPaisa(paisa).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function payoutItemRow(payoutId: string, m: MatchedItem): PayoutItemRow {
  return {
    payout_id: payoutId,
    item_key: m.itemKey,
    consignment_id: m.consignmentId,
    invoice: m.invoice,
    order_id: m.orderId,
    cod_collected: fromPaisa(m.codPaisa),
    delivery_charge: fromPaisa(m.deliveryChargePaisa),
    cod_fee: fromPaisa(m.codFeePaisa),
    other_deduction: fromPaisa(m.otherPaisa),
    net_paid: fromPaisa(m.netPaisa),
    expected_cod: m.expectedCodPaisa === null ? null : fromPaisa(m.expectedCodPaisa),
    fee_estimated: m.feeEstimated,
    match_status: m.status,
    match_reason: m.reason,
    note: m.reason === 'cod_differs' && m.expectedCodPaisa !== null
      ? `Expected ${moneyText(m.expectedCodPaisa)}, Steadfast collected ${moneyText(m.codPaisa)}`
      : m.reason
        ? MATCH_REASON_TEXT[m.reason]
        : null,
    raw: m.raw,
  };
}

/** Per-order courier cost (what the profit batch will read). Duplicates
 *  are left out so an order is never costed twice. */
export function courierCostRow(payoutId: string, paidAt: string | null, m: MatchedItem, now: string): CourierCostRow | null {
  if (!m.orderId || m.reason === 'duplicate') return null;
  const kept = m.deliveryChargePaisa + m.codFeePaisa + m.otherPaisa;
  return {
    order_id: m.orderId,
    courier: 'steadfast',
    delivery_charge: fromPaisa(m.deliveryChargePaisa),
    cod_fee: fromPaisa(m.codFeePaisa),
    other_deduction: fromPaisa(m.otherPaisa),
    total_kept: fromPaisa(kept),
    cod_collected: fromPaisa(m.codPaisa),
    net_received: fromPaisa(m.netPaisa),
    payout_id: payoutId,
    paid_at: paidAt,
    updated_at: now,
  };
}

/**
 * Balance, then every payout page (newest first) until a page brings
 * nothing new, then the parcels of each payout that is new, was never read
 * in full, or still has something to check. Running it twice stores
 * everything once.
 */
export async function syncSteadfastPayouts(
  get: SteadfastGet,
  store: PayoutStore,
  now: () => Date = () => new Date()
): Promise<SyncResult> {
  const result: SyncResult = {
    ok: true,
    balance: null,
    payoutsSeen: 0,
    payoutsNew: 0,
    detailsFetched: 0,
    itemsSaved: 0,
    toCheck: 0,
    error: null,
  };

  const balanceAnswer = await get('/get_balance');
  result.balance = balanceAnswer.ok ? parseBalance(balanceAnswer.body) : null;
  const balanceError = result.balance === null ? `Balance not read (HTTP ${balanceAnswer.status})` : null;

  const all: PayoutSummary[] = [];
  for (let page = 1; page <= MAX_PAYMENT_PAGES; page += 1) {
    const answer = await get(page === 1 ? '/payments' : `/payments?page=${page}`);
    if (!answer.ok) {
      if (page === 1) {
        result.ok = false;
        result.error = `Steadfast did not send the payouts (HTTP ${answer.status}).`;
      }
      break;
    }
    const { payouts, hasMore, paged } = parsePaymentsList(answer.body, page);
    const fresh = payouts.filter((p) => !all.some((a) => a.paymentId === p.paymentId));
    all.push(...fresh);
    // Steadfast's real list comes oldest first, a page at a time, without
    // saying how many pages there are: keep asking until a page brings
    // nothing new (an API that ignores ?page= repeats page 1 → stop).
    if (fresh.length === 0 || (paged && !hasMore)) break;
  }
  result.payoutsSeen = all.length;

  const stored = await store.storedPayouts(all.map((p) => p.paymentId));
  for (const summary of all) {
    const before = stored.get(summary.paymentId);
    const stamp = now().toISOString();
    if (!before) result.payoutsNew += 1;
    const needDetail = !before || !before.itemsSynced || before.hasToCheck;
    if (!needDetail) {
      await store.touchPayout(summary.paymentId, stamp);
      continue;
    }

    const detail = await get(`/payments/${encodeURIComponent(summary.paymentId)}`);
    result.detailsFetched += 1;
    if (!detail.ok) {
      if (before) await store.touchPayout(summary.paymentId, stamp);
      else await store.upsertPayout(baseRow(summary, false, stamp, null));
      continue;
    }
    const { summary: more, items } = parsePaymentDetail(detail.body);
    const merged: PayoutSummary = {
      ...summary,
      paidAt: summary.paidAt ?? more.paidAt ?? null,
      amountPaisa: summary.amountPaisa || more.amountPaisa || 0,
      parcelCount: summary.parcelCount ?? more.parcelCount ?? null,
      codTotalPaisa: summary.codTotalPaisa ?? more.codTotalPaisa ?? null,
      feeTotalPaisa: summary.feeTotalPaisa ?? more.feeTotalPaisa ?? null,
      deliveryTotalPaisa: summary.deliveryTotalPaisa ?? more.deliveryTotalPaisa ?? null,
    };
    const payoutId = await store.upsertPayout(baseRow(merged, true, stamp, items.length));

    const orders = await store.findOrders(
      items.map((i) => i.invoice).filter((v): v is string => v !== null),
      items.map((i) => i.consignmentId).filter((v): v is string => v !== null)
    );
    const elsewhere = await store.ordersInOtherPayouts(orders.map((o) => o.id), payoutId);
    const weights = items.map((i) => {
      const o = orders.find(
        (x) =>
          (i.invoice !== null && x.order_number.toUpperCase() === i.invoice.toUpperCase()) ||
          (i.consignmentId !== null && x.steadfast_consignment_id === i.consignmentId)
      );
      return o?.delivery_fee ?? null;
    });
    const matched = matchItems(allocatePayoutTotals(items, merged, weights), orders, elsewhere);
    await store.upsertItems(matched.map((m) => payoutItemRow(payoutId, m)));
    const costs = matched
      .map((m) => courierCostRow(payoutId, merged.paidAt, m, stamp))
      .filter((r): r is CourierCostRow => r !== null);
    if (costs.length > 0) await store.upsertCourierCosts(costs);
    result.itemsSaved += matched.length;
    result.toCheck += matched.filter((m) => m.status === 'to_check').length;
  }

  await store.saveBalance(result.balance, result.error ?? balanceError, now().toISOString());
  return result;
}

function baseRow(s: PayoutSummary, itemsSynced: boolean, stamp: string, itemCount: number | null): PayoutRow {
  return {
    steadfast_payment_id: s.paymentId,
    paid_at: s.paidAt,
    total_amount: fromPaisa(s.amountPaisa),
    parcel_count: s.parcelCount ?? itemCount ?? 0,
    steadfast_status: s.steadfastStatus,
    raw: s.raw,
    items_synced: itemsSynced,
    last_synced_at: stamp,
  };
}
