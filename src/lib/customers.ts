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

/** Matches by phone (any way it was typed) or name. Null = not available.
 *  Batch 32: admin_find_customers_v2 leaves hidden customers out and adds
 *  customers added by hand; before migration-035, the Batch 30 search. */
export async function findCustomers(query: string): Promise<CustomerSearchResult[] | null> {
  const v2 = await supabase.rpc('admin_find_customers_v2', { p_query: query });
  const { data, error } =
    v2.error?.code === FUNCTION_NOT_FOUND ? await supabase.rpc('admin_find_customers', { p_query: query }) : v2;
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

/* ---------- Batch 32 Part 4: add / hide / delete (migration-035) ---------- */

export interface NewCustomerInput {
  fullName: string;
  phone: string;
  altPhone: string;
  division: string;
  district: string;
  thana: string;
  addressLine: string;
  note: string;
}

const NEEDS_UPDATE = 'This needs the Batch 32 database update (migration-035).';

/** Adds a customer. When the phone already belongs to someone, nothing is
 *  added and their key comes back with existed = true. */
export async function addCustomer(
  input: NewCustomerInput
): Promise<{ key: string | null; existed: boolean; error: string | null }> {
  const { data, error } = await supabase.rpc('admin_add_customer', {
    p_full_name: input.fullName.trim(),
    p_phone: input.phone.trim(),
    p_alt_phone: input.altPhone.trim() || null,
    p_division: input.division,
    p_district: input.district,
    p_thana: input.thana,
    p_address_line: input.addressLine.trim(),
    p_note: input.note.trim() || null,
  });
  if (error) {
    return { key: null, existed: false, error: error.code === FUNCTION_NOT_FOUND ? NEEDS_UPDATE : error.message };
  }
  const row = (data as { customer_key: string; existed: boolean }[] | null)?.[0];
  if (!row) return { key: null, existed: false, error: 'Could not add this customer.' };
  return { key: row.customer_key, existed: row.existed, error: null };
}

export async function setCustomerHidden(key: string, hidden: boolean): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_set_customer_hidden', { p_customer_key: key, p_hidden: hidden });
  if (!error) return { error: null };
  return { error: error.code === FUNCTION_NOT_FOUND ? NEEDS_UPDATE : error.message };
}

export async function deleteCustomer(key: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_delete_customer', { p_customer_key: key });
  if (!error) return { error: null };
  return { error: error.code === FUNCTION_NOT_FOUND ? NEEDS_UPDATE : error.message };
}
