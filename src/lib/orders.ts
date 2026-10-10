import { supabase } from './supabase';
import type { CartItem, DeliveryAddress, DeliveryZoneId } from '../features/checkout/types';
import type {
  DiscountReason,
  Order,
  OrderItem,
  OrderPaymentMethod,
  OrderSource,
  OrderStatusHistoryRow,
  OrderWithDetails,
} from '../types';
import { parseStockWarning } from './manualOrders';
import type { PaymentMethodId } from './payments';
import type { CollectMode } from '../../supabase/functions/_shared/cod';
import type { StockWarning } from './manualOrders';

// Batch 24 (migration-030) adds steadfast_status_updated_at. Tried first;
// if that column isn't there yet, the Batch 22 select below, then the
// legacy one — the same "never break a screen over a missing column" rule.
// Batch 30 (migration-033): alternative phone, courier note, the admin
// customer link and the Steadfast COD / outdated-details columns.
const ORDER_SELECT_033 =
  'id, order_number, customer_id, source, customer_name, customer_phone, division, district, thana, address_line, delivery_zone, delivery_fee, subtotal, discount, discount_reason, discount_note, list_value, free_value, promo_code, total, payment_method, bkash_trx_id, bkash_sender, payment_status, status, tracking_number, customer_note, admin_note, steadfast_consignment_id, steadfast_tracking_code, steadfast_tracking_link, steadfast_status, steadfast_status_updated_at, alt_phone, courier_note, admin_customer_id, steadfast_cod_amount, steadfast_outdated, created_at, updated_at';

// Batch 32 (migration-035): what happens to the rest of the money.
const ORDER_SELECT_035 = `${ORDER_SELECT_033}, collect_mode`;

const ORDER_SELECT_030 =
  'id, order_number, customer_id, source, customer_name, customer_phone, division, district, thana, address_line, delivery_zone, delivery_fee, subtotal, discount, discount_reason, discount_note, list_value, free_value, promo_code, total, payment_method, bkash_trx_id, bkash_sender, payment_status, status, tracking_number, customer_note, admin_note, steadfast_consignment_id, steadfast_tracking_code, steadfast_tracking_link, steadfast_status, steadfast_status_updated_at, created_at, updated_at';

const ORDER_SELECT =
  'id, order_number, customer_id, source, customer_name, customer_phone, division, district, thana, address_line, delivery_zone, delivery_fee, subtotal, discount, discount_reason, discount_note, list_value, free_value, promo_code, total, payment_method, bkash_trx_id, bkash_sender, payment_status, status, tracking_number, customer_note, admin_note, steadfast_consignment_id, steadfast_tracking_code, steadfast_tracking_link, steadfast_status, created_at, updated_at';

const ORDER_ITEM_SELECT =
  'id, order_id, product_id, variant_id, product_name, variant_label, image_url, list_price, unit_price, quantity, line_total, reason, reason_note';

// Batch 22 added columns to orders/order_items (migration-028) that Naeem
// may not have run yet — per CLAUDE.md, a migration file existing is never
// proof it's live. Postgrest fails a select's ENTIRE query (not just the
// missing column) when any requested column doesn't exist yet (code
// '42703'), which would otherwise take down every order screen — including
// ones that have nothing to do with this batch — the moment this code
// deploys, until Naeem gets to the SQL Editor. These legacy select strings
// let every order screen keep working exactly as before in that window;
// normalizeOrderRow/normalizeOrderItemRow below fill in sensible defaults
// for the columns that came back missing.
const ORDER_SELECT_LEGACY =
  'id, order_number, customer_id, customer_name, customer_phone, division, district, thana, address_line, delivery_zone, delivery_fee, subtotal, discount, promo_code, total, payment_method, bkash_trx_id, bkash_sender, payment_status, status, tracking_number, customer_note, admin_note, steadfast_consignment_id, steadfast_tracking_code, steadfast_tracking_link, steadfast_status, created_at, updated_at';

const ORDER_ITEM_SELECT_LEGACY =
  'id, order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total';

const ORDER_HISTORY_SELECT = 'id, order_id, old_status, new_status, changed_by, changed_by_username, changed_at, note';
const ORDER_HISTORY_SELECT_LEGACY = 'id, order_id, old_status, new_status, changed_by, changed_at, note';

/** Postgrest's "column does not exist" code — see the ORDER_SELECT_LEGACY
 *  comment above for why this triggers a same-shape retry instead of an
 *  error screen. */
const UNDEFINED_COLUMN = '42703';

/** PostgREST's "no such function" code (a migration not run yet). */
const FUNCTION_NOT_FOUND = 'PGRST202';

function normalizeOrderRow(row: Record<string, unknown>): Order {
  const subtotal = row.subtotal as number;
  return {
    ...(row as unknown as Order),
    source: (row.source as OrderSource | undefined) ?? 'web',
    discount_reason: (row.discount_reason as DiscountReason | null | undefined) ?? null,
    discount_note: (row.discount_note as string | null | undefined) ?? null,
    list_value: (row.list_value as number | undefined) ?? subtotal,
    free_value: (row.free_value as number | undefined) ?? 0,
    steadfast_status_updated_at: (row.steadfast_status_updated_at as string | null | undefined) ?? null,
    alt_phone: (row.alt_phone as string | null | undefined) ?? null,
    courier_note: (row.courier_note as string | null | undefined) ?? null,
    admin_customer_id: (row.admin_customer_id as string | null | undefined) ?? null,
    steadfast_cod_amount:
      row.steadfast_cod_amount === null || row.steadfast_cod_amount === undefined ? null : Number(row.steadfast_cod_amount),
    steadfast_outdated: (row.steadfast_outdated as string[] | null | undefined) ?? [],
    collect_mode: row.collect_mode === 'pay_later' ? 'pay_later' : 'cod',
  };
}

function normalizeOrderItemRow(row: Record<string, unknown>): OrderItem {
  const unitPrice = row.unit_price as number;
  return {
    ...(row as unknown as OrderItem),
    list_price: (row.list_price as number | undefined) ?? unitPrice,
    reason: (row.reason as DiscountReason | null | undefined) ?? null,
    reason_note: (row.reason_note as string | null | undefined) ?? null,
  };
}

type OrdersQueryResult = { data: Record<string, unknown>[] | null; error: { code?: string; message: string } | null };

async function selectOrdersList(): Promise<OrdersQueryResult> {
  const b32 = await supabase.from('orders').select(ORDER_SELECT_035).order('created_at', { ascending: false });
  if (b32.error?.code !== UNDEFINED_COLUMN) return b32;
  const newest = await supabase.from('orders').select(ORDER_SELECT_033).order('created_at', { ascending: false });
  if (newest.error?.code !== UNDEFINED_COLUMN) return newest;
  const latest = await supabase.from('orders').select(ORDER_SELECT_030).order('created_at', { ascending: false });
  if (latest.error?.code !== UNDEFINED_COLUMN) return latest;
  const res = await supabase.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false });
  if (res.error?.code === UNDEFINED_COLUMN) {
    return supabase.from('orders').select(ORDER_SELECT_LEGACY).order('created_at', { ascending: false });
  }
  return res;
}

type OrderQueryResult = {
  data: Record<string, unknown> | null;
  error: { code?: string; message: string } | null;
};

async function selectOrderById(orderId: string): Promise<OrderQueryResult> {
  const b32 = await supabase.from('orders').select(ORDER_SELECT_035).eq('id', orderId).maybeSingle();
  if (b32.error?.code !== UNDEFINED_COLUMN) return b32;
  const newest = await supabase.from('orders').select(ORDER_SELECT_033).eq('id', orderId).maybeSingle();
  if (newest.error?.code !== UNDEFINED_COLUMN) return newest;
  const latest = await supabase.from('orders').select(ORDER_SELECT_030).eq('id', orderId).maybeSingle();
  if (latest.error?.code !== UNDEFINED_COLUMN) return latest;
  const res = await supabase.from('orders').select(ORDER_SELECT).eq('id', orderId).maybeSingle();
  if (res.error?.code === UNDEFINED_COLUMN) {
    return supabase.from('orders').select(ORDER_SELECT_LEGACY).eq('id', orderId).maybeSingle();
  }
  return res;
}

async function selectOrderItems(orderId: string): Promise<OrdersQueryResult> {
  const res = await supabase.from('order_items').select(ORDER_ITEM_SELECT).eq('order_id', orderId);
  if (res.error?.code === UNDEFINED_COLUMN) {
    return supabase.from('order_items').select(ORDER_ITEM_SELECT_LEGACY).eq('order_id', orderId);
  }
  return res;
}

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
  const { data, error } = await selectOrdersList();
  if (error) {
    console.error('fetchMyOrders failed:', error.message);
    return [];
  }
  return (data ?? []).map(normalizeOrderRow);
}

/** One order with its items and status timeline — RLS already limits this
 *  to the caller's own order (or any order, for an admin session). */
export async function fetchOrderDetail(orderId: string): Promise<OrderWithDetails | null> {
  const [orderRes, itemsRes, historyRes] = await Promise.all([
    selectOrderById(orderId),
    selectOrderItems(orderId),
    selectOrderHistory(orderId),
  ]);

  if (orderRes.error || !orderRes.data) return null;

  return {
    ...normalizeOrderRow(orderRes.data),
    items: (itemsRes.data ?? []).map(normalizeOrderItemRow),
    history: ((historyRes.data ?? []) as Record<string, unknown>[]).map((row) => ({
      ...(row as unknown as OrderStatusHistoryRow),
      changed_by_username: (row.changed_by_username as string | null | undefined) ?? null,
    })),
  };
}

async function selectOrderHistory(orderId: string): Promise<OrdersQueryResult> {
  const res = await supabase
    .from('order_status_history')
    .select(ORDER_HISTORY_SELECT)
    .eq('order_id', orderId)
    .order('changed_at', { ascending: true });
  if (res.error?.code === UNDEFINED_COLUMN) {
    return supabase
      .from('order_status_history')
      .select(ORDER_HISTORY_SELECT_LEGACY)
      .eq('order_id', orderId)
      .order('changed_at', { ascending: true });
  }
  return res;
}

/** Admin Orders tab: every order, newest first (RLS: admin only). */
export async function fetchAllOrders(): Promise<Order[]> {
  const { data, error } = await selectOrdersList();
  if (error) {
    console.error('fetchAllOrders failed:', error.message);
    return [];
  }
  return (data ?? []).map(normalizeOrderRow);
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

/** Mirrors needsAttention() in supabase/functions/_shared/steadfast.ts —
 *  the frontend has no access to that Deno-only module, so this is kept in
 *  sync by hand; it's three literal strings, not worth a build step to
 *  share. Used to badge an order in the admin list/detail screens the
 *  moment Steadfast's own status (from either the manual refresh button or
 *  the automatic 3-hourly one) needs Naeem to look at it himself. */
export function steadfastNeedsAttention(courierStatus: string | null): boolean {
  return courierStatus === 'cancelled' || courierStatus === 'hold' || courierStatus === 'exceptional';
}

interface SteadfastFunctionResponse {
  ok: boolean;
  error?: string;
  consignmentId?: string;
  trackingCode?: string;
  trackingLink?: string;
  courierStatus?: string;
  markedDelivered?: boolean;
  needsAttention?: boolean;
}

export interface SteadfastBookingResult {
  error: string | null;
  consignmentId: string | null;
  trackingCode: string | null;
  trackingLink: string | null;
  courierStatus: string | null;
}

/** Admin: book this order's parcel with Steadfast Courier — see the
 *  `steadfast` Edge Function (Batch 20) for every validation this goes
 *  through server-side (order must be confirmed, not already booked, COD
 *  amount worked out from payment method/status). Never sends order data
 *  itself — the function reads the order from the database by id. */
export async function bookSteadfastShipment(orderId: string): Promise<SteadfastBookingResult> {
  const { data, error } = await supabase.functions.invoke('steadfast', {
    body: { action: 'create', orderId },
  });
  const empty = { consignmentId: null, trackingCode: null, trackingLink: null, courierStatus: null };
  if (error) {
    return { error: error.message || 'Could not reach Steadfast. Please try again.', ...empty };
  }
  const body = data as SteadfastFunctionResponse;
  if (!body.ok) {
    return { error: body.error ?? 'Could not book with Steadfast.', ...empty };
  }
  return {
    error: null,
    consignmentId: body.consignmentId ?? null,
    trackingCode: body.trackingCode ?? null,
    trackingLink: body.trackingLink ?? null,
    courierStatus: body.courierStatus ?? null,
  };
}

export interface SteadfastStatusResult {
  error: string | null;
  courierStatus: string | null;
  markedDelivered: boolean;
  needsAttention: boolean;
}

/** Admin: ask Steadfast for this order's current delivery status and save
 *  it. Only ever auto-advances the order's own status to 'delivered' —
 *  everything else (cancelled/hold/returned) is left for Naeem to see and
 *  act on himself. */
export async function refreshSteadfastStatus(orderId: string): Promise<SteadfastStatusResult> {
  const { data, error } = await supabase.functions.invoke('steadfast', {
    body: { action: 'status', orderId },
  });
  if (error) {
    return {
      error: error.message || 'Could not reach Steadfast. Please try again.',
      courierStatus: null,
      markedDelivered: false,
      needsAttention: false,
    };
  }
  const body = data as SteadfastFunctionResponse;
  if (!body.ok) {
    return {
      error: body.error ?? 'Could not refresh status.',
      courierStatus: null,
      markedDelivered: false,
      needsAttention: false,
    };
  }
  return {
    error: null,
    courierStatus: body.courierStatus ?? null,
    markedDelivered: body.markedDelivered ?? false,
    needsAttention: body.needsAttention ?? false,
  };
}

export interface DeleteOrdersResult {
  orderId: string;
  orderNumber: string | null;
  deleted: boolean;
  reason: string | null;
}

/** Admin: permanently remove one or more CANCELLED orders — see
 *  admin_delete_cancelled_orders() (migration-027). Any id that isn't
 *  actually cancelled (or doesn't exist) comes back with deleted: false and
 *  a reason instead of the whole batch failing, so selecting a mixed batch
 *  by mistake still deletes everything it safely can. */
export async function adminDeleteCancelledOrders(orderIds: string[]): Promise<{
  results: DeleteOrdersResult[];
  error: string | null;
}> {
  const { data, error } = await supabase.rpc('admin_delete_cancelled_orders', {
    p_order_ids: orderIds,
  });
  if (error) {
    return { results: [], error: error.message || 'Could not delete these orders.' };
  }
  const rows = (data ?? []) as {
    order_id: string;
    order_number: string | null;
    deleted: boolean;
    reason: string | null;
  }[];
  return {
    results: rows.map((r) => ({
      orderId: r.order_id,
      orderNumber: r.order_number,
      deleted: r.deleted,
      reason: r.reason,
    })),
    error: null,
  };
}

/** Admin: mark a bKash order as paid after checking the bKash app by hand,
 *  set a courier tracking number, or edit the admin-only note — a plain
 *  UPDATE, gated by orders_admin_update + the column-level grant
 *  (migration-021), not a status change so no history row is needed. */
export async function adminUpdateOrder(
  orderId: string,
  patch: Partial<Pick<Order, 'payment_status' | 'tracking_number' | 'admin_note'>>
): Promise<{ error: string | null }> {
  // Batch 24: through admin_update_order_fields() (migration-030), which a
  // moderator with "Change order status" may also use — the plain UPDATE
  // below stays only as the fallback until that migration is run.
  const rpc = await supabase.rpc('admin_update_order_fields', { p_order_id: orderId, p_fields: patch });
  if (!rpc.error) return { error: null };
  if (rpc.error.code !== FUNCTION_NOT_FOUND) return { error: rpc.error.message };
  const { error } = await supabase
    .from('orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', orderId);
  return { error: error?.message ?? null };
}

/* ============================================================
   Manual orders (Batch 22) — "New order" in Admin -> Orders
   ============================================================ */

export interface ManualOrderItemInput {
  productId: string;
  variantId: string | null;
  quantity: number;
  /** Null = charge the product/variant's real current price (no discount). */
  soldPrice: number | null;
  reason: DiscountReason | null;
  reasonNote: string | null;
}

export interface AdminCreateOrderInput {
  source: OrderSource;
  items: ManualOrderItemInput[];
  fullName: string;
  phone: string;
  division: string;
  district: string;
  thana: string;
  addressLine: string;
  deliveryZone: 'inside_dhaka' | 'outside_dhaka' | 'hand_delivered';
  deliveryFee: number;
  orderDiscount: number;
  discountReason: DiscountReason | null;
  discountNote: string | null;
  paymentMethod: OrderPaymentMethod;
  bkashTrxId?: string | null;
  bkashSender?: string | null;
  /** Set only when Naeem explicitly picked an existing online account —
   *  never inferred from a matching phone number. See CLAUDE.md's privacy
   *  rule and migration-028's header comment. */
  linkedCustomerId?: string | null;
  markDelivered?: boolean;
  adminNote?: string | null;
  /** Resubmit with this true after the admin sees a stock warning and
   *  chooses to continue anyway — see StockWarning / parseStockWarning. */
  allowNegativeStock?: boolean;
  /** Batch 32: "Paid now" — saved as a real payment in the same step. */
  paidNow?: number;
  paidMethod?: PaymentMethodId | null;
  paidTrxId?: string | null;
  /** Batch 32: what happens to the rest ('pay_later' = courier collects ৳0). */
  collectMode?: CollectMode;
  altPhone?: string | null;
}

export interface AdminCreateOrderResult {
  orderId: string | null;
  orderNumber: string | null;
  error: string | null;
  /** Populated only when the database rejected the order over insufficient
   *  tracked stock — resubmit the same input with allowNegativeStock: true
   *  to go ahead anyway. */
  stockWarnings: StockWarning[] | null;
}

/** The ONLY way a manual order is created — see admin_create_order()
 *  (migration-028). Every price/stock check re-reads the database itself;
 *  this just shapes the form's state into the plain arguments the function
 *  trusts. Rejected outright for a non-admin session. */
export async function adminCreateOrder(input: AdminCreateOrderInput): Promise<AdminCreateOrderResult> {
  const items = input.items.map((item) => ({
    product_id: item.productId,
    variant_id: item.variantId,
    quantity: item.quantity,
    sold_price: item.soldPrice,
    reason: item.reason,
    reason_note: item.reasonNote,
  }));

  // Batch 32: admin_create_order_v2 (migration-035) saves the order, the
  // "Paid now" payment and what happens to the rest in one step. Before
  // it is run: the Batch 30 function, then the payment added on its own.
  const paidNow = Math.max(0, input.paidNow ?? 0);
  const collectMode: CollectMode = input.collectMode ?? 'cod';
  const v2 = await supabase.rpc('admin_create_order_v2', {
    p_source: input.source,
    p_items: items,
    p_full_name: input.fullName,
    p_phone: input.phone,
    p_division: input.division,
    p_district: input.district,
    p_thana: input.thana,
    p_address_line: input.addressLine,
    p_delivery_zone: input.deliveryZone,
    p_delivery_fee: input.deliveryFee,
    p_order_discount: input.orderDiscount,
    p_discount_reason: input.discountReason,
    p_discount_note: input.discountNote,
    p_linked_customer_id: input.linkedCustomerId ?? null,
    p_mark_delivered: input.markDelivered ?? false,
    p_admin_note: input.adminNote ?? null,
    p_allow_negative_stock: input.allowNegativeStock ?? false,
    p_paid_amount: paidNow,
    p_paid_method: paidNow > 0 ? (input.paidMethod ?? null) : null,
    p_paid_trx_id: paidNow > 0 ? (input.paidTrxId?.trim() || null) : null,
    p_collect_mode: collectMode,
    p_alt_phone: input.altPhone?.trim() || null,
  });
  if (v2.error?.code !== FUNCTION_NOT_FOUND) {
    return createOrderResult(v2.data, v2.error);
  }

  const { data, error } = await supabase.rpc('admin_create_order', {
    p_source: input.source,
    p_items: items,
    p_full_name: input.fullName,
    p_phone: input.phone,
    p_division: input.division,
    p_district: input.district,
    p_thana: input.thana,
    p_address_line: input.addressLine,
    p_delivery_zone: input.deliveryZone,
    p_delivery_fee: input.deliveryFee,
    p_order_discount: input.orderDiscount,
    p_discount_reason: input.discountReason,
    p_discount_note: input.discountNote,
    // With a "Paid now" amount the order starts unpaid and the payment is
    // added right after (so its method and TrxID are kept as typed).
    p_payment_method: paidNow > 0 ? 'cod' : input.paymentMethod,
    p_bkash_trx_id: paidNow > 0 ? null : (input.bkashTrxId ?? null),
    p_bkash_sender: paidNow > 0 ? null : (input.bkashSender ?? null),
    p_linked_customer_id: input.linkedCustomerId ?? null,
    p_mark_delivered: input.markDelivered ?? false,
    p_admin_note: input.adminNote ?? null,
    p_allow_negative_stock: input.allowNegativeStock ?? false,
  });

  const result = createOrderResult(data, error);
  if (result.orderId && paidNow > 0 && input.paidMethod) {
    const paid = await supabase.rpc('admin_add_order_payment', {
      p_order_id: result.orderId,
      p_amount: paidNow,
      p_method: input.paidMethod,
      p_trx_id: input.paidTrxId?.trim() || null,
      p_paid_at: null,
      p_note: 'Paid when the order was entered',
      p_kind: 'payment',
    });
    if (paid.error) {
      return { ...result, error: `Order ${result.orderNumber ?? ''} saved, but the payment was not recorded: ${paid.error.message}` };
    }
  }
  return result;
}

function createOrderResult(data: unknown, error: { message: string } | null): AdminCreateOrderResult {
  if (error) {
    const stockWarnings = parseStockWarning(error.message);
    if (stockWarnings) {
      return { orderId: null, orderNumber: null, error: error.message, stockWarnings };
    }
    return { orderId: null, orderNumber: null, error: error.message || 'Could not save this order.', stockWarnings: null };
  }

  const row = (data as { order_id: string; order_number: string }[] | null)?.[0];
  if (!row) {
    return { orderId: null, orderNumber: null, error: 'Could not save this order.', stockWarnings: null };
  }
  return { orderId: row.order_id, orderNumber: row.order_number, error: null, stockWarnings: null };
}

/** Batch 32: Edit order → "Customer pays later" / "Collect on delivery". */
export async function adminSetCollectMode(orderId: string, mode: CollectMode): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_set_order_collect_mode', { p_order_id: orderId, p_mode: mode });
  if (!error) return { error: null };
  if (error.code === FUNCTION_NOT_FOUND) return { error: COLLECT_MODE_NEEDS_UPDATE };
  return { error: error.message || 'Could not save the payment choice.' };
}

export const COLLECT_MODE_NEEDS_UPDATE =
  '"Customer pays later" needs the Batch 32 database update (migration-035). Until then the courier collects what is due.';

let collectModeReady: Promise<boolean> | null = null;

/** Whether migration-035 is live (orders.collect_mode exists). Asked once. */
export function isCollectModeReady(): Promise<boolean> {
  if (!collectModeReady) {
    collectModeReady = Promise.resolve(supabase.from('orders').select('collect_mode').limit(1)).then(
      ({ error }) => error?.code !== UNDEFINED_COLUMN
    );
  }
  return collectModeReady;
}

export interface CustomerMatch {
  /** Present only for a real online account (profiles row) — a past order's
   *  own snapshot fields never carry an id worth linking to. */
  profileId: string | null;
  fullName: string;
  division: string;
  district: string;
  thana: string;
  addressLine: string;
}

/** Looks up a typed phone number against past orders and customer profiles,
 *  so the admin form can OFFER to fill in a name/address Naeem taps to
 *  accept — never applied automatically. Matching on the last 10 digits
 *  only, since phone numbers get typed with/without a country code or with
 *  stray spaces/hyphens across different orders.
 *
 *  Privacy rule (CLAUDE.md): this never attaches the new order to
 *  fromProfile's account by itself — a phone number isn't proof of identity
 *  (anyone could type someone else's number). Linking to an account only
 *  ever happens when Naeem explicitly picks it — see AdminCreateOrderInput
 *  linkedCustomerId. */
export async function findCustomerMatches(phone: string): Promise<{
  fromProfile: CustomerMatch | null;
  fromOrder: CustomerMatch | null;
}> {
  const digits = phone.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  if (last10.length < 10) {
    return { fromProfile: null, fromOrder: null };
  }

  const [profileRes, orderRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, role, full_name, division, district, thana, address_line, phone')
      .eq('role', 'customer')
      .ilike('phone', `%${last10}`)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('orders')
      .select('customer_name, division, district, thana, address_line, customer_phone')
      .ilike('customer_phone', `%${last10}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const fromProfile = profileRes.data
    ? {
        profileId: profileRes.data.id as string,
        fullName: (profileRes.data.full_name as string | null) ?? '',
        division: (profileRes.data.division as string | null) ?? '',
        district: (profileRes.data.district as string | null) ?? '',
        thana: (profileRes.data.thana as string | null) ?? '',
        addressLine: (profileRes.data.address_line as string | null) ?? '',
      }
    : null;

  const fromOrder = orderRes.data
    ? {
        profileId: null,
        fullName: orderRes.data.customer_name as string,
        division: orderRes.data.division as string,
        district: orderRes.data.district as string,
        thana: orderRes.data.thana as string,
        addressLine: orderRes.data.address_line as string,
      }
    : null;

  return { fromProfile, fromOrder };
}

/* ============================================================
   Batch 24 — deleting orders, price edits, order number format
   ============================================================ */

/** An order anyone allowed to delete orders may delete without the Safety
 *  Lock: never booked on Steadfast and not sent (Pending, Confirmed or
 *  Cancelled). Mirrors admin_delete_orders() (migration-041), which is what
 *  actually decides. */
export function isEarlyStageOrder(order: Pick<Order, 'status' | 'steadfast_consignment_id'>): boolean {
  return !order.steadfast_consignment_id && (order.status === 'pending' || order.status === 'confirmed' || order.status === 'cancelled');
}

/** Puts a cancelled order back to the status it had before the cancel and
 *  takes its stock again — see admin_reopen_order() (migration-041). The
 *  database refuses when stock is short ("Only 0 in stock for …"). */
export async function adminReopenOrder(orderId: string): Promise<{ status: Order['status'] | null; error: string | null }> {
  const { data, error } = await supabase.rpc('admin_reopen_order', { p_order_id: orderId });
  if (error) {
    const notReady = error.code === 'PGRST202' || error.code === '42883';
    return { status: null, error: notReady ? 'Reopen is not ready yet (the database addition is not applied).' : error.message };
  }
  return { status: data as Order['status'], error: null };
}

/** Deletes orders — see admin_delete_orders(): early-stage orders for the
 *  Super Admin or a moderator with "Delete early orders"; any stage only
 *  for the Super Admin while his Safety Lock is off. Each order is decided
 *  on its own; refused ones come back with a reason. Stock is restored in
 *  the database. */
export async function adminDeleteOrders(orderIds: string[]): Promise<{
  results: DeleteOrdersResult[];
  error: string | null;
}> {
  const { data, error } = await supabase.rpc('admin_delete_orders', { p_order_ids: orderIds });
  if (error) {
    return { results: [], error: error.message || 'Could not delete these orders.' };
  }
  const rows = (data ?? []) as {
    order_id: string;
    order_number: string | null;
    deleted: boolean;
    reason: string | null;
  }[];
  return {
    results: rows.map((r) => ({
      orderId: r.order_id,
      orderNumber: r.order_number,
      deleted: r.deleted,
      reason: r.reason,
    })),
    error: null,
  };
}

/** Super Admin: change one item's unit price (0 = free). The database
 *  recalculates the order's subtotal, discount and total itself. */
export async function adminUpdateOrderItemPrice(
  itemId: string,
  newUnitPrice: number
): Promise<{ error: string | null; newTotal: number | null }> {
  const { data, error } = await supabase.rpc('admin_update_order_item_price', {
    p_item_id: itemId,
    p_new_unit_price: newUnitPrice,
  });
  if (error) return { error: error.message || 'Could not change the price.', newTotal: null };
  const row = (data as { new_total: number }[] | null)?.[0];
  return { error: null, newTotal: row ? Number(row.new_total) : null };
}

export interface OrderNumberFormat {
  prefix: string;
  nextNumber: number;
  suffix: string;
}

export function previewOrderNumber(format: OrderNumberFormat): string {
  return `${format.prefix}${format.nextNumber}${format.suffix}`;
}

export async function fetchOrderNumberFormat(): Promise<OrderNumberFormat | null> {
  const { data, error } = await supabase.rpc('admin_order_number_info');
  const row = (data as { prefix: string; next_number: number; suffix: string }[] | null)?.[0];
  if (error || !row) return null;
  return { prefix: row.prefix, nextNumber: Number(row.next_number), suffix: row.suffix };
}

export async function saveOrderNumberFormat(format: OrderNumberFormat): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_set_order_number_format', {
    p_prefix: format.prefix,
    p_next_number: format.nextNumber,
    p_suffix: format.suffix,
  });
  return { error: error?.message ?? null };
}
