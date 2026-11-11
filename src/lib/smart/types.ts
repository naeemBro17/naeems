/* Batch 43: what the smart-helper database calls answer (migration-045). */

/** One lot row with units left and an expiry date (smart_offer_rows). */
export interface OfferRow {
  lot_item_id: string;
  product_id: string;
  variant_id: string | null;
  label: string;
  stock_unit: string;
  pack_size: number;
  lot_code: string;
  lot_date: string;
  expiry_date: string;
  /** Units left in this lot row. */
  units: number;
  /** Units of the same product in rows that sell before this one
   *  (earlier expiry). */
  units_before: number;
  /** Landed cost of one unit. */
  unit_cost: number;
  /** Units sold from lots on orders placed in the last 90 days. */
  units_90: number;
  last_sold: string | null;
  /** Days since the product's first lot, at most 90. */
  history_days: number;
  /** The shop's selling price of one pack (the offer price when lower). */
  price: number;
}

export interface OfferRowsAnswer {
  today: string;
  inventory_mode: boolean;
  rows: OfferRow[];
}

export interface BuyingSupplier {
  id: string;
  name: string;
  country: string;
}

/** One product (or option) ever bought in a purchase lot (smart_buying_rows). */
export interface BuyingRow {
  product_id: string;
  variant_id: string | null;
  label: string;
  stock_unit: string;
  pack_size: number;
  /** The supplier / country of most of its purchase lots. */
  supplier_id: string | null;
  country: string | null;
  /** Units in lots, not counting the ones on the way. */
  units_left: number;
  /** Units in lots marked "costs pending" dated after today. */
  units_on_way: number;
  units_90: number;
  history_days: number;
  last_sold: string | null;
  /** Units sold in the last 120 days (0 → "not moving"). */
  sold_120: number;
  /** Newest landed cost and buy price of one unit. */
  last_unit_cost: number;
  last_buy_unit: number;
  last_bought: string | null;
}

export interface BuyingRowsAnswer {
  today: string;
  inventory_mode: boolean;
  suppliers: BuyingSupplier[];
  countries: string[];
  rows: BuyingRow[];
}

/** One order line sent to smart_below_cost. */
export interface BelowCostLine {
  product_id: string | null;
  variant_id: string | null;
  /** Null = sold in packs; else loose units ('pcs' / 'ml' / 'g'). */
  sold_unit: string | null;
  /** The price of one quantity after the line's discount. */
  price: number;
  quantity: number;
}

/** The answer for one line. cost / loss only with "View profit & costs". */
export interface BelowCostAnswer {
  below: boolean;
  cost: number | null;
  loss: number | null;
}

export interface InvestorStatementInvestor {
  id: string;
  name: string;
  capital_in: number;
  capital_back: number;
  owed: number;
  share_all: number;
  in_range: number;
  back_range: number;
  share_range: number;
}

/** report_investor_statement: one investor, one period. */
export interface InvestorStatement {
  from: string;
  to: string;
  sales: number;
  net_profit: number;
  roi_percent: number | null;
  investor: InvestorStatementInvestor;
  year: number;
  months: { month: string; sales: number; net_profit: number }[];
  start_date: string | null;
}
