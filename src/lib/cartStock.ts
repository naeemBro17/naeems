// Batch 33 Part 3 — "just sold out". A cart never holds stock (the usual
// rule: whoever places the order first gets it). The database refuses an
// order that asks for more than is left; this file reads the live stock for
// every cart line so the cart can be corrected in one go, with a calm
// message, instead of the customer meeting an error.
import { supabase } from './supabase';
import { PRODUCTS_VIEW } from '../contexts/ProductContext';

/** One cart line, as far as stock is concerned. */
export interface StockLine {
  productId: string;
  variantId: string | null;
  quantity: number;
}

/** What the shop can sell of one line right now. */
export interface LiveStock {
  /** Product name for the message. */
  name: string;
  /** Option label ("AU · 340g"), when the line is an option. */
  label: string | null;
  /** Units that can be sold; null = not counted (only "in / out of stock"). */
  available: number | null;
}

/** One line the cart had to change. */
export interface StockChange {
  productId: string;
  variantId: string | null;
  name: string;
  label: string | null;
  /** Units the line now has; 0 = removed (sold out). */
  available: number;
}

export function lineKey(productId: string, variantId: string | null): string {
  return `${productId}:${variantId ?? ''}`;
}

/**
 * The lines that ask for more than is left, with what is left. Same rules
 * as place_order(): a counted stock is the limit; an uncounted product is
 * fine unless marked out of stock; a hidden product or a missing option is
 * sold out.
 */
export function stockChanges(lines: StockLine[], live: Map<string, LiveStock>): StockChange[] {
  const changes: StockChange[] = [];
  for (const line of lines) {
    const stock = live.get(lineKey(line.productId, line.variantId));
    if (!stock || stock.available === null) continue;
    const available = Math.max(0, Math.floor(stock.available));
    if (available < line.quantity) {
      changes.push({
        productId: line.productId,
        variantId: line.variantId,
        name: stock.name,
        label: stock.label,
        available,
      });
    }
  }
  return changes;
}

interface ProductStockRow {
  id: string;
  name: string;
  is_active: boolean;
  stock_quantity: number | null;
  stock_status: string | null;
}

interface VariantStockRow {
  id: string;
  product_id: string;
  region: string | null;
  size: string | null;
  in_stock: boolean;
  stock_quantity: number | null;
}

/** Live stock for the given lines, or null when it could not be read (the
 *  caller then keeps the cart as it is — the database still guards it). */
export async function fetchLiveStock(lines: StockLine[]): Promise<Map<string, LiveStock> | null> {
  if (lines.length === 0) return new Map();
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const variantIds = [...new Set(lines.map((l) => l.variantId).filter((v): v is string => v !== null))];

  const [productRes, variantRes] = await Promise.all([
    supabase
      .from(PRODUCTS_VIEW)
      .select('id, name, is_active, stock_quantity, stock_status')
      .in('id', productIds),
    variantIds.length > 0
      ? supabase
          .from('product_variants_view')
          .select('id, product_id, region, size, in_stock, stock_quantity')
          .in('id', variantIds)
      : Promise.resolve({ data: [] as VariantStockRow[], error: null }),
  ]);
  if (productRes.error || variantRes.error) return null;

  const products = new Map<string, ProductStockRow>();
  for (const row of (productRes.data ?? []) as ProductStockRow[]) products.set(row.id, row);
  const variants = new Map<string, VariantStockRow>();
  for (const row of (variantRes.data ?? []) as VariantStockRow[]) variants.set(row.id, row);

  const live = new Map<string, LiveStock>();
  for (const line of lines) {
    const product = products.get(line.productId);
    const key = lineKey(line.productId, line.variantId);
    if (!product) {
      // Deleted or hidden from the shop: nothing can be sold.
      live.set(key, { name: 'An item', label: null, available: 0 });
      continue;
    }
    if (line.variantId === null) {
      live.set(key, {
        name: product.name,
        label: null,
        available: !product.is_active
          ? 0
          : product.stock_quantity !== null
            ? product.stock_quantity
            : product.stock_status === 'out_of_stock'
              ? 0
              : null,
      });
      continue;
    }
    const variant = variants.get(line.variantId);
    const label = variant
      ? [variant.region, variant.size].map((s) => (s ?? '').trim()).filter(Boolean).join(' · ') || null
      : null;
    live.set(key, {
      name: product.name,
      label,
      available:
        !product.is_active || !variant || variant.product_id !== line.productId
          ? 0
          : variant.stock_quantity !== null
            ? variant.stock_quantity
            : variant.in_stock
              ? null
              : 0,
    });
  }
  return live;
}

/** Reads live stock and returns the lines to change (empty = all fine,
 *  null = could not check). */
export async function checkCartStock(lines: StockLine[]): Promise<StockChange[] | null> {
  const live = await fetchLiveStock(lines);
  return live ? stockChanges(lines, live) : null;
}

/** True when an order was refused because of stock (place_order's own
 *  messages: "Only 1 of … left in stock.", "… is out of stock.", "… is no
 *  longer available."). */
export function isStockError(message: string | null | undefined): boolean {
  return Boolean(message && /left in stock|out of stock|in stock for|no longer available/i.test(message));
}
