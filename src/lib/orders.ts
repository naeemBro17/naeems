import { supabase } from './supabase';
import type { CartItem, DeliveryAddress, DeliveryZoneId } from '../features/checkout/types';
import type { Order, OrderItem, OrderPaymentMethod, OrderStatusHistoryRow, OrderWithDetails } from '../types';

const ORDER_SELECT =
  'id, order_number, customer_id, customer_name, customer_phone, division, district, thana, address_line, delivery_zone, delivery_fee, subtotal, discount, promo_code, total, payment_method, bkash_trx_id, bkash_sender, payment_status, status, tracking_number, customer_note, admin_note, created_at, updated_at';

const ORDER_ITEM_SELECT =
  'id, order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total';

const ORDER_HISTORY_SELECT = 'id, order_id, old_status, new_status, changed_by, changed_at, note';

export interface PlaceOrderInput {
  items: CartItem[];
  address: DeliveryAddress;
  deliveryZone: DeliveryZoneId;
  paymentMethod: OrderPaymentMethod;
  bkashTrxId?: string;
  bkashSender?: string;
  promoCode?: string | null;
  customerNote?: string;
}

export interface PlaceOrderResult {
  orderId: string | null;
  orderNumber: string | null;
  error: string | null;
}

/**
 * The ONLY way an order is ever created — everything (price, stock, delivery
 * fee, promo validity) is re-checked and computed inside place_order() on
 * the database side; this just shapes the cart into the plain
 * {product_id, variant_id, quantity} list the function trusts, nothing else.
 */
export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const items = input.items.map((item) => ({
    product_id: item.product.id,
    variant_id: item.variantId,
    quantity: item.quantity,
  }));

  const { data, error } = await supabase.rpc('place_order', {
    p_items: items,
    p_full_name: input.address.fullName,
    p_phone: input.address.phone,
    p_division: input.address.division,
    p_district: input.address.district,
    p_thana: input.address.thana,
    p_address_line: input.address.fullAddress,
    p_delivery_zone: input.deliveryZone,
    p_payment_method: input.paymentMethod,
    p_bkash_trx_id: input.paymentMethod === 'bkash' ? (input.bkashTrxId ?? null) : null,
    p_bkash_sender: input.paymentMethod === 'bkash' ? (input.bkashSender ?? null) : null,
    p_promo_code: input.promoCode ?? null,
    p_customer_note: input.customerNote ?? null,
  });

  if (error) {
    // place_order's RAISE EXCEPTION messages are written to be shown to the
    // customer as-is (stock/price/promo problems) — anything else falls
    // back to a generic message rather than leaking a raw Postgres error.
    const friendly = /already|sign|stock|available|invalid|required|promo|no longer/i.test(
      error.message
    )
      ? error.message
      : 'Could not place your order. Please try again.';
    return { orderId: null, orderNumber: null, error: friendly };
  }

  const row = (data as { order_id: string; order_number: string }[] | null)?.[0];
  if (!row) {
    return { orderId: null, orderNumber: null, error: 'Could not place your order. Please try again.' };
  }
  return { orderId: row.order_id, orderNumber: row.order_number, error: null };
}

/** Cancel an order — customer's own while 'pending', or admin from
 *  'pending'/'confirmed'. Restores any stock it had reserved. */
export async function cancelOrder(orderId: string, note?: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('cancel_order', { p_order_id: orderId, p_note: note ?? null });
  if (error) {
    return { error: error.message || 'Could not cancel this order.' };
  }
  return { error: null };
}

/** The signed-in customer's own orders, newest first — list view only, no
 *  items/history (see fetchOrderDetail for a single order's full detail). */
export async function fetchMyOrders(): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_SELECT)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('fetchMyOrders failed:', error.message);
    return [];
  }
  return (data ?? []) as Order[];
}

/** One order with its items and status timeline — RLS already limits this
 *  to the caller's own order (or any order, for an admin session). */
export async function fetchOrderDetail(orderId: string): Promise<OrderWithDetails | null> {
  const [orderRes, itemsRes, historyRes] = await Promise.all([
    supabase.from('orders').select(ORDER_SELECT).eq('id', orderId).maybeSingle(),
    supabase.from('order_items').select(ORDER_ITEM_SELECT).eq('order_id', orderId),
    supabase
      .from('order_status_history')
      .select(ORDER_HISTORY_SELECT)
      .eq('order_id', orderId)
      .order('changed_at', { ascending: true }),
  ]);

  if (orderRes.error || !orderRes.data) return null;

  return {
    ...(orderRes.data as Order),
    items: (itemsRes.data ?? []) as OrderItem[],
    history: (historyRes.data ?? []) as OrderStatusHistoryRow[],
  };
}

/** Admin Orders tab: every order, newest first (RLS: admin only). */
export async function fetchAllOrders(): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_SELECT)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('fetchAllOrders failed:', error.message);
    return [];
  }
  return (data ?? []) as Order[];
}

/** Admin: change an order's status, always leaving a history row — see
 *  admin_set_order_status() (migration-021) for why this isn't a raw UPDATE. */
export async function adminSetOrderStatus(
  orderId: string,
  status: Order['status'],
  note?: string
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_set_order_status', {
    p_order_id: orderId,
    p_new_status: status,
    p_note: note ?? null,
  });
  return { error: error?.message ?? null };
}

/** Admin: change the delivery fee on one order (e.g. a heavy parcel needs a
 *  higher courier charge) while it's still pending/confirmed — see
 *  admin_update_order_delivery_fee() (migration-024). The database
 *  recalculates the order's total itself and logs the change into its
 *  status history; nothing here computes or trusts a total. */
export async function adminUpdateOrderDeliveryFee(
  orderId: string,
  newFee: number
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_update_order_delivery_fee', {
    p_order_id: orderId,
    p_new_fee: newFee,
  });
  return { error: error?.message ?? null };
}

/** Admin: mark a bKash order as paid after checking the bKash app by hand,
 *  set a courier tracking number, or edit the admin-only note — a plain
 *  UPDATE, gated by orders_admin_update + the column-level grant
 *  (migration-021), not a status change so no history row is needed. */
export async function adminUpdateOrder(
  orderId: string,
  patch: Partial<Pick<Order, 'payment_status' | 'tracking_number' | 'admin_note'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', orderId);
  return { error: error?.message ?? null };
}
