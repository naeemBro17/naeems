/* Batch 43 Part 1: "Give an offer" — which lot rows will not sell before
   they expire, and a discount that never goes below the landed cost.
   Plain rules on the shop's own numbers; every row says why. */
import type { OfferRow } from './types';
import { expiryText, isExpired, monthsText, monthsToExpiry, salesSpeed, unitsText } from './speed';

export type OfferStatus = 'offer' | 'watch';

/** Discount ranges, % off the selling price. */
export const OFFER_DISCOUNT: Record<OfferStatus, { min: number; max: number }> = {
  watch: { min: 5, max: 10 },
  offer: { min: 10, max: 20 },
};

export interface OfferSuggestion {
  row: OfferRow;
  status: OfferStatus;
  perMonth: number;
  isNew: boolean;
  /** Months until the units up to this row are sold; null = no sales. */
  monthsToSell: number | null;
  monthsToExpiry: number;
  discount: { min: number; max: number };
  /** Selling price of one pack today. */
  price: number;
  /** The lowest price of one pack that is not below landed cost (rounded up). */
  floor: number;
  /** The suggested price range for one pack, never below the floor. */
  priceLow: number;
  priceHigh: number;
  /** The largest discount that still covers the cost, whole % (0 = none). */
  maxDiscount: number;
  /** The price is already at or below the landed cost. */
  noRoom: boolean;
  reason: string;
}

export interface ExpiredRow {
  row: OfferRow;
  /** Landed cost of the units left (the loss if written off). */
  value: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cost of one pack, rounded UP to whole taka, so a price at the floor is never a loss. */
export function floorPrice(unitCost: number, packSize: number): number {
  return Math.ceil(round2(unitCost * packSize) - 1e-9);
}

/**
 * The rule for one lot row with units left (not yet expired):
 *   months to sell out = (units that sell before it + its units) ÷ speed
 *   months to sell out > months to expiry − 1  → "Give offer"
 *   months to sell out > months to expiry − 2  → "Watch"
 *   otherwise it sells in time (null).
 * No sale at all → "Give offer".
 */
export function offerFor(row: OfferRow, today: string): OfferSuggestion | null {
  if (isExpired(row.expiry_date, today) || row.units <= 0) return null;
  const { perMonth, isNew } = salesSpeed(row.units_90, row.history_days);
  const through = row.units_before + row.units;
  const toExpiry = monthsToExpiry(row.expiry_date, today);
  const toSell = perMonth > 0 ? through / perMonth : null;
  let status: OfferStatus | null;
  if (toSell === null || toSell > toExpiry - 1) status = 'offer';
  else if (toSell > toExpiry - 2) status = 'watch';
  else status = null;
  if (!status) return null;

  const discount = OFFER_DISCOUNT[status];
  const price = round2(row.price);
  const floor = floorPrice(row.unit_cost, row.pack_size);
  const noRoom = price <= floor;
  const priceHigh = noRoom ? price : Math.max(Math.round(price * (1 - discount.min / 100)), floor);
  const priceLow = noRoom ? price : Math.max(Math.round(price * (1 - discount.max / 100)), floor);
  const maxDiscount = noRoom || price <= 0 ? 0 : Math.floor(((price - floor) / price) * 100);

  const left = unitsText(row.units, row.stock_unit);
  const parts = [
    perMonth > 0
      ? `sells ${unitsText(perMonth, row.stock_unit)} a month${isNew ? ' (new — less than 30 days of sales)' : ''}`
      : `no sale in the last 90 days${isNew ? ' (new)' : ''}`,
    `${left} left${row.units_before > 0 ? ` (${unitsText(row.units_before, row.stock_unit)} from earlier-expiring lots sell first)` : ''}`,
    `expires in ${monthsText(toExpiry)} (${expiryText(row.expiry_date)})`,
  ];
  if (toSell !== null) parts.push(`needs about ${monthsText(toSell)} to sell`);
  return {
    row,
    status,
    perMonth,
    isNew,
    monthsToSell: toSell,
    monthsToExpiry: toExpiry,
    discount,
    price,
    floor,
    priceLow,
    priceHigh,
    maxDiscount,
    noRoom,
    reason: parts.join(', '),
  };
}

export interface OfferList {
  offers: OfferSuggestion[];
  expired: ExpiredRow[];
}

/** "Give offer" first, then "Watch"; the soonest expiry first in each. */
export function offerList(rows: readonly OfferRow[], today: string): OfferList {
  const offers: OfferSuggestion[] = [];
  const expired: ExpiredRow[] = [];
  for (const row of rows) {
    if (row.units <= 0) continue;
    if (isExpired(row.expiry_date, today)) {
      expired.push({ row, value: round2(row.units * row.unit_cost) });
      continue;
    }
    const s = offerFor(row, today);
    if (s) offers.push(s);
  }
  offers.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === 'offer' ? -1 : 1) ||
      a.row.expiry_date.localeCompare(b.row.expiry_date) ||
      a.row.label.localeCompare(b.row.label)
  );
  expired.sort((a, b) => a.row.expiry_date.localeCompare(b.row.expiry_date) || a.row.label.localeCompare(b.row.label));
  return { offers, expired };
}
