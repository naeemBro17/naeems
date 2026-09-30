import { supabase } from './supabase';
import type { ActivityLogEntry, StaffMember, StaffPermission, TeamMember } from '../types';

/**
 * Admin team (Batch 24 Part 1). The permission list, in the order the Team
 * page shows it, with the plain-English switch labels. The database has the
 * same list (staff_permission_names(), migration-030) and refuses anything
 * else.
 */
export const STAFF_PERMISSIONS: { id: StaffPermission; label: string; hint: string }[] = [
  { id: 'view_orders', label: 'View orders', hint: 'See the Orders list and each order.' },
  { id: 'change_order_status', label: 'Change order status', hint: 'Confirm, ship, deliver or cancel; mark paid; tracking number and notes.' },
  { id: 'create_orders', label: 'Create manual orders', hint: 'Type in Facebook / WhatsApp / phone orders, at the normal price.' },
  { id: 'book_steadfast', label: 'Book on Steadfast', hint: 'Send confirmed orders to Steadfast Courier.' },
  { id: 'edit_products', label: 'Edit products and stock', hint: 'Add and edit products, options, photos and stock. Cannot delete products.' },
  { id: 'edit_categories', label: 'Edit categories', hint: 'Add, rename and remove categories.' },
  { id: 'view_customers', label: 'View customers', hint: 'See the wholesaler list and look up customers by phone. Read only.' },
  { id: 'delete_early_orders', label: 'Delete early orders', hint: 'Delete Pending orders, or Cancelled orders never booked on Steadfast.' },
];

/** Order permissions that are useless without "View orders" — switching
 *  one on switches View orders on too (the database does the same). */
export const ORDER_SUB_PERMISSIONS: StaffPermission[] = [
  'change_order_status',
  'create_orders',
  'book_steadfast',
  'delete_early_orders',
];

/** Applies the "order permissions need View orders" rule to a toggle. */
export function togglePermission(current: StaffPermission[], perm: StaffPermission): StaffPermission[] {
  const set = new Set(current);
  if (set.has(perm)) {
    set.delete(perm);
    if (perm === 'view_orders') {
      for (const sub of ORDER_SUB_PERMISSIONS) set.delete(sub);
    }
  } else {
    set.add(perm);
    if (ORDER_SUB_PERMISSIONS.includes(perm)) set.add('view_orders');
  }
  return STAFF_PERMISSIONS.map((p) => p.id).filter((id) => set.has(id));
}

export const USERNAME_PATTERN = /^[a-z0-9._]{3,30}$/;
export const STAFF_PASSWORD_MIN_LENGTH = 8;
const STAFF_EMAIL_DOMAIN = 'staff.naeems.internal';

/** The internal login email a moderator never sees. */
export function staffEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${STAFF_EMAIL_DOMAIN}`;
}

/** The signed-in user's own staff row, or null (not staff, or migration-030
 *  not run yet). */
export async function fetchOwnStaffMember(userId: string): Promise<StaffMember | null> {
  const { data, error } = await supabase
    .from('staff_members')
    .select('id, username, full_name, phone, permissions, is_disabled')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as StaffMember;
}

/** Records a staff login / logout / password change in the Activity Log.
 *  Never blocks the action it describes. */
export async function logStaffEvent(
  action: 'staff.login' | 'staff.logout' | 'staff.password_changed'
): Promise<void> {
  const { error } = await supabase.rpc('log_staff_event', { p_action: action });
  if (error) console.warn('Activity log event not recorded:', error.message);
}

/* ---------- Team page (Super Admin) ---------- */

interface TeamFunctionResponse {
  ok: boolean;
  error?: string;
  userId?: string;
  permissions?: StaffPermission[];
}

async function callTeamFunction(body: Record<string, unknown>): Promise<TeamFunctionResponse> {
  const { data, error } = await supabase.functions.invoke('admin-team', { body });
  if (error) {
    return { ok: false, error: 'Could not reach the server. Please try again.' };
  }
  return data as TeamFunctionResponse;
}

export async function fetchTeam(): Promise<TeamMember[]> {
  const { data, error } = await supabase.rpc('admin_team_list');
  if (error) {
    console.error('admin_team_list failed:', error.message);
    return [];
  }
  return (data ?? []) as TeamMember[];
}

export async function createModerator(input: {
  username: string;
  fullName: string;
  phone: string;
  password: string;
}): Promise<{ error: string | null }> {
  const res = await callTeamFunction({ action: 'create', ...input });
  return { error: res.ok ? null : (res.error ?? 'Could not add the moderator.') };
}

export async function updateModerator(input: {
  userId: string;
  fullName: string;
  phone: string;
  permissions: StaffPermission[];
  disabled: boolean;
}): Promise<{ error: string | null }> {
  const res = await callTeamFunction({ action: 'update', ...input });
  return { error: res.ok ? null : (res.error ?? 'Could not save.') };
}

export async function resetModeratorPassword(userId: string, password: string): Promise<{ error: string | null }> {
  const res = await callTeamFunction({ action: 'reset_password', userId, password });
  return { error: res.ok ? null : (res.error ?? 'Could not reset the password.') };
}

export async function deleteModerator(userId: string): Promise<{ error: string | null }> {
  const res = await callTeamFunction({ action: 'delete', userId });
  return { error: res.ok ? null : (res.error ?? 'Could not delete the moderator.') };
}

/* ---------- Activity Log (Super Admin) ---------- */

export const ACTIVITY_PAGE_SIZE = 30;

/** Action groups for the Activity Log's "type" filter — each matches the
 *  start of the action name the database writes. */
export const ACTIVITY_TYPES: { value: string; label: string }[] = [
  { value: 'order.', label: 'Orders' },
  { value: 'order.status', label: 'Order status changes' },
  { value: 'order.price_changed', label: 'Price edits' },
  { value: 'order.deleted', label: 'Order deletes' },
  { value: 'order.steadfast', label: 'Steadfast' },
  { value: 'product.', label: 'Products and stock' },
  { value: 'category.', label: 'Categories' },
  { value: 'setting', label: 'Settings' },
  { value: 'team.', label: 'Team changes' },
  { value: 'staff.', label: 'Staff logins' },
  { value: 'safety.', label: 'Safety Lock' },
  { value: 'promo_code.', label: 'Promo codes' },
  { value: 'review.', label: 'Reviews' },
  { value: 'wholesaler.', label: 'Wholesalers' },
];

export interface ActivityFilters {
  person: string;
  type: string;
  /** yyyy-mm-dd, Bangladesh date. */
  from: string;
  to: string;
  search: string;
  page: number;
}

/** A Bangladesh-calendar date (yyyy-mm-dd) as the UTC instant its day
 *  starts. Bangladesh is UTC+6 all year (no daylight saving). */
export function dhakaDayStartIso(date: string): string {
  return new Date(`${date}T00:00:00+06:00`).toISOString();
}

export async function fetchActivityLog(
  filters: ActivityFilters
): Promise<{ rows: ActivityLogEntry[]; total: number; error: string | null }> {
  let query = supabase
    .from('activity_log')
    .select('id, created_at, actor_username, action, entity_type, entity_id, entity_label, summary, details', {
      count: 'exact',
    })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  if (filters.person) query = query.eq('actor_username', filters.person);
  if (filters.type) query = query.like('action', `${filters.type}%`);
  if (filters.from) query = query.gte('created_at', dhakaDayStartIso(filters.from));
  if (filters.to) {
    const next = new Date(dhakaDayStartIso(filters.to));
    next.setUTCDate(next.getUTCDate() + 1);
    query = query.lt('created_at', next.toISOString());
  }
  const term = filters.search.trim().replace(/[%,()]/g, '');
  if (term) {
    query = query.or(`entity_label.ilike.%${term}%,summary.ilike.%${term}%`);
  }

  const start = (filters.page - 1) * ACTIVITY_PAGE_SIZE;
  const { data, error, count } = await query.range(start, start + ACTIVITY_PAGE_SIZE - 1);
  if (error) {
    return { rows: [], total: 0, error: 'Could not load the activity log.' };
  }
  return { rows: (data ?? []) as ActivityLogEntry[], total: count ?? 0, error: null };
}

export async function fetchActivityPeople(): Promise<string[]> {
  const { data, error } = await supabase.rpc('admin_activity_people');
  if (error) return [];
  return ((data ?? []) as { username: string }[]).map((r) => r.username);
}

/** Bangladesh time, e.g. "1 Oct 2026, 14:05". */
export function formatDhakaTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ---------- Product "last updated by" ---------- */

export interface ProductEditInfo {
  lastEditedBy: string;
  lastEditedAt: string;
}

export async function fetchProductEditInfo(): Promise<Map<string, ProductEditInfo>> {
  const { data, error } = await supabase.rpc('admin_product_edit_info');
  const map = new Map<string, ProductEditInfo>();
  if (error) return map;
  for (const row of (data ?? []) as { id: string; last_edited_by: string | null; last_edited_at: string | null }[]) {
    if (row.last_edited_by && row.last_edited_at) {
      map.set(row.id, { lastEditedBy: row.last_edited_by, lastEditedAt: row.last_edited_at });
    }
  }
  return map;
}
