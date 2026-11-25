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
  /** Batch 53: "paid_bills" — delivery bills of parcels in this payout that
   *  were paid some other way, so they are NOT taken out of this payout
   *  (total = amount − charges − due_bills, checked on every stored payout). */
  paidBillsPaisa: number | null;
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
    paidBillsPaisa: optionalPaisa(obj, 'paid_bills'),
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
  /** Batch 53: this parcel's delivery bill when it was paid outside this
   *  payout (its share of "paid_bills"). A real cost of the order, but not
   *  taken out of this payout, so it is not in netPaisa. */
  paidSeparatelyPaisa: number;
  /** True when the COD fee was not in the answer and was worked out as 1%. */
  feeEstimated: boolean;
  /** Steadfast gave this parcel's own delivery charge. */
  chargeGiven: boolean;
  /** Batch 46: Steadfast returned / cancelled this parcel — nothing was
   *  collected, whatever COD it was booked with; only its charge is kept. */
  notDelivered: boolean;
  raw: Json;
}

/** Steadfast's parcel status for a parcel that went back to the shop
 *  ("cancelled", "returned"). "partial_delivered" is not one: part was paid. */
export function parcelNotDelivered(status: unknown): boolean {
  const s = typeof status === 'string' ? status.trim().toLowerCase() : '';
  return /cancel/.test(s) || /^return(ed)?$/.test(s);
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
  // Batch 46: `cod_amount` is what the parcel was BOOKED with. On a parcel
  // Steadfast returned, nothing was collected (the payout's own "amount"
  // leaves it out), so it collected ৳0.
  const notDelivered = parcelNotDelivered(obj.status);
  const codPaisa = notDelivered ? 0 : toPaisa(pick(obj, COD_KEYS));
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
    paidSeparatelyPaisa: 0,
    feeEstimated: !feeGiven,
    chargeGiven: hasAny(obj, CHARGE_KEYS),
    notDelivered,
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
  /** Batch 53: 'inside_dhaka' / 'outside_dhaka' / 'hand_delivered'. */
  delivery_zone?: string | null;
  /** The order's "COD via Steadfast" payment row, if any (Batch 46). */
  steadfast_cod_paid?: number;
  /** Batch 65: a returned order's delivery charge the customer paid on
   *  return (the rider collected it, so it comes in this payout). */
  return_delivery_paid?: number | null;
}

/** Batch 65: what a returned order's parcel should have collected, when
 *  the customer paid the delivery charge; null = the older rules apply. */
export function returnPaidPaisa(order: OrderForMatch): number | null {
  if (order.status !== 'returned') return null;
  const paid = toPaisa(order.return_delivery_paid ?? 0);
  return paid > 0 ? paid : null;
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

/** Batch 53: the delivery fees in Settings, used only as the weight of
 *  each zone when a payout's bills are shared (never as a price). */
export interface ZoneFees {
  inside: number;
  outside: number;
}

export const DEFAULT_ZONE_FEES: ZoneFees = { inside: 70, outside: 130 };

/** The split weight of one parcel: its order's zone fee from Settings
 *  (every parcel of one zone weighs the same); without a zone, the order's
 *  own delivery fee; otherwise null (the average of the others is used). */
export function zoneWeight(
  order: Pick<OrderForMatch, 'delivery_zone' | 'delivery_fee'> | null | undefined,
  fees: ZoneFees
): number | null {
  if (!order) return null;
  if (order.delivery_zone === 'inside_dhaka' && fees.inside > 0) return fees.inside;
  if (order.delivery_zone === 'outside_dhaka' && fees.outside > 0) return fees.outside;
  return order.delivery_fee !== null && order.delivery_fee !== undefined && order.delivery_fee > 0 ? order.delivery_fee : null;
}

/**
 * Batch 53: which parcels' bills were "paid_bills" (paid outside this
 * payout) and which were "due_bills" (taken out of it). Steadfast gives
 * only the two totals. Parcels of the same weight are interchangeable, so
 * only how many of each weight sit on the "paid" side matters: every count
 * is tried and the one whose weight share is closest to
 * paid ÷ (due + paid) wins. Ties: more parcels with nothing to collect on
 * the "paid" side (their bill cannot come out of their own cash), then
 * fewer parcels on the "paid" side. Inside a weight, parcels with nothing
 * to collect go to the "paid" side first, then the earliest.
 */
export function paidSeparatelySide(
  codsPaisa: readonly number[],
  weights: readonly number[],
  duePaisa: number,
  paidPaisa: number
): boolean[] {
  const n = weights.length;
  if (n === 0) return [];
  if (paidPaisa <= 0) return weights.map(() => false);
  if (duePaisa <= 0) return weights.map(() => true);
  // One parcel holds both kinds of bill: it stays on the "due" side and
  // carries the paid bills too (see allocatePayoutTotals).
  if (n === 1) return [false];
  const groups = new Map<number, number[]>();
  weights.forEach((w, i) => groups.set(w, [...(groups.get(w) ?? []), i]));
  const keys = [...groups.keys()];
  // Inside a weight: nothing-to-collect parcels first, then by position.
  const ordered = keys.map((k) =>
    [...(groups.get(k) ?? [])].sort((a, b) => Number(codsPaisa[a] > 0) - Number(codsPaisa[b] > 0) || a - b)
  );
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const target = paidPaisa / (duePaisa + paidPaisa);
  let bestCounts: number[] | null = null;
  let bestScore = 0;
  let bestZeroCod = 0;
  let bestSize = 0;
  const counts = keys.map(() => 0);
  const visit = (g: number): void => {
    if (g === keys.length) {
      const size = counts.reduce((a, b) => a + b, 0);
      if (size === 0 || size === n) return;
      const paidWeight = counts.reduce((sum, c, k) => sum + c * keys[k], 0);
      const score = Math.abs(paidWeight / totalWeight - target);
      const zeroCod = counts.reduce((sum, c, k) => sum + ordered[k].slice(0, c).filter((i) => codsPaisa[i] <= 0).length, 0);
      const tie = bestCounts !== null && Math.abs(score - bestScore) <= 1e-9;
      const better =
        bestCounts === null ||
        (!tie && score < bestScore) ||
        (tie && (zeroCod > bestZeroCod || (zeroCod === bestZeroCod && size < bestSize)));
      if (better) {
        bestCounts = [...counts];
        bestScore = score;
        bestZeroCod = zeroCod;
        bestSize = size;
      }
      return;
    }
    for (let c = 0; c <= ordered[g].length; c += 1) {
      counts[g] = c;
      visit(g + 1);
    }
    counts[g] = 0;
  };
  visit(0);
  const side = weights.map(() => false);
  const chosen: number[] = bestCounts ?? keys.map(() => 0);
  chosen.forEach((c, k) => {
    for (const i of ordered[k].slice(0, c)) side[i] = true;
  });
  return side;
}

/**
 * Steadfast's real payout answer gives the COD fee ("charges"), the
 * delivery bills taken from this payout ("due_bills") and the bills paid
 * some other way ("paid_bills") only as payout totals, not per parcel.
 * They are split here so every payout still adds up to the paisa:
 *   - the COD fee by each parcel's COD;
 *   - Batch 53: the parcels are first put on the "due" or "paid" side
 *     (paidSeparatelySide), then due_bills is shared over the "due" side
 *     and paid_bills over the "paid" side, both by zone weight. A "paid"
 *     bill is a cost of its order but not taken from this payout, so the
 *     parcels' nets still add up to exactly what Steadfast paid.
 * Anything else Steadfast kept (paid − (COD − fee − delivery)) becomes
 * "other", split by COD. The per-order amounts are marked as estimates.
 */
export function allocatePayoutTotals<T extends PayoutItem>(
  items: readonly T[],
  summary: Pick<PayoutSummary, 'amountPaisa' | 'feeTotalPaisa' | 'deliveryTotalPaisa'> & { paidBillsPaisa?: number | null },
  deliveryWeights: readonly (number | null)[]
): T[] {
  if (items.length === 0 || items.some((i) => i.chargeGiven)) return [...items];
  if (summary.feeTotalPaisa === null && summary.deliveryTotalPaisa === null) return [...items];
  const cods = items.map((i) => i.codPaisa);
  const fees = summary.feeTotalPaisa === null ? items.map((i) => i.codFeePaisa) : splitExactly(summary.feeTotalPaisa, cods);
  const known = deliveryWeights.filter((w): w is number => w !== null && w > 0);
  const fallback = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const weights = deliveryWeights.map((w) => (w !== null && w > 0 ? w : fallback));
  const duePaisa = summary.deliveryTotalPaisa ?? 0;
  const paidPaisa = Math.max(0, summary.paidBillsPaisa ?? 0);
  const paidSide = paidSeparatelySide(cods, weights, duePaisa, paidPaisa);
  const share = (total: number, onPaidSide: boolean): number[] => {
    const idx = weights.map((_, i) => i).filter((i) => paidSide[i] === onPaidSide);
    const parts = splitExactly(total, idx.map((i) => weights[i]));
    const out = weights.map(() => 0);
    idx.forEach((i, k) => {
      out[i] = parts[k];
    });
    return out;
  };
  const delivery = share(duePaisa, false);
  // One parcel with both kinds of bill carries the paid bills itself.
  const separately = items.length === 1 ? [paidPaisa] : share(paidPaisa, true);
  const codSum = cods.reduce((a, b) => a + b, 0);
  const feeSum = fees.reduce((a, b) => a + b, 0);
  const deliverySum = delivery.reduce((a, b) => a + b, 0);
  // Batch 46: never clamped — if Steadfast paid MORE than COD − fee −
  // delivery (a credit), "other" is negative, so the parcels still add up
  // to exactly what was paid.
  const otherTotal = codSum - feeSum - deliverySum - summary.amountPaisa;
  const others = otherTotal !== 0 ? splitExactly(otherTotal, cods.some((c) => c > 0) ? cods : cods.map(() => 1)) : cods.map(() => 0);
  return items.map((item, i) => ({
    ...item,
    codFeePaisa: fees[i],
    deliveryChargePaisa: delivery[i],
    otherPaisa: others[i],
    netPaisa: item.codPaisa - fees[i] - delivery[i] - others[i],
    paidSeparatelyPaisa: separately[i],
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
    // Batch 65: the customer paid the delivery charge when the parcel came
    // back; matched when Steadfast collected exactly that.
    const paidOnReturn = returnPaidPaisa(order);
    if (paidOnReturn !== null) {
      return item.codPaisa === paidOnReturn
        ? { ...base, expectedCodPaisa: paidOnReturn, status: 'matched', reason: null }
        : { ...base, expectedCodPaisa: paidOnReturn, status: 'to_check', reason: 'cod_differs' };
    }
    // Batch 46: a parcel Steadfast returned collected nothing, so nothing is
    // expected — whatever the order became here (returned, cancelled, or
    // delivered by hand). It only needs checking when the order still
    // records cash "collected by Steadfast".
    if (item.notDelivered) {
      const recorded = toPaisa(order.steadfast_cod_paid ?? 0);
      return recorded > 0
        ? { ...base, expectedCodPaisa: recorded, status: 'to_check', reason: 'cod_differs' }
        : { ...base, expectedCodPaisa: 0, status: 'matched', reason: null };
    }
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
  /** Batch 64: the status saved last time ("processing", "paid"...). */
  steadfastStatus: string | null;
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
  /** Batch 53: this parcel's share of "paid_bills" (not in net_paid). */
  bill_paid_separately: number;
  /** Batch 53: which split wrote the money columns (see migration-054). */
  split_rule: string;
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
  /** Batch 53: the order's bill paid outside the payout (in total_kept,
   *  not in net_received). */
  bill_paid_separately: number;
  total_kept: number;
  cod_collected: number;
  net_received: number;
  payout_id: string;
  paid_at: string | null;
  updated_at: string;
  split_rule: string;
}

/** Where the sync keeps things. The Supabase version writes with the
 *  service role; the tests use an in-memory one. */
export interface PayoutStore {
  storedPayouts(paymentIds: string[]): Promise<Map<string, StoredPayout>>;
  /** Insert or update by steadfast_payment_id; returns our row id. */
  upsertPayout(row: PayoutRow): Promise<string>;
  /** Marks an already complete payout as seen again. Batch 64: given a
   *  status, it also saves the status from Steadfast's list (a payout first
   *  read as "processing" that is "paid" now); nothing else changes. */
  touchPayout(paymentId: string, at: string, steadfastStatus?: string): Promise<void>;
  findOrders(invoices: string[], consignmentIds: string[]): Promise<OrderForMatch[]>;
  /** Batch 53: the zone delivery fees in Settings (split weights only). */
  zoneFees?(): Promise<ZoneFees>;
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

/** Batch 53: written on every payout line and courier row by this code.
 *  migration-054 marks the rows it recalculated 'b53-backfill'; a database
 *  guard keeps those numbers when an older copy of this code (which does
 *  not send split_rule) reads the payout again before the deploy. */
export const SPLIT_RULE = 'b53';

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
    bill_paid_separately: fromPaisa(m.paidSeparatelyPaisa),
    split_rule: SPLIT_RULE,
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
  // Batch 53: a bill paid outside the payout is still this order's cost.
  const kept = m.deliveryChargePaisa + m.codFeePaisa + m.otherPaisa + m.paidSeparatelyPaisa;
  return {
    order_id: m.orderId,
    courier: 'steadfast',
    delivery_charge: fromPaisa(m.deliveryChargePaisa),
    cod_fee: fromPaisa(m.codFeePaisa),
    other_deduction: fromPaisa(m.otherPaisa),
    bill_paid_separately: fromPaisa(m.paidSeparatelyPaisa),
    total_kept: fromPaisa(kept),
    cod_collected: fromPaisa(m.codPaisa),
    net_received: fromPaisa(m.netPaisa),
    payout_id: payoutId,
    paid_at: paidAt,
    updated_at: now,
    split_rule: SPLIT_RULE,
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
      const status = summary.steadfastStatus;
      await store.touchPayout(summary.paymentId, stamp, status !== null && status !== before.steadfastStatus ? status : undefined);
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
      paidBillsPaisa: summary.paidBillsPaisa ?? more.paidBillsPaisa ?? null,
    };
    // Batch 62: done only once its parcel lines came back (or Steadfast says
    // it is final and truly has none). A payout still "processing" with no
    // lines yet is asked again on the next sync.
    const payoutId = await store.upsertPayout(baseRow(merged, payoutLinesDone(merged, items.length), stamp, items.length));

    const orders = await store.findOrders(
      items.map((i) => i.invoice).filter((v): v is string => v !== null),
      items.map((i) => i.consignmentId).filter((v): v is string => v !== null)
    );
    const elsewhere = await store.ordersInOtherPayouts(orders.map((o) => o.id), payoutId);
    const fees = store.zoneFees ? await store.zoneFees() : DEFAULT_ZONE_FEES;
    const weights = items.map((i) => {
      const o = orders.find(
        (x) =>
          (i.invoice !== null && x.order_number.toUpperCase() === i.invoice.toUpperCase()) ||
          (i.consignmentId !== null && x.steadfast_consignment_id === i.consignmentId)
      );
      return zoneWeight(o, fees);
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

/** Batch 62: a payout counts as synced only when its parcel lines came
 *  back, or Steadfast's status is final and it has no parcels at all. */
export function payoutLinesDone(s: Pick<PayoutSummary, 'steadfastStatus' | 'parcelCount'>, itemCount: number): boolean {
  if (itemCount > 0) return true;
  const status = (s.steadfastStatus ?? '').trim().toLowerCase();
  const final = ['paid', 'completed', 'complete', 'done', 'success', 'successful'].includes(status);
  return final && (s.parcelCount ?? 0) === 0;
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
