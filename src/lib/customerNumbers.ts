import type { CustomerRow } from './adminData';
import { bdPhoneKey, looksLikePhone, phoneSearchCore } from './phone';

/**
 * Batch 55: one customer, many numbers. Pure helpers shared by the
 * customer page (PHONE NUMBERS), Merge old data ("The numbers are
 * different") and Merge with another customer, and by the unit tests.
 */

/** "01977123456", "+880 1977-123456" → "01977 123456" (5 + 6 digits). Any
 *  other text is shown as it was typed. */
export function phoneText(raw: string | null | undefined): string {
  const key = bdPhoneKey(raw);
  if (key && /^01\d{9}$/.test(key)) return `${key.slice(0, 5)} ${key.slice(5)}`;
  return (raw ?? '').trim();
}

/** A valid Bangladeshi mobile number as the database keys it, or null
 *  (the same rule as admin_add_customer). */
export function mobileKey(raw: string): string | null {
  const key = bdPhoneKey(raw);
  return key && /^01[3-9]\d{8}$/.test(key) ? key : null;
}

export type NumberSource = 'added' | 'kaarbar' | 'merge';

export interface CustomerNumber {
  phone: string;
  phone_key: string;
  is_main: boolean;
  source: NumberSource | null;
  orders: number;
  bills: number;
  money_rows: number;
  can_remove: boolean;
}

/** The grey line under each number. */
export function numberLabel(n: Pick<CustomerNumber, 'is_main' | 'source'>): string {
  if (n.is_main) return 'Main number · used for delivery';
  if (n.source === 'kaarbar') return 'Old number · saved from Kaarbar';
  if (n.source === 'merge') return 'Old number · from a merged customer';
  return 'Other number';
}

/** Who already has a number (admin_add_customer_number said no). */
export interface NumberOwner {
  key: string;
  name: string;
  orders: number;
}

export type AddNumberResult = { kind: 'added' } | { kind: 'same' } | { kind: 'owner'; owner: NumberOwner };

/* ---------------------------------------------- merge with another customer */

export interface JoinCandidate {
  key: string;
  name: string;
  phone: string;
  orders: number;
  /** Due on orders + previous balance. */
  due: number;
  /** Why it can't be picked (null = it can). */
  reason: string | null;
}

export const JOIN_LIMIT = 20;
export const REASON_LOGIN = 'Has a login. Open it and merge this customer into it.';
export const REASON_NO_PHONE = "No phone number, so it can't be merged.";

/** Why a customer can't be merged into another one (null = it can). The
 *  database refuses the same two cases (admin_merge_customers). */
export function joinReason(row: Pick<CustomerRow, 'id' | 'phone'>): string | null {
  if (row.id !== null) return REASON_LOGIN;
  if (bdPhoneKey(row.phone) === null) return REASON_NO_PHONE;
  return null;
}

export function customerName(row: Pick<CustomerRow, 'full_name' | 'phone' | 'email'>): string {
  return row.full_name.trim() || row.email || phoneText(row.phone) || 'No name';
}

/**
 * The search on "Merge with another customer": name or number, never the
 * customer the page is for, at most 20. `previous` holds each customer's
 * previous balance (by key) for the due shown.
 */
export function joinCandidates(
  rows: readonly CustomerRow[],
  selfKey: string,
  query: string,
  previous: ReadonlyMap<string, number> = new Map()
): JoinCandidate[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const byPhone = looksLikePhone(query);
  const core = phoneSearchCore(query);
  const out: JoinCandidate[] = [];
  for (const r of rows) {
    if (r.key === selfKey) continue;
    const name = customerName(r);
    const hit = byPhone ? (bdPhoneKey(r.phone) ?? '').includes(core) : name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
    if (!hit) continue;
    out.push(toCandidate(r, previous));
    if (out.length >= JOIN_LIMIT) break;
  }
  return out;
}

export function toCandidate(r: CustomerRow, previous: ReadonlyMap<string, number> = new Map()): JoinCandidate {
  return {
    key: r.key,
    name: customerName(r),
    phone: r.phone,
    orders: r.order_count,
    due: Math.round(((r.total_due ?? 0) + (previous.get(r.key) ?? 0)) * 100) / 100,
    reason: joinReason(r),
  };
}

/** The round letter in front of a name. */
export function initial(name: string): string {
  const first = name.trim().charAt(0);
  return first === '' ? '?' : first.toUpperCase();
}
