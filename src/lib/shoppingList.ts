import { supabase } from './supabase';

/**
 * Batch 51 Part 3: Admin → Shopping list — what Naeem must buy in the
 * market for open orders (pending / confirmed / shipped). The database
 * works it out (admin_shopping_list): with Inventory mode On from the open
 * "sold without stock" rows (a new lot that covers them fills them), with
 * Inventory mode Off from the units not taken from the stock number less
 * any stock that has come in since.
 */
export interface ShoppingOrderRef {
  id: string;
  number: string;
}

export interface ShoppingRow {
  productId: string;
  variantId: string | null;
  productName: string;
  optionLabel: string | null;
  /** Packs to buy. */
  qty: number;
  /** 'ml' / 'g' / 'pcs' when the product is counted in loose units. */
  unit: string | null;
  orders: ShoppingOrderRef[];
}

export type ShoppingLoad = { kind: 'ready'; rows: ShoppingRow[] } | { kind: 'no-db' } | { kind: 'error'; message: string };

export interface RawShoppingRow {
  product_id: string;
  variant_id: string | null;
  product_name: string | null;
  option_label: string | null;
  qty: number | string | null;
  unit: string | null;
  orders: { id: string; number: string }[] | null;
}

function orderNumberValue(n: string): number {
  const digits = n.match(/\d+/g);
  return digits ? Number(digits[digits.length - 1]) : 0;
}

export function toShoppingRows(raw: readonly RawShoppingRow[]): ShoppingRow[] {
  return raw
    .map((r) => ({
      productId: r.product_id,
      variantId: r.variant_id ?? null,
      productName: (r.product_name ?? '').trim() || 'Product',
      optionLabel: (r.option_label ?? '').trim() || null,
      qty: Math.max(0, Math.round(Number(r.qty ?? 0))),
      unit: r.unit ?? null,
      orders: [...(r.orders ?? [])]
        .filter((o) => typeof o?.id === 'string')
        .sort((a, b) => orderNumberValue(a.number) - orderNumberValue(b.number)),
    }))
    .filter((r) => r.qty > 0)
    .sort((a, b) => a.productName.localeCompare(b.productName) || (a.optionLabel ?? '').localeCompare(b.optionLabel ?? ''));
}

/** "N items to buy" (one per product option) and the units they add up to. */
export function shoppingTotals(rows: readonly ShoppingRow[]): { items: number; units: number } {
  return { items: rows.length, units: rows.reduce((sum, r) => sum + r.qty, 0) };
}

/** The function isn't there yet — migration-052 not run. */
function isMissing(error: { code?: string; message?: string }): boolean {
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    /could not find the function|does not exist|schema cache/i.test(error.message ?? '')
  );
}

export async function fetchShoppingList(): Promise<ShoppingLoad> {
  const { data, error } = await supabase.rpc('admin_shopping_list');
  if (error) return isMissing(error) ? { kind: 'no-db' } : { kind: 'error', message: error.message };
  return { kind: 'ready', rows: toShoppingRows((data ?? []) as RawShoppingRow[]) };
}

/** "Thursday, 19 November 2026" in Dhaka time (the PDF's date line). */
export function shoppingDateLabel(now: Date = new Date()): string {
  return now.toLocaleDateString('en-GB', {
    timeZone: 'Asia/Dhaka',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** One row's name for the list and the PDF: "Product — AU · 30 ml". */
export function shoppingRowName(row: Pick<ShoppingRow, 'productName' | 'optionLabel'>): string {
  return row.optionLabel ? `${row.productName} — ${row.optionLabel}` : row.productName;
}
