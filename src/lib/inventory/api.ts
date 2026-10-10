import { supabase } from '../supabase';
import { isMissingSchema, type LoadState } from '../payouts';
import type { LotDetail, LotSavePayload, LotSummary, StockMovement, StockUnit } from './types';

/**
 * Batch 38: the Inventory screens' database calls. Every read is refused by
 * the database (RLS / the function itself) for anyone without "View profit
 * & costs"; every write is a SECURITY DEFINER function that checks it again.
 */

export interface Answer<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function message(error: { message?: string } | null): string {
  return error?.message?.trim() || 'Something went wrong. Please try again.';
}

function fail<T>(error: { code?: string; message?: string }): LoadState<T> {
  return isMissingSchema(error) ? { kind: 'no-db' } : { kind: 'error', message: message(error) };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined || v === '' ? null : num(v);
}

export async function fetchStockUnits(): Promise<LoadState<StockUnit[]>> {
  const { data, error } = await supabase.rpc('inventory_stock_units');
  if (error) return fail(error);
  const rows = (data ?? []) as StockUnit[];
  return {
    kind: 'ready',
    data: rows.map((r) => ({
      ...r,
      weight_grams: numOrNull(r.weight_grams),
      site_stock: r.site_stock === null ? null : num(r.site_stock),
      selling_price: num(r.selling_price),
      lot_pieces_left: num(r.lot_pieces_left),
      lot_rows: num(r.lot_rows),
    })),
  };
}

const LOT_COLUMNS =
  'id, code, kind, source_type, country, supplier, lot_date, currency, exchange_rate, costs_pending, notes, opening_weight_percent, opening_weight_added_bdt, created_by_username, created_at, updated_at';

export async function fetchLots(): Promise<LoadState<LotSummary[]>> {
  const { data, error } = await supabase
    .from('lots')
    .select(`${LOT_COLUMNS}, lot_items(qty, qty_remaining, unit_price_bdt, alloc_weight_paisa, alloc_other_paisa, product_id, variant_id)`)
    .order('lot_date', { ascending: false })
    .order('code', { ascending: false });
  if (error) return fail(error);
  return { kind: 'ready', data: (data ?? []) as unknown as LotSummary[] };
}

export async function fetchLot(id: string): Promise<LoadState<LotDetail | null>> {
  const { data, error } = await supabase
    .from('lots')
    .select(`${LOT_COLUMNS}, lot_items(*), lot_costs(*)`)
    .eq('id', id)
    .maybeSingle();
  if (error) return fail(error);
  if (!data) return { kind: 'ready', data: null };
  const lot = data as unknown as LotDetail;
  lot.lot_items = [...lot.lot_items].sort((a, b) => a.sort_order - b.sort_order);
  lot.lot_costs = [...lot.lot_costs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { kind: 'ready', data: lot };
}

export async function fetchMovements(itemIds: readonly string[]): Promise<StockMovement[]> {
  if (itemIds.length === 0) return [];
  const { data } = await supabase
    .from('stock_movements')
    .select('id, lot_item_id, movement_type, qty, reference, reason, created_at')
    .in('lot_item_id', itemIds as string[])
    .order('created_at', { ascending: true });
  return (data ?? []) as StockMovement[];
}

export async function fetchOpeningLotId(): Promise<string | null> {
  const { data } = await supabase.from('lots').select('id').eq('kind', 'opening').maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export async function saveLot(payload: LotSavePayload): Promise<Answer<string>> {
  const { data, error } = await supabase.rpc('inventory_save_lot', { p_lot: payload });
  if (error) return { ok: false, error: message(error) };
  return { ok: true, data: data as string };
}

export async function deleteLot(id: string): Promise<Answer<null>> {
  const { error } = await supabase.rpc('inventory_delete_lot', { p_lot_id: id });
  return error ? { ok: false, error: message(error) } : { ok: true, data: null };
}

export async function setWeight(productId: string, variantId: string | null, grams: number | null): Promise<Answer<number | null>> {
  const { data, error } = await supabase.rpc('inventory_set_weight', {
    p_product_id: productId,
    p_variant_id: variantId,
    p_grams: grams,
  });
  if (error) return { ok: false, error: message(error) };
  return { ok: true, data: numOrNull(data) };
}

export async function logOpeningUpload(fileName: string, rows: number, ready: number, toFix: number): Promise<void> {
  await supabase.rpc('inventory_log_opening_upload', {
    p_file_name: fileName,
    p_rows: rows,
    p_ready: ready,
    p_to_fix: toFix,
  });
}

export async function confirmOpening(
  lotDate: string,
  weightPercent: string,
  rows: Record<string, string | number | null>[],
  fileName: string
): Promise<Answer<string>> {
  const { data, error } = await supabase.rpc('inventory_confirm_opening', {
    p_lot_date: lotDate,
    p_weight_percent: weightPercent,
    p_rows: rows,
    p_file_name: fileName,
  });
  if (error) return { ok: false, error: message(error) };
  return { ok: true, data: data as string };
}

export async function undoOpening(): Promise<Answer<null>> {
  const { error } = await supabase.rpc('inventory_undo_opening');
  return error ? { ok: false, error: message(error) } : { ok: true, data: null };
}

/* ------------------------------------------------------------ helpers */

/** Today in Dhaka, "YYYY-MM-DD". */
export function dhakaToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
}

/** "Mar 2027" from "2027-03-31". */
export function monthYear(date: string | null): string {
  if (!date) return '—';
  const [y, m] = date.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

/** Totals of a lot from its rows: pieces, pieces left, buy value and the
 *  bills shared out (paisa). */
export function lotTotals(items: LotSummary['lot_items']): {
  products: number;
  pieces: number;
  left: number;
  buyPaisa: number;
  costsPaisa: number;
  landedPaisa: number;
} {
  const products = new Set(items.map((i) => `${i.product_id}:${i.variant_id ?? ''}`)).size;
  let pieces = 0;
  let left = 0;
  let buyPaisa = 0;
  let costsPaisa = 0;
  for (const item of items) {
    pieces += num(item.qty);
    left += num(item.qty_remaining);
    buyPaisa += Math.round(num(item.qty) * num(item.unit_price_bdt) * 100);
    costsPaisa += num(item.alloc_weight_paisa) + num(item.alloc_other_paisa);
  }
  return { products, pieces, left, buyPaisa, costsPaisa, landedPaisa: buyPaisa + costsPaisa };
}

export function unitName(unit: Pick<StockUnit, 'product_name' | 'option_label'>): string {
  return unit.option_label ? `${unit.product_name} — ${unit.option_label}` : unit.product_name;
}
