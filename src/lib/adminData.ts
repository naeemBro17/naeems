import { supabase } from './supabase';
import { fetchOrderDetail } from './orders';
import type { OrderWithDetails, Product } from '../types';

/* Batch 25 admin data: Home numbers, the Customers page, low stock, and the
   staff-only order notes (migration-031). */

/** Home numbers. A field is absent when this person may not see it (the
 *  database leaves it out), so the page simply doesn't show that card. */
export interface DashboardData {
  can_see_sales: boolean;
  low_stock_threshold: number;
  today_orders?: number;
  today_total?: number;
  to_confirm?: number;
  on_the_way?: number;
  month_orders?: number;
  month_total?: number;
  low_stock?: number;
  reviews_pending?: number;
  wholesalers_pending?: number;
}

export async function fetchDashboard(): Promise<{ data: DashboardData | null; error: string | null }> {
  const { data, error } = await supabase.rpc('admin_dashboard');
  if (error) {
    console.error('admin_dashboard failed:', error.message);
    return { data: null, error: 'Could not load the numbers. Pull down or try again.' };
  }
  const raw = (data ?? {}) as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const value = raw[key];
    return value === undefined || value === null ? undefined : Number(value);
  };
  return {
    data: {
      can_see_sales: raw.can_see_sales === true,
      low_stock_threshold: num('low_stock_threshold') ?? 5,
      today_orders: num('today_orders'),
      today_total: num('today_total'),
      to_confirm: num('to_confirm'),
      on_the_way: num('on_the_way'),
      month_orders: num('month_orders'),
      month_total: num('month_total'),
      low_stock: num('low_stock'),
      reviews_pending: num('reviews_pending'),
      wholesalers_pending: num('wholesalers_pending'),
    },
    error: null,
  };
}

/** The low-stock threshold setting as a number (default 5). */
export function parseLowStockThreshold(value: string | null | undefined): number {
  const n = Number((value ?? '').trim());
  return Number.isInteger(n) && n >= 0 ? n : 5;
}

/** At or below the threshold (tracked stock only). */
export function isLowStockCount(product: Pick<Product, 'stock_quantity'>, threshold: number): boolean {
  return product.stock_quantity !== null && product.stock_quantity !== undefined && product.stock_quantity <= threshold;
}

/** What the "Low stock" chip and Home's "products low on stock" count: live
 *  products at or below the threshold — the same rule as admin_dashboard(). */
export function isLowStockProduct(product: Pick<Product, 'stock_quantity' | 'is_active'>, threshold: number): boolean {
  return product.is_active && isLowStockCount(product, threshold);
}

/* ---------- Customers ---------- */

export interface CustomerRow {
  /** Batch 30: "p:<profile id>" for a registered customer, "ph:<phone>"
   *  for someone who only ever ordered through Naeem. */
  key: string;
  /** The profile id; null for a phone-only customer. */
  id: string | null;
  full_name: string;
  email: string;
  phone: string;
  order_count: number;
  /** Null without "See sales figures". */
  total_spent: number | null;
  last_order_at: string | null;
  /** Null for a phone-only customer (no account). */
  joined_at: string | null;
  /** What they still owe across their orders (Batch 30); null when not
   *  known (before migration-033, or no permission to see money). */
  total_due: number | null;
  /** Batch 32 (migration-035). Defaults until it is run. */
  hidden: boolean;
  note: string | null;
  alt_phone: string | null;
  /** Added with "Add customer" (can be deleted while they have no orders). */
  added_by_hand: boolean;
  /** Orders of any status, cancelled included (0 = may be deleted). */
  all_orders: number;
}

const CUSTOMER_DEFAULTS = { hidden: false, note: null, alt_phone: null, added_by_hand: false, all_orders: 0 };

/** Batch 32: whether the customers additions (add / hide / delete) are live. */
export interface CustomersResult {
  rows: CustomerRow[];
  error: string | null;
  /** False before migration-035: Add / Hide / Delete are not offered. */
  canManage: boolean;
}

/** Batch 32: admin_customers_v3 (migration-035) adds Hide, the note and
 *  customers added by hand; before it, the Batch 30 list. */
export async function fetchCustomersV3(): Promise<CustomersResult> {
  const v3 = await supabase.rpc('admin_customers_v3');
  if (!v3.error) {
    return {
      rows: ((v3.data ?? []) as Record<string, unknown>[]).map((r) => ({
        key: r.customer_key as string,
        id: (r.profile_id as string | null) ?? null,
        full_name: (r.full_name as string) ?? '',
        email: (r.email as string) ?? '',
        phone: (r.phone as string) ?? '',
        order_count: Number(r.order_count ?? 0),
        total_spent: r.total_spent === null || r.total_spent === undefined ? null : Number(r.total_spent),
        last_order_at: (r.last_order_at as string | null) ?? null,
        joined_at: (r.joined_at as string | null) ?? (r.added_at as string | null) ?? null,
        total_due: r.total_due === null || r.total_due === undefined ? null : Number(r.total_due),
        hidden: r.hidden === true,
        note: (r.note as string | null) ?? null,
        alt_phone: (r.alt_phone as string | null) ?? null,
        added_by_hand: r.added_by_hand === true,
        all_orders: Number(r.all_orders ?? 0),
      })),
      error: null,
      canManage: true,
    };
  }
  const old = await fetchCustomers();
  return { ...old, canManage: false };
}

/** Batch 30: everyone (registered or phone-only) with what they owe —
 *  admin_customers_v2 (migration-033); before it, the Batch 25 list. */
export async function fetchCustomers(): Promise<{ rows: CustomerRow[]; error: string | null }> {
  const v2 = await supabase.rpc('admin_customers_v2');
  if (!v2.error) {
    return {
      rows: ((v2.data ?? []) as Record<string, unknown>[]).map((r) => ({
        key: r.customer_key as string,
        id: (r.profile_id as string | null) ?? null,
        full_name: (r.full_name as string) ?? '',
        email: (r.email as string) ?? '',
        phone: (r.phone as string) ?? '',
        order_count: Number(r.order_count ?? 0),
        total_spent: r.total_spent === null || r.total_spent === undefined ? null : Number(r.total_spent),
        last_order_at: (r.last_order_at as string | null) ?? null,
        joined_at: (r.joined_at as string | null) ?? null,
        total_due: r.total_due === null || r.total_due === undefined ? null : Number(r.total_due),
        ...CUSTOMER_DEFAULTS,
        all_orders: Number(r.order_count ?? 0),
      })),
      error: null,
    };
  }
  const { data, error } = await supabase.rpc('admin_customers');
  if (error) {
    console.error('admin_customers failed:', error.message);
    return { rows: [], error: 'Could not load customers.' };
  }
  return {
    rows: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      key: `p:${r.id as string}`,
      total_due: null,
      id: r.id as string,
      full_name: (r.full_name as string) ?? '',
      email: (r.email as string) ?? '',
      phone: (r.phone as string) ?? '',
      order_count: Number(r.order_count ?? 0),
      total_spent: r.total_spent === null || r.total_spent === undefined ? null : Number(r.total_spent),
      last_order_at: (r.last_order_at as string | null) ?? null,
      joined_at: r.joined_at as string,
      ...CUSTOMER_DEFAULTS,
      all_orders: Number(r.order_count ?? 0),
    })),
    error: null,
  };
}

export interface CustomerOrderRow {
  id: string;
  order_number: string;
  created_at: string;
  status: string;
  item_count: number;
  total: number | null;
  /** Still due on this order (Batch 30); null when not known. */
  due: number | null;
}

/** One customer's orders by their key (Batch 30, with what is due);
 *  before migration-033, the Batch 25 list for a registered customer. */
export async function fetchCustomerOrders(customer: Pick<CustomerRow, 'key' | 'id'>): Promise<CustomerOrderRow[]> {
  const v2 = await supabase.rpc('admin_customer_orders_v2', { p_customer_key: customer.key });
  if (!v2.error) {
    return ((v2.data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      order_number: r.order_number as string,
      created_at: r.created_at as string,
      status: r.status as string,
      item_count: Number(r.item_count ?? 0),
      total: r.total === null || r.total === undefined ? null : Number(r.total),
      due: r.due === null || r.due === undefined ? null : Number(r.due),
    }));
  }
  if (!customer.id) return [];
  const { data, error } = await supabase.rpc('admin_customer_orders', { p_customer_id: customer.id });
  if (error) {
    console.error('admin_customer_orders failed:', error.message);
    return [];
  }
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    order_number: r.order_number as string,
    created_at: r.created_at as string,
    status: r.status as string,
    item_count: Number(r.item_count ?? 0),
    total: r.total === null || r.total === undefined ? null : Number(r.total),
    due: null,
  }));
}

/** Items per order for the Orders list (one call). Empty map until
 *  migration-031 is run. */
export async function fetchOrderItemCounts(): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc('admin_order_item_counts');
  const map = new Map<string, number>();
  if (error) return map;
  for (const row of (data ?? []) as { order_id: string; item_count: number | string }[]) {
    map.set(row.order_id, Number(row.item_count));
  }
  return map;
}

/* ---------- Staff-only order notes (Batch 25 Part 7) ---------- */

export interface OrderPrivateData {
  adminNote: string | null;
  /** history row id → its internal note / team username. */
  history: Map<string, { note: string | null; username: string | null }>;
}

/**
 * The admin note and the internal history notes of one order. They live in
 * tables only staff can read; a customer's own order rows no longer hold
 * them. Returns null when migration-031 hasn't been run (the old columns
 * are then still the source).
 */
export async function fetchOrderPrivate(orderId: string): Promise<OrderPrivateData | null> {
  const [noteRes, historyRes] = await Promise.all([
    supabase.from('order_private_notes').select('admin_note').eq('order_id', orderId).maybeSingle(),
    supabase.from('order_history_private').select('history_id, note, changed_by_username').eq('order_id', orderId),
  ]);
  if (noteRes.error || historyRes.error) return null;
  const history = new Map<string, { note: string | null; username: string | null }>();
  for (const row of (historyRes.data ?? []) as { history_id: string; note: string | null; changed_by_username: string | null }[]) {
    history.set(row.history_id, { note: row.note, username: row.changed_by_username });
  }
  return { adminNote: (noteRes.data as { admin_note: string | null } | null)?.admin_note ?? null, history };
}

/** "2h ago", "yesterday", "3 Oct" — for "updated by naeem · 2h ago". */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' });
}

/**
 * The admin's view of one order: the order as the database returns it,
 * with the staff-only admin note and internal history notes merged back in
 * (migration-031 keeps them out of the rows a customer can read). Before
 * that migration the old columns still hold them, so they are kept as-is.
 */
export async function fetchAdminOrderDetail(orderId: string): Promise<OrderWithDetails | null> {
  const [order, priv] = await Promise.all([fetchOrderDetail(orderId), fetchOrderPrivate(orderId)]);
  if (!order || !priv) return order;
  return {
    ...order,
    admin_note: priv.adminNote ?? order.admin_note,
    history: order.history.map((row) => {
      const extra = priv.history.get(row.id);
      return extra
        ? { ...row, note: extra.note ?? row.note, changed_by_username: extra.username ?? row.changed_by_username }
        : row;
    }),
  };
}

/** Batch 32 Part 3: the order behind /admin/orders/:orderNumber/edit. */
export async function fetchOrderIdByNumber(orderNumber: string): Promise<string | null> {
  const { data, error } = await supabase.from('orders').select('id').eq('order_number', orderNumber).maybeSingle();
  if (error || !data) return null;
  return (data as { id: string }).id;
}
