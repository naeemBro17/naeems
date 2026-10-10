import { supabase } from '../supabase';
import { isMissingSchema, type LoadState } from '../payouts';
import type {
  LotDetail,
  LotSavePayload,
  LotSummary,
  ModeCheck,
  OrderProfit,
  SalesProfit,
  Shortfall,
  StockMovement,
  StockUnit,
  StockUnitWord,
  Supplier,
} from './types';

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
      pack_size: Math.max(1, num(r.pack_size)),
      latest_unit_cost: num(r.latest_unit_cost),
    })),
  };
}

const LOT_COLUMNS =
  'id, code, kind, source_type, country, supplier, supplier_id, lot_date, currency, exchange_rate, costs_pending, notes, opening_weight_percent, opening_weight_added_bdt, created_by_username, created_at, updated_at';

export async function fetchLots(): Promise<LoadState<LotSummary[]>> {
  const { data, error } = await supabase
    .from('lots')
    .select(`${LOT_COLUMNS}, lot_items(qty, qty_remaining, unit_price_bdt, buy_value_bdt, alloc_weight_paisa, alloc_other_paisa, product_id, variant_id)`)
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

/* ------------------------------------------------- Batch 39: units, sales */

export async function fetchSuppliers(): Promise<Supplier[]> {
  const { data } = await supabase.from('suppliers').select('id, name, country, note').order('name');
  return (data ?? []) as Supplier[];
}

export async function saveSupplier(name: string, country: string): Promise<Answer<string>> {
  const { data, error } = await supabase.rpc('inventory_save_supplier', { p_name: name, p_country: country, p_note: '' });
  if (error) return { ok: false, error: message(error) };
  return { ok: true, data: data as string };
}

export interface PackUnit {
  product_id: string;
  variant_id: string | null;
  stock_unit: StockUnitWord;
  pack_size: number;
}

/** Stock unit and pack size of every product / option (staff only). */
export async function fetchPackUnits(): Promise<Map<string, PackUnit>> {
  const { data, error } = await supabase.rpc('inventory_pack_units');
  const map = new Map<string, PackUnit>();
  if (error || !data) return map;
  for (const row of data as PackUnit[]) {
    map.set(packKey(row.product_id, row.variant_id), { ...row, pack_size: Math.max(1, num(row.pack_size)) });
  }
  return map;
}

export function packKey(productId: string, variantId: string | null): string {
  return `${productId}:${variantId ?? ''}`;
}

export async function setPack(productId: string, variantId: string | null, unit: StockUnitWord, packSize: number): Promise<Answer<null>> {
  const { error } = await supabase.rpc('inventory_set_pack', {
    p_product_id: productId,
    p_variant_id: variantId,
    p_unit: unit,
    p_pack_size: packSize,
  });
  return error ? { ok: false, error: message(error) } : { ok: true, data: null };
}

export async function fetchShortfalls(): Promise<LoadState<Shortfall[]>> {
  const { data, error } = await supabase.rpc('inventory_shortfall_list');
  if (error) return fail(error);
  return {
    kind: 'ready',
    data: ((data ?? []) as Shortfall[]).map((r) => ({
      ...r,
      units: num(r.units),
      provisional_unit_cost: num(r.provisional_unit_cost),
      real_unit_cost: numOrNull(r.real_unit_cost),
    })),
  };
}

function numbers<T extends object>(row: T, keys: readonly (keyof T)[]): T {
  const out = { ...row };
  for (const key of keys) {
    const value = out[key];
    if (value !== null && value !== undefined) (out as Record<keyof T, unknown>)[key] = num(value);
  }
  return out;
}

export async function fetchOrderProfit(orderId: string): Promise<LoadState<OrderProfit>> {
  const { data, error } = await supabase.rpc('order_profit', { p_order_id: orderId });
  if (error) return fail(error);
  return {
    kind: 'ready',
    data: numbers(data as OrderProfit, ['sale', 'cost', 'provisional', 'delivery', 'courier', 'courier_charge', 'cod_fee', 'profit', 'margin', 'filled_adjustments']),
  };
}

export async function fetchSalesProfit(from: string, to: string): Promise<LoadState<SalesProfit>> {
  const { data, error } = await supabase.rpc('inventory_sales_profit', { p_from: from, p_to: to });
  if (error) return fail(error);
  const raw = data as SalesProfit;
  return {
    kind: 'ready',
    data: {
      ...raw,
      totals: numbers(raw.totals, ['orders', 'uncosted_orders', 'sales', 'cost', 'provisional', 'delivery', 'courier', 'adjustments', 'profit', 'margin']),
      orders: raw.orders.map((o) => numbers(o, ['sale', 'cost', 'provisional', 'delivery', 'courier', 'profit', 'margin'])),
      products: raw.products.map((p) => numbers(p, ['units', 'pack_size', 'sales', 'cost', 'profit', 'margin'])),
      adjustments: raw.adjustments.map((a) => numbers(a, ['amount'])),
    },
  };
}

export async function fetchModeCheck(): Promise<LoadState<ModeCheck>> {
  const { data, error } = await supabase.rpc('inventory_mode_check');
  if (error) return fail(error);
  return { kind: 'ready', data: data as ModeCheck };
}

/** Turns Inventory mode On / Off. The caller re-confirms the password
 *  first (a fresh sign-in), which the database checks. */
export async function setInventoryMode(on: boolean, takeOpenOrders: boolean): Promise<Answer<{ open_orders_taken: number }>> {
  const { data, error } = await supabase.rpc('inventory_set_mode', { p_on: on, p_take_open_orders: takeOpenOrders });
  if (error) return { ok: false, error: message(error) };
  return { ok: true, data: data as { open_orders_taken: number } };
}

/** "1050 pcs", "2 × 473 ml" … : units in plain words. Pack size 1 → just the number. */
export function unitsText(units: number, unit: StockUnitWord, packSize: number): string {
  return packSize > 1 ? `${units} ${unit}` : String(units);
}

/** "2 packs + 250 pcs" for units of a product with a pack size. */
export function packsText(units: number, unit: StockUnitWord, packSize: number): string {
  if (packSize <= 1) return String(units);
  const packs = Math.floor(units / packSize);
  const loose = units - packs * packSize;
  const parts = [`${packs} pack${packs === 1 ? '' : 's'}`];
  if (loose > 0) parts.push(`${loose} ${unit}`);
  return parts.join(' + ');
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
    // Batch 39: the row's exact buy value (packs × price per pack).
    buyPaisa += Math.round((item.buy_value_bdt !== undefined && num(item.buy_value_bdt) > 0 ? num(item.buy_value_bdt) : num(item.qty) * num(item.unit_price_bdt)) * 100);
    costsPaisa += num(item.alloc_weight_paisa) + num(item.alloc_other_paisa);
  }
  return { products, pieces, left, buyPaisa, costsPaisa, landedPaisa: buyPaisa + costsPaisa };
}

export function unitName(unit: Pick<StockUnit, 'product_name' | 'option_label'>): string {
  return unit.option_label ? `${unit.product_name} — ${unit.option_label}` : unit.product_name;
}
