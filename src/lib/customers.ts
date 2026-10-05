import { supabase } from './supabase';

/* Batch 30 Part 4 — customers grouped by phone number (registered or not),
   the New order customer search, and what each customer still owes. All
   through database functions in migration-033; every one returns null
   before it is run, so the screens fall back to their Batch 25 behaviour. */

export interface CustomerSearchResult {
  /** "p:<profile id>" for a registered customer, "ph:<phone>" otherwise. */
  key: string;
  profileId: string | null;
  fullName: string;
  phone: string;
  altPhone: string | null;
  division: string;
  district: string;
  thana: string;
  addressLine: string;
  orderCount: number;
  /** Null without permission to see money. */
  totalDue: number | null;
}

const FUNCTION_NOT_FOUND = 'PGRST202';

/** Matches by phone (any way it was typed) or name. Null = not available. */
export async function findCustomers(query: string): Promise<CustomerSearchResult[] | null> {
  const { data, error } = await supabase.rpc('admin_find_customers', { p_query: query });
  if (error) return error.code === FUNCTION_NOT_FOUND ? null : [];
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    key: r.customer_key as string,
    profileId: (r.profile_id as string | null) ?? null,
    fullName: (r.full_name as string) ?? '',
    phone: (r.phone as string) ?? '',
    altPhone: (r.alt_phone as string | null) ?? null,
    division: (r.division as string) ?? '',
    district: (r.district as string) ?? '',
    thana: (r.thana as string) ?? '',
    addressLine: (r.address_line as string) ?? '',
    orderCount: Number(r.order_count ?? 0),
    totalDue: r.total_due === null || r.total_due === undefined ? null : Number(r.total_due),
  }));
}

/** Links a new manual order to the registered customer Naeem picked —
 *  admin only, never visible in that customer's own My Orders. */
export async function linkOrderCustomer(orderId: string, profileId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_link_order_customer', { p_order_id: orderId, p_profile_id: profileId });
  return { error: error?.message ?? null };
}
