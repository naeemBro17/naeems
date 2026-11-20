import { supabase } from '../supabase';
import type { LastImport } from './api';
import type { MergeBillRow, MergeItemRow } from './merge';
import type { BillImportRow, ItemSaveRow, SavedItem, SiteChoice } from './oldSales';

/**
 * Batch 50: the database calls of Step 1 (Old products) and Step 2 (Old
 * sales) — migration-051. Super Admin only; saving, importing and undoing
 * also need the password typed in the last 5 minutes. Before migration-051
 * is run every call answers "needs-update".
 */

const FUNCTION_NOT_FOUND = 'PGRST202';
export const NEEDS_OLD_SALES_UPDATE = 'This needs the Batch 50 database update (migration-051).';

export type Answer<T> = { ok: true; data: T } | { ok: false; error: string; needsUpdate: boolean };

async function call<T>(fn: string, args: Record<string, unknown>, map: (raw: unknown) => T): Promise<Answer<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const needsUpdate = error.code === FUNCTION_NOT_FOUND;
    return { ok: false, error: needsUpdate ? NEEDS_OLD_SALES_UPDATE : error.message?.trim() || 'Something went wrong. Please try again.', needsUpdate };
  }
  return { ok: true, data: map(data) };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function lastImport(raw: unknown): LastImport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return { id: String(r.id), at: String(r.at), by: (r.by as string | null) ?? null, count: num(r.count), total: num(r.total) };
}

export interface OldSalesStatus {
  cutoff: string;
  items: SavedItem[];
  choices: SiteChoice[];
  billKeys: string[];
  bills: number;
  lockedMonths: string[];
  lastProducts: LastImport | null;
  lastSales: LastImport | null;
}

function unitCosts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = num(v);
  return out;
}

export function fetchOldSalesStatus(): Promise<Answer<OldSalesStatus>> {
  return call('kaarbar_old_sales_status', {}, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      cutoff: String(r.cutoff ?? ''),
      items: ((r.items ?? []) as Record<string, unknown>[]).map((i) => ({
        id: String(i.id),
        key: String(i.name_key),
        name: String(i.kaarbar_name),
        kaarbarPrice: num(i.kaarbar_price),
        productId: (i.product_id as string | null) ?? null,
        variantId: (i.variant_id as string | null) ?? null,
        madeProductId: (i.made_product_id as string | null) ?? null,
        how: i.match_how === 'hand' || i.match_how === 'hidden' ? i.match_how : 'auto',
        costPerPack: num(i.cost_per_pack),
        unitCosts: unitCosts(i.unit_costs),
        billLines: num(i.bill_lines),
      })),
      choices: ((r.choices ?? []) as Record<string, unknown>[]).map((c) => ({
        productId: String(c.product_id),
        variantId: (c.variant_id as string | null) ?? null,
        name: String(c.name ?? ''),
        option: (c.option as string | null) ?? null,
        isActive: c.is_active === true,
        stockUnit: String(c.stock_unit ?? 'pcs'),
        packSize: Math.max(1, num(c.pack_size)),
        costPerPack: c.cost_per_pack === null || c.cost_per_pack === undefined ? null : num(c.cost_per_pack),
        madeByImport: c.made_by_import === true,
      })),
      billKeys: ((r.bill_keys ?? []) as unknown[]).map(String),
      bills: num(r.bills),
      lockedMonths: ((r.locked_months ?? []) as unknown[]).map(String),
      lastProducts: lastImport(r.last_products),
      lastSales: lastImport(r.last_sales),
    };
  });
}

export function saveItems(rows: ItemSaveRow[]): Promise<Answer<{ added: number; updated: number; hiddenMade: number }>> {
  return call('kaarbar_save_items', { p_rows: rows }, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { added: num(r.added), updated: num(r.updated), hiddenMade: num(r.hidden_made) };
  });
}

export function setUnitCosts(rows: { item_id: string; unit: string; cost: number }[]): Promise<Answer<number>> {
  return call('kaarbar_set_unit_costs', { p_rows: rows }, (raw) => num(raw));
}

export interface KeptProduct {
  name: string;
  reason: string;
}

export function removeHiddenProducts(): Promise<Answer<{ removed: number; kept: KeptProduct[] }>> {
  return call('kaarbar_remove_hidden_products', {}, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { removed: num(r.removed), kept: (r.kept ?? []) as KeptProduct[] };
  });
}

export function importSales(bills: BillImportRow[]): Promise<Answer<{ added: number; skipped: number; total: number }>> {
  return call('kaarbar_import_sales', { p_bills: bills }, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { added: num(r.added), skipped: num(r.skipped), total: num(r.total) };
  });
}

export interface KeptBill {
  bill_no: string;
  date: string;
  amount: number;
  reason: string;
}

export function undoSales(): Promise<Answer<{ removed: number; total: number; kept: KeptBill[] }>> {
  return call('kaarbar_undo_sales', {}, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { removed: num(r.removed), total: num(r.total), kept: (r.kept ?? []) as KeptBill[] };
  });
}

/* ------------------------------------------- Batch 54: merge one customer */

export const NEEDS_MERGE_UPDATE = 'This needs the Batch 54 database update (migration-055).';

export interface MergeResult {
  added: number;
  skipped: number;
  total: number;
  hiddenMade: number;
}

/** Saves the items made or changed on the review page, then the bills,
 *  linked to this customer — one call, all or nothing (migration-055). */
export async function mergeCustomer(customerKey: string, phone: string, rows: { items: MergeItemRow[]; bills: MergeBillRow[] }): Promise<Answer<MergeResult>> {
  const answer = await call('kaarbar_merge_customer', { p_customer_key: customerKey, p_items: rows.items, p_bills: rows.bills, p_phone: phone || null }, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { added: num(r.added), skipped: num(r.skipped), total: num(r.total), hiddenMade: num(r.hidden_made) };
  });
  return !answer.ok && answer.needsUpdate ? { ...answer, error: NEEDS_MERGE_UPDATE } : answer;
}

export async function undoCustomerMerge(customerKey: string): Promise<Answer<{ removed: number; total: number; kept: KeptBill[] }>> {
  const answer = await call('kaarbar_undo_customer_merge', { p_customer_key: customerKey }, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { removed: num(r.removed), total: num(r.total), kept: (r.kept ?? []) as KeptBill[] };
  });
  return !answer.ok && answer.needsUpdate ? { ...answer, error: NEEDS_MERGE_UPDATE } : answer;
}
