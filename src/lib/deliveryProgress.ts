import type { Order, OrderStatusHistoryRow } from '../types';

/**
 * What a customer sees about their delivery (Batch 24 Part 6), worked out
 * only from what is already saved on the order — the order's own status
 * and the Steadfast status the steadfast / steadfast-refresh-all functions
 * store. The customer's browser never talks to Steadfast, and courier notes
 * or internal fields are never shown, only these friendly words.
 */
export const DELIVERY_STEPS = [
  { id: 'placed', label: 'Order placed' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'handed', label: 'Handed to courier' },
  { id: 'on_the_way', label: 'On the way' },
  { id: 'delivered', label: 'Delivered' },
] as const;

export type DeliveryStepId = (typeof DELIVERY_STEPS)[number]['id'];
export type DeliveryException = 'cancelled' | 'returned' | 'on_hold';

export interface DeliveryProgress {
  /** Index into DELIVERY_STEPS of the step reached. */
  stepIndex: number;
  /** Set when the order left the normal path. */
  exception: DeliveryException | null;
  /** One short phrase for the current state, e.g. "On the way". */
  label: string;
  /** When the current state was last updated (ISO), if known. */
  updatedAt: string | null;
}

const EXCEPTION_LABELS: Record<DeliveryException, string> = {
  cancelled: 'Cancelled',
  returned: 'Returned',
  on_hold: 'On hold',
};

type ProgressOrder = Pick<Order, 'status' | 'steadfast_status' | 'steadfast_status_updated_at' | 'updated_at' | 'created_at'>;

function latestHistoryTime(history: Pick<OrderStatusHistoryRow, 'changed_at'>[]): string | null {
  let latest: string | null = null;
  for (const row of history) {
    if (!latest || row.changed_at > latest) latest = row.changed_at;
  }
  return latest;
}

export function deliveryProgress(
  order: ProgressOrder,
  history: Pick<OrderStatusHistoryRow, 'changed_at'>[] = []
): DeliveryProgress {
  const courier = order.steadfast_status;
  const orderTime = latestHistoryTime(history) ?? order.updated_at ?? order.created_at;
  const courierTime = order.steadfast_status_updated_at ?? orderTime;

  const result = (stepIndex: number, exception: DeliveryException | null, updatedAt: string | null): DeliveryProgress => ({
    stepIndex,
    exception,
    label: exception ? EXCEPTION_LABELS[exception] : DELIVERY_STEPS[stepIndex].label,
    updatedAt,
  });

  if (order.status === 'cancelled') return result(0, 'cancelled', orderTime);
  if (order.status === 'delivered' || courier === 'delivered' || courier === 'partial_delivered') {
    return result(4, null, courier ? courierTime : orderTime);
  }
  if (courier) {
    if (courier === 'cancelled' || courier === 'cancelled_approval_pending') return result(3, 'returned', courierTime);
    if (courier === 'hold' || courier === 'exceptional') return result(3, 'on_hold', courierTime);
    if (courier === 'in_review') return result(2, null, courierTime);
    // pending, *_approval_pending (not yet confirmed by Steadfast), unknown
    return result(3, null, courierTime);
  }
  if (order.status === 'shipped') return result(2, null, orderTime);
  if (order.status === 'confirmed') return result(1, null, orderTime);
  return result(0, null, orderTime);
}
