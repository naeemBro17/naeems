import { supabase } from './supabase';
import type { AddNumberResult, CustomerNumber, NumberSource } from './customerNumbers';

/**
 * Batch 55: the database calls of extra numbers and Merge two customers
 * (migration-056, Super Admin only). Before migration-056 is run every
 * call answers with NEEDS_CUSTOMER_NUMBERS_UPDATE.
 */

const FUNCTION_NOT_FOUND = 'PGRST202';
export const NEEDS_CUSTOMER_NUMBERS_UPDATE = 'This needs the Batch 55 database update (migration-056).';

export type Answer<T> = { ok: true; data: T } | { ok: false; error: string; needsUpdate: boolean };

async function call<T>(fn: string, args: Record<string, unknown>, map: (raw: unknown) => T): Promise<Answer<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const needsUpdate = error.code === FUNCTION_NOT_FOUND;
    return { ok: false, error: needsUpdate ? NEEDS_CUSTOMER_NUMBERS_UPDATE : error.message?.trim() || 'Something went wrong. Please try again.', needsUpdate };
  }
  return { ok: true, data: map(data) };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function source(v: unknown): NumberSource | null {
  return v === 'added' || v === 'kaarbar' || v === 'merge' ? v : null;
}

export function fetchCustomerNumbers(customerKey: string): Promise<Answer<CustomerNumber[]>> {
  return call('admin_customer_numbers', { p_customer_key: customerKey }, (raw) =>
    (Array.isArray(raw) ? raw : []).map((r): CustomerNumber => {
      const o = obj(r);
      return {
        phone: String(o.phone ?? ''),
        phone_key: String(o.phone_key ?? ''),
        is_main: o.is_main === true,
        source: source(o.source),
        orders: num(o.orders),
        bills: num(o.bills),
        money_rows: num(o.money_rows),
        can_remove: o.can_remove === true,
      };
    })
  );
}

export function addCustomerNumber(customerKey: string, phone: string, from: 'added' | 'kaarbar'): Promise<Answer<AddNumberResult>> {
  return call('admin_add_customer_number', { p_customer_key: customerKey, p_phone: phone, p_source: from }, (raw): AddNumberResult => {
    const o = obj(raw);
    if (o.added === true) return { kind: 'added' };
    if (o.same === true || typeof o.owner_key !== 'string') return { kind: 'same' };
    return { kind: 'owner', owner: { key: o.owner_key, name: String(o.owner_name ?? ''), orders: num(o.owner_orders) } };
  });
}

export function removeCustomerNumber(customerKey: string, phone: string): Promise<Answer<true>> {
  return call('admin_remove_customer_number', { p_customer_key: customerKey, p_phone: phone }, () => true as const);
}

export interface MergeSide {
  orders: number;
  due: number;
  previous: number;
  bills: number;
}

export interface MergePreview {
  keep: MergeSide;
  remove: MergeSide;
  after: { orders: number; due: number };
}

function side(raw: unknown): MergeSide {
  const o = obj(raw);
  return { orders: num(o.orders), due: num(o.due), previous: num(o.previous), bills: num(o.bills) };
}

export function fetchMergePreview(keepKey: string, removeKey: string): Promise<Answer<MergePreview>> {
  return call('admin_merge_preview', { p_keep_key: keepKey, p_remove_key: removeKey }, (raw) => {
    const o = obj(raw);
    const after = obj(o.after);
    return { keep: side(o.keep), remove: side(o.remove), after: { orders: num(after.orders), due: num(after.due) } };
  });
}

export function mergeCustomers(keepKey: string, removeKey: string): Promise<Answer<{ moved: number }>> {
  return call('admin_merge_customers', { p_keep_key: keepKey, p_remove_key: removeKey }, (raw) => ({ moved: num(obj(raw).moved) }));
}
