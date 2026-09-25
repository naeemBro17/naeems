import type { Order, OrderPaymentStatus, OrderStatus } from '../types';

/** Plain-language labels — shared by the customer "My Orders" pages and the
 *  admin Orders tab so a status never reads differently in two places. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/** CSS modifier suffix for .status-badge--{tone} — see app.css. Neutral/
 *  semantic tones only, never the brand orange (CLAUDE.md's colour rule:
 *  orange is reserved for the screen's one primary action). */
export const ORDER_STATUS_TONE: Record<OrderStatus, 'neutral' | 'info' | 'success' | 'danger'> = {
  pending: 'neutral',
  confirmed: 'info',
  shipped: 'info',
  delivered: 'success',
  cancelled: 'danger',
};

export const PAYMENT_STATUS_LABELS: Record<OrderPaymentStatus, string> = {
  unpaid: 'Unpaid',
  pending_verification: 'Awaiting verification',
  paid: 'Paid',
};

export const PAYMENT_STATUS_TONE: Record<OrderPaymentStatus, 'neutral' | 'info' | 'success' | 'danger'> = {
  unpaid: 'neutral',
  pending_verification: 'info',
  paid: 'success',
};

/** The ordered list a status timeline steps through — 'cancelled' is a
 *  branch, not a step on this line, so it's excluded here and drawn
 *  separately wherever the timeline renders. */
export const ORDER_STATUS_SEQUENCE: OrderStatus[] = ['pending', 'confirmed', 'shipped', 'delivered'];

/** Customers may only cancel their own order while it's still pending —
 *  see cancel_order() (migration-021), enforced there, not just here. */
export function isCancellableByCustomer(order: Pick<Order, 'status'>): boolean {
  return order.status === 'pending';
}
