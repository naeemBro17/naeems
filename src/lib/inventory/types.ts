/** The Inventory tables: Batch 38 (migration-040) and Batch 39 (migration-042). */

export type LotKind = 'purchase' | 'opening';
export type LotSourceType = 'import' | 'wholesale' | 'local';
export type CostType = 'weight' | 'other';
export type WeightSource = 'estimated' | 'manual';
export type MovementType = 'opening' | 'purchase' | 'sale' | 'cancel' | 'return' | 'adjustment';

export const LOT_CURRENCIES = ['BDT', 'AUD', 'USD', 'CAD', 'JPY', 'KRW', 'INR', 'GBP'] as const;
export type LotCurrency = (typeof LOT_CURRENCIES)[number];

/** Batch 39: how a product is counted in stock. */
export const STOCK_UNITS = ['pcs', 'ml', 'g'] as const;
export type StockUnitWord = (typeof STOCK_UNITS)[number];
/** A lot row was typed in whole packs or in loose units. */
export type EntryUnit = 'pack' | 'unit';

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
  /** Units left in lots (pieces when the pack size is 1). */
  lot_pieces_left: number;
  lot_rows: number;
  stock_unit: StockUnitWord;
  pack_size: number;
  /** Landed cost per unit of the newest lot with this product (0 if none). */
  latest_unit_cost: number;
}

export interface Lot {
  id: string;
  code: string;
  kind: LotKind;
  source_type: LotSourceType | null;
  country: string;
  supplier: string;
  supplier_id: string | null;
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
  /** Batch 39: qty and qty_remaining are UNITS; the row was typed in packs
   *  or units; unit_price_foreign is per what was typed (the opening lot:
   *  per pack). buy_value_bdt is the row's exact buy value. */
  entry_unit: EntryUnit;
  pack_size: number;
  buy_value_bdt: number;
  weight_guessed: boolean;
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
  lot_items: (Pick<LotItem, 'qty' | 'qty_remaining' | 'unit_price_bdt' | 'alloc_weight_paisa' | 'alloc_other_paisa' | 'product_id' | 'variant_id'> & {
    buy_value_bdt?: number;
  })[];
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
  supplier_id: string | null;
  lot_date: string;
  currency: LotCurrency;
  exchange_rate: string;
  costs_pending: boolean;
  notes: string;
  items: {
    id?: string;
    product_id: string;
    variant_id: string | null;
    /** Packs or units, as typed (entry_unit). */
    qty: number;
    entry_unit: EntryUnit;
    unit_price_foreign: string;
    weight_grams: string | null;
    expiry_date: string | null;
    save_weight_to_product: boolean;
  }[];
  costs: { id?: string; cost_type: CostType; amount_bdt: string; cost_date: string | null; note: string }[];
}

export interface Supplier {
  id: string;
  name: string;
  country: string;
  note: string;
}

/** Batch 39: "Sold without stock" (inventory_shortfall_list). */
export interface Shortfall {
  id: string;
  order_id: string;
  order_number: string;
  label: string;
  units: number;
  stock_unit: StockUnitWord;
  provisional_unit_cost: number;
  status: 'open' | 'filled';
  real_unit_cost: number | null;
  filled_lot_code: string | null;
  created_at: string;
  filled_at: string | null;
}

/** Batch 39: one order's profit (order_profit). */
export interface OrderProfit {
  status: string;
  /** false = delivered before Inventory mode: no lot cost. */
  costed: boolean;
  sale: number;
  cost: number;
  /** Part of cost that is provisional (sold without stock, not filled). */
  provisional: number;
  delivery: number;
  courier: number;
  courier_known: boolean;
  courier_charge: number;
  cod_fee: number;
  profit: number;
  margin: number | null;
  counted_at: string | null;
  filled_adjustments: number;
}

export interface SalesProfitOrder {
  order_id: string;
  order_number: string;
  status: string;
  counted_at: string;
  sale: number;
  cost: number;
  provisional: number;
  delivery: number;
  courier: number;
  courier_known: boolean;
  costed: boolean;
  profit: number;
  margin: number | null;
}

export interface SalesProfitProduct {
  product_id: string;
  variant_id: string | null;
  label: string;
  units: number;
  stock_unit: StockUnitWord;
  pack_size: number;
  sales: number;
  cost: number;
  profit: number;
  margin: number | null;
}

export interface SalesProfitAdjustment {
  date: string;
  amount: number;
  reason: 'late_bill' | 'shortfall_filled' | 'given_back';
  note: string;
}

/** Batch 39: inventory_sales_profit(from, to). */
export interface SalesProfit {
  from: string;
  to: string;
  totals: {
    orders: number;
    uncosted_orders: number;
    sales: number;
    cost: number;
    provisional: number;
    delivery: number;
    courier: number;
    adjustments: number;
    profit: number;
    margin: number | null;
  };
  orders: SalesProfitOrder[];
  products: SalesProfitProduct[];
  adjustments: SalesProfitAdjustment[];
}

/** Batch 39: inventory_mode_check(). */
export interface ModeCheck {
  mode_on: boolean;
  opening_confirmed: boolean;
  open_orders: { order_number: string; status: string; units: number }[];
}
