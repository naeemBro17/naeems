import type { AppSettings } from '../types';
import { maxQuantity, stockLimit, type Buyer, type StockFacts } from './buyRule';

export { maxQuantity, type Buyer, type StockFacts };

/**
 * Batch 51: keep selling when out of stock, the order limit, and the
 * delivery times. Every rule the shop's screens follow lives here (the
 * database enforces the same limit and stock rules in place_order).
 */

/** The four settings this batch adds (Admin → Settings). */
export type SellSettings = Pick<
  AppSettings,
  'order_limit_per_item' | 'delivery_time_dhaka' | 'delivery_time_outside' | 'delivery_time_buy_after'
>;

export const DEFAULT_ORDER_LIMIT = 4;
export const DEFAULT_DELIVERY_DHAKA = '1 to 2 days';
export const DEFAULT_DELIVERY_OUTSIDE = '2 to 3 days';
export const DEFAULT_DELIVERY_BUY_AFTER = '3 to 5 days';

/** "Most of one item per order" (at least 1; 4 when blank or not a number). */
export function orderLimit(settings: Pick<SellSettings, 'order_limit_per_item'>): number {
  const n = Number.parseInt(String(settings.order_limit_per_item ?? '').replace(/\D/g, ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_ORDER_LIMIT;
}

/** Why + stopped: the order limit, or the last of the stock. */
export type LimitReason = { kind: 'limit'; limit: number } | { kind: 'stock'; left: number };

export function limitReason(facts: StockFacts, limit: number): LimitReason {
  if (!facts.keepSelling) {
    const left = stockLimit(facts.stock);
    if (left < limit) return { kind: 'stock', left };
  }
  return { kind: 'limit', limit };
}

/** The popup's main line (Naeem's approved words). */
export function limitTitle(reason: LimitReason): string {
  if (reason.kind === 'limit') return `Limit ${reason.limit} per order`;
  return reason.left === 1 ? "You've got the last one!" : `You've got the last ${reason.left}!`;
}

/** "Hi! I'd like more than 4 of {product name} {option}." */
export function moreThanLimitMessage(limit: number, productName: string, optionLabel: string | null): string {
  const item = [productName.trim(), (optionLabel ?? '').trim()].filter(Boolean).join(' ');
  return `Hi! I'd like more than ${limit} of ${item}.`;
}

/** "Only {n} left — order soon": a sells-only-from-stock option with 1 to
 *  the limit left. Null otherwise (never for keep-selling products). */
export function lowStockText(facts: StockFacts, limit: number): string | null {
  if (facts.keepSelling || facts.stock === null) return null;
  const left = Math.floor(facts.stock);
  if (left < 1 || left > limit) return null;
  return `Only ${left} left, order soon`;
}

/** Customer-facing stock status of one option. */
export type ShopStock = 'in' | 'low' | 'out';

export function shopStock(facts: StockFacts, available: boolean, limit: number): ShopStock {
  if (!available) return 'out';
  return lowStockText(facts, limit) ? 'low' : 'in';
}

/** Batch 64: a range typed with a dash ("1–2 days", saved in Settings)
 *  reads "1 to 2 days" in the shop. */
export function rangeWithTo(text: string): string {
  return text.replace(/\s*[–—]\s*/g, ' to ');
}

function deliveryText(value: string | undefined, fallback: string): string {
  const text = (value ?? '').trim();
  return text === '' ? fallback : rangeWithTo(text);
}

export function deliveryTimes(settings: Partial<SellSettings>): { dhaka: string; outside: string; buyAfter: string } {
  return {
    dhaka: deliveryText(settings.delivery_time_dhaka, DEFAULT_DELIVERY_DHAKA),
    outside: deliveryText(settings.delivery_time_outside, DEFAULT_DELIVERY_OUTSIDE),
    buyAfter: deliveryText(settings.delivery_time_buy_after, DEFAULT_DELIVERY_BUY_AFTER),
  };
}

/**
 * The product page's delivery line for the selected option:
 * in stock → "Get it in 1–2 days in Dhaka · 2–3 days outside Dhaka";
 * keep selling with none in stock → "Get it in 3–5 days"; sold out → none.
 */
export function deliveryLine(settings: Partial<SellSettings>, option: { available: boolean; inHand: boolean }): string | null {
  if (!option.available) return null;
  const t = deliveryTimes(settings);
  if (option.inHand) return `Get it in ${t.dhaka} in Dhaka · ${t.outside} outside Dhaka`;
  return `Get it in ${t.buyAfter}`;
}

/** The cart's note under a line stock does not fully cover. */
export function cartBuyAfterNote(settings: Partial<SellSettings>): string {
  return `Get it in ${deliveryTimes(settings).buyAfter}`;
}

/** "1–2 days" → [1, 2]; "3 days" → [3, 3]; nothing usable → null. */
export function parseDays(text: string): [number, number] | null {
  const nums = (text.match(/\d+/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  const from = nums[0];
  const to = nums.length > 1 ? nums[1] : nums[0];
  return from <= to ? [from, to] : [to, from];
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/** The Dhaka calendar date of an instant, as a UTC-midnight Date. */
function dhakaDate(iso: string): Date {
  const shifted = new Date(new Date(iso).getTime() + DHAKA_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function dayLabel(date: Date): string {
  return `${DAY_NAMES[date.getUTCDay()]}, ${date.getUTCDate()}`;
}

/**
 * The Order Placed page's "Arriving Fri, 20 – Sat, 21 Nov": calendar days
 * from the order date (Dhaka time); Dhaka or outside Dhaka from the order's
 * delivery zone, and the slowest item (anything bought after the order uses
 * "Items we buy after the order"). Null when the setting has no number.
 */
export function arrivalText(
  placedAt: string,
  zone: string,
  buysLater: boolean,
  settings: Partial<SellSettings>
): string | null {
  const t = deliveryTimes(settings);
  const days = parseDays(buysLater ? t.buyAfter : zone === 'inside_dhaka' ? t.dhaka : t.outside);
  if (!days) return null;
  const start = dhakaDate(placedAt);
  const from = addDays(start, days[0]);
  const to = addDays(start, days[1]);
  if (from.getTime() === to.getTime()) return `Arriving ${dayLabel(from)} ${MONTH_NAMES[from.getUTCMonth()]}`;
  if (from.getUTCMonth() === to.getUTCMonth()) {
    return `Arriving ${dayLabel(from)} to ${dayLabel(to)} ${MONTH_NAMES[to.getUTCMonth()]}`;
  }
  return `Arriving ${dayLabel(from)} ${MONTH_NAMES[from.getUTCMonth()]} to ${dayLabel(to)} ${MONTH_NAMES[to.getUTCMonth()]}`;
}

/** One day chip on the Order Placed page: "FRI", 28, "Nov". */
export interface ArrivalDay {
  weekday: string;
  day: number;
  month: string;
}

/** The same days as arrivalText, as chips. `to` is null when it is one day. */
export interface ArrivalRange {
  from: ArrivalDay;
  to: ArrivalDay | null;
}

export function arrivalRange(
  placedAt: string,
  zone: string,
  buysLater: boolean,
  settings: Partial<SellSettings>
): ArrivalRange | null {
  const t = deliveryTimes(settings);
  const days = parseDays(buysLater ? t.buyAfter : zone === 'inside_dhaka' ? t.dhaka : t.outside);
  if (!days) return null;
  const start = dhakaDate(placedAt);
  const from = addDays(start, days[0]);
  const to = addDays(start, days[1]);
  const chip = (date: Date): ArrivalDay => ({
    weekday: DAY_NAMES[date.getUTCDay()].toUpperCase(),
    day: date.getUTCDate(),
    month: MONTH_NAMES[date.getUTCMonth()],
  });
  return { from: chip(from), to: from.getTime() === to.getTime() ? null : chip(to) };
}

/**
 * Fix 72.1: the product page's "Arrives by <day>": the LAST day of the same
 * range the Order Placed page shows, for the slower zone (outside Dhaka)
 * when it is in hand, else the buy-after time, so the promise holds
 * wherever the customer lives. "Wed, 2 Dec". Null when not for sale or the
 * delivery times cannot be read.
 */
export function arrivesByDay(
  settings: Partial<SellSettings>,
  option: { available: boolean; inHand: boolean },
  nowIso: string
): string | null {
  if (!option.available) return null;
  const range = arrivalRange(nowIso, 'outside_dhaka', !option.inHand, settings);
  if (!range) return null;
  const last = range.to ?? range.from;
  const weekday = last.weekday.charAt(0) + last.weekday.slice(1).toLowerCase();
  return `${weekday}, ${last.day} ${last.month}`;
}
