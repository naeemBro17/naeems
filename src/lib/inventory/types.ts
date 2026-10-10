/** Batch 38: the Inventory tables (migration-040). */

export type LotKind = 'purchase' | 'opening';
export type LotSourceType = 'import' | 'wholesale' | 'local';
export type CostType = 'weight' | 'other';
export type WeightSource = 'estimated' | 'manual';
export type MovementType = 'opening' | 'purchase' | 'sale' | 'cancel' | 'return' | 'adjustment';

export const LOT_CURRENCIES = ['BDT', 'AUD', 'USD', 'CAD', 'JPY', 'KRW', 'INR', 'GBP'] as const;
export type LotCurrency = (typeof LOT_CURRENCIES)[number];

/** One sellable unit: a product with no options, or one option. */
export interface StockUnit {
  product_id: string;
  variant_id: string | null;
  sku: string;
  product_name: string;
  option_label: string | null;
  is_active: boolean;
  weight_grams: number | null;
  weight_source: WeightSource | null;
  /** The shop's stock number (null = not counted, only in / out of stock). */
  site_stock: number | null;
  in_stock: boolean;
  selling_price: number;
  lot_pieces_left: number;
  lot_rows: number;
}

export interface Lot {
  id: string;
  code: string;
  kind: LotKind;
  source_type: LotSourceType | null;
  country: string;
  supplier: string;
  lot_date: string;
  currency: LotCurrency;
  exchange_rate: number;
  costs_pending: boolean;
  notes: string;
  opening_weight_percent: number | null;
  opening_weight_added_bdt: number | null;
  created_by_username: string;
  created_at: string;
  updated_at: string;
}

export interface LotCost {
  id: string;
  lot_id: string;
  cost_type: CostType;
  amount_bdt: number;
  cost_date: string | null;
  note: string;
  created_at: string;
}

export interface LotItem {
  id: string;
  lot_id: string;
  product_id: string;
  variant_id: string | null;
  sort_order: number;
  qty: number;
  unit_price_foreign: number;
  unit_price_bdt: number;
  weight_grams_used: number | null;
  expiry_date: string | null;
  alloc_weight_paisa: number;
  alloc_other_paisa: number;
  alloc_weight_bdt: number;
  alloc_other_bdt: number;
  landed_unit_cost_bdt: number;
  qty_remaining: number;
  opening_source: 'import' | 'wholesale' | null;
}

export interface StockMovement {
  id: string;
  lot_item_id: string;
  movement_type: MovementType;
  qty: number;
  reference: string | null;
  reason: string | null;
  created_at: string;
}

/** A lot in the list, with what it holds. */
export interface LotSummary extends Lot {
  lot_items: Pick<LotItem, 'qty' | 'qty_remaining' | 'unit_price_bdt' | 'alloc_weight_paisa' | 'alloc_other_paisa' | 'product_id' | 'variant_id'>[];
}

export interface LotDetail extends Lot {
  lot_items: LotItem[];
  lot_costs: LotCost[];
}

/** What the lot form sends to inventory_save_lot(). */
export interface LotSavePayload {
  id?: string;
  source_type: LotSourceType;
  country: string;
  supplier: string;
  lot_date: string;
  currency: LotCurrency;
  exchange_rate: string;
  costs_pending: boolean;
  notes: string;
  items: {
    id?: string;
    product_id: string;
    variant_id: string | null;
    qty: number;
    unit_price_foreign: string;
    weight_grams: string | null;
    expiry_date: string | null;
    save_weight_to_product: boolean;
  }[];
  costs: { id?: string; cost_type: CostType; amount_bdt: string; cost_date: string | null; note: string }[];
}
