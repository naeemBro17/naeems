// Shared constants + pure calculation logic for the admin "নতুন অর্ডার" (new
// order) form (Batch 22) — used by NewOrderSheet.tsx for the live on-screen
// summary, and covered by manualOrders.test.ts. The database function
// admin_create_order() (migration-028) is the actual source of truth for a
// saved order's numbers; this module exists so the form can show Naeem the
// same total *before* he saves, without waiting on a round trip.
import type { DiscountReason, Order, OrderSource, OrderPaymentMethod } from '../types';

export interface SourceOption {
  id: OrderSource;
  label: string;
}

/** Display order matches the spec's listing order. 'web' is deliberately
 *  excluded — it's never a choice, only place_order() ever writes it. */
export const MANUAL_ORDER_SOURCES: SourceOption[] = [
  { id: 'facebook', label: 'Facebook' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'phone', label: 'Phone call' },
  { id: 'shop', label: 'Shop/in person' },
  { id: 'family', label: 'Family' },
  { id: 'other', label: 'Other' },
];

/** Plain-language label for any order's source, including 'web' — shared by
 *  the Orders list badge/filter and the invoice. */
export const ORDER_SOURCE_LABELS: Record<OrderSource, string> = {
  web: 'Web',
  facebook: 'FB',
  whatsapp: 'WA',
  phone: 'Phone',
  shop: 'Shop',
  family: 'Family',
  other: 'Other',
};

export interface ReasonOption {
  id: DiscountReason;
  label: string;
}

export const DISCOUNT_REASONS: ReasonOption[] = [
  { id: 'family', label: 'Family' },
  { id: 'gift', label: 'Gift' },
  { id: 'free_sample', label: 'Free sample' },
  { id: 'personal_use', label: 'Personal use' },
  { id: 'promotion', label: 'Promotion' },
  { id: 'other', label: 'Other' },
];

export const DISCOUNT_REASON_LABELS: Record<DiscountReason, string> = {
  family: 'Family',
  gift: 'Gift',
  free_sample: 'Free sample',
  personal_use: 'Personal use',
  promotion: 'Promotion',
  other: 'Other',
};

export interface ManualPaymentOption {
  id: OrderPaymentMethod;
  label: string;
}

/** The four payment choices the manual order form offers — a superset of
 *  what website checkout offers ('cash' and 'due' only ever come from here). */
export const MANUAL_PAYMENT_METHODS: ManualPaymentOption[] = [
  { id: 'cod', label: 'Cash on Delivery' },
  { id: 'bkash', label: 'bKash' },
  { id: 'cash', label: 'Cash paid' },
  { id: 'due', label: 'বাকি (due)' },
];

/** One priced line as the form tracks it, before it becomes a real
 *  order_items row. */
export interface ManualOrderLine {
  listPrice: number;
  soldPrice: number;
  quantity: number;
}

export interface ManualOrderTotals {
  /** Sum of soldPrice × quantity — what the customer is actually charged for items. */
  subtotal: number;
  /** Sum of listPrice × quantity — what the same items would cost at full price. */
  listValue: number;
  /** Sum of listPrice × quantity for lines priced at exactly 0 (marked ফ্রি). */
  freeValue: number;
  /** Value given up on lines that are reduced but not free (listValue - subtotal - freeValue). */
  lineDiscount: number;
  /** The flat order-level discount, clamped to non-negative. */
  orderDiscount: number;
  deliveryFee: number;
  /** subtotal + deliveryFee - orderDiscount, never below 0. */
  total: number;
}

/** The one place both the live form preview and its tests compute an
 *  order's numbers — mirrors admin_create_order()'s own arithmetic
 *  (migration-028) so what Naeem sees while typing matches what gets saved.
 *  The database recomputes everything itself regardless; this is only ever
 *  a preview. */
export function computeManualOrderTotals(
  lines: ManualOrderLine[],
  orderDiscount: number,
  deliveryFee: number
): ManualOrderTotals {
  let subtotal = 0;
  let listValue = 0;
  let freeValue = 0;

  for (const line of lines) {
    const quantity = Math.max(0, line.quantity);
    const soldPrice = Math.max(0, line.soldPrice);
    subtotal += soldPrice * quantity;
    listValue += line.listPrice * quantity;
    if (soldPrice === 0) {
      freeValue += line.listPrice * quantity;
    }
  }

  const clampedDiscount = Math.max(0, orderDiscount);
  const clampedFee = Math.max(0, deliveryFee);
  const lineDiscount = Math.max(0, listValue - subtotal - freeValue);
  const total = Math.max(0, subtotal + clampedFee - clampedDiscount);

  return {
    subtotal,
    listValue,
    freeValue,
    lineDiscount,
    orderDiscount: clampedDiscount,
    deliveryFee: clampedFee,
    total,
  };
}

/** True when a line's own price counts as a discount worth asking a reason
 *  for — used by the form to show the reason chips inline the moment a
 *  price is edited down (or marked ফ্রি). */
export function lineNeedsReason(listPrice: number, soldPrice: number): boolean {
  return soldPrice < listPrice;
}

export interface StockWarning {
  product_name: string;
  variant_label: string | null;
  available: number;
  requested: number;
}

const STOCK_WARNING_PREFIX = 'STOCK_WARNING:';

/** admin_create_order() (migration-028) raises 'STOCK_WARNING:<json array>'
 *  instead of a hard failure when one or more lines exceed tracked stock —
 *  this pulls the structured list back out so the form can show "only N
 *  left, continue anyway?" instead of a raw database error. Returns null
 *  for any other error message. */
export function parseStockWarning(errorMessage: string): StockWarning[] | null {
  if (!errorMessage.startsWith(STOCK_WARNING_PREFIX)) return null;
  try {
    const parsed = JSON.parse(errorMessage.slice(STOCK_WARNING_PREFIX.length));
    if (!Array.isArray(parsed)) return null;
    return parsed as StockWarning[];
  } catch {
    return null;
  }
}

export interface MonthlySummary {
  orderCount: number;
  /** What was actually charged — sum of `total` across the month's orders. */
  totalSales: number;
  /** Order-level flat discounts + reduced-price line discounts. Excludes
   *  the value of fully-free items — that's reported separately as
   *  freeValue, since giving something away free is a different business
   *  fact from cutting its price. */
  totalDiscount: number;
  /** Value (at list price) of every line given away entirely free. */
  freeValue: number;
  bySource: Record<OrderSource, number>;
}

function emptySourceCounts(): Record<OrderSource, number> {
  return { web: 0, facebook: 0, whatsapp: 0, phone: 0, shop: 0, family: 0, other: 0 };
}

/** This calendar month's order activity, for the Orders tab's "এই মাসে" card
 *  — computed entirely from the order list the tab already has loaded (every
 *  number it needs — subtotal/discount/list_value/free_value — is stored on
 *  the order row itself, see migration-028), no extra fetch needed.
 *  Cancelled orders are excluded, matching the spec ("cancelled orders
 *  excluded"). */
export function computeMonthlySummary(orders: Order[], now: Date = new Date()): MonthlySummary {
  const year = now.getFullYear();
  const month = now.getMonth();
  const bySource = emptySourceCounts();

  let orderCount = 0;
  let totalSales = 0;
  let totalDiscount = 0;
  let freeValue = 0;

  for (const order of orders) {
    if (order.status === 'cancelled') continue;
    const placedAt = new Date(order.created_at);
    if (placedAt.getFullYear() !== year || placedAt.getMonth() !== month) continue;

    orderCount += 1;
    totalSales += order.total;
    freeValue += order.free_value;
    // Line-level discount = list_value - subtotal - free_value (the part of
    // "value given up" that isn't a fully-free item), plus the flat
    // order-level discount.
    const lineDiscount = Math.max(0, order.list_value - order.subtotal - order.free_value);
    totalDiscount += lineDiscount + order.discount;
    bySource[order.source] = (bySource[order.source] ?? 0) + 1;
  }

  return { orderCount, totalSales, totalDiscount, freeValue, bySource };
}
