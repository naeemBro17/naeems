import type { MoneySummary, ProfitParts } from '../money/types';

/* Batch 42: what the report functions (migration-044) send back. */

export interface CategoryAmount {
  category_id: string;
  name: string;
  amount: number;
}

export interface PnlParts extends ProfitParts {
  gross_profit: number;
}

export interface PnlMonth extends PnlParts {
  month: string;
  expenses_by_category: CategoryAmount[];
  locked: boolean;
}

export interface ProfitLossReport {
  from: string;
  to: string;
  parts: PnlParts;
  expenses_by_category: CategoryAmount[];
  months: PnlMonth[];
  locked_months: string[];
  start_date: string | null;
}

export interface SalesOrderRow {
  order_id: string;
  order_number: string;
  day: string;
  status: string;
  source: string;
  customer_name: string;
  total: number;
  paid: number;
  due: number;
}

export interface SalesReport {
  from: string;
  to: string;
  totals: { entries: number; returned: number; total: number; received: number; unpaid: number };
  by_source: { source: string; entries: number; total: number }[];
  by_day: { day: string; entries: number; total: number }[];
  orders: SalesOrderRow[];
  locked_months: string[];
}

export interface SoldProduct {
  product_id: string;
  variant_id: string | null;
  label: string;
  units: number;
  stock_unit: string;
  pack_size: number;
  sales: number;
  cost: number;
  profit: number;
  margin: number | null;
}

export interface ProductUnit {
  product_id: string;
  variant_id: string | null;
  label: string;
  is_active: boolean;
  stock_unit: string;
  pack_size: number;
  units_left: number;
  stock_value: number;
  sold_60: number;
  last_sold: string | null;
  has_cost: boolean;
}

export interface ProductsReport {
  from: string;
  to: string;
  totals: { sales: number; cost: number; profit: number; orders: number; uncosted_orders: number };
  sold: SoldProduct[];
  units: ProductUnit[];
  locked_months: string[];
}

export interface LotRow {
  lot_id: string;
  code: string;
  kind: 'purchase' | 'opening';
  lot_date: string;
  supplier: string;
  costs_pending: boolean;
  rows: number;
  units_bought: number;
  units_sold: number;
  units_on_orders: number;
  units_removed: number;
  units_found: number;
  units_left: number;
  buy_value: number;
  trip_weight: number;
  trip_other: number;
  landed_total: number;
  left_value: number;
  sales: number;
  cost_sold: number;
  locked: boolean;
}

export interface StockRow {
  lot_item_id: string;
  product_id: string;
  variant_id: string | null;
  label: string;
  stock_unit: string;
  pack_size: number;
  lot_code: string;
  lot_date: string;
  expiry_date: string | null;
  units: number;
  unit_cost: number;
  value: number;
  per_month: number;
  units_before: number;
  sells_in_time: boolean | null;
}

export interface StockReport {
  today: string;
  rows: StockRow[];
  total_value: number;
}

export interface CustomerDueRow {
  customer_key: string;
  name: string;
  phone: string;
  order_due: number;
  previous_left: number;
  total: number;
  d0: number;
  d31: number;
  d61: number;
  oldest_days: number;
}

export interface TopCustomer {
  customer_key: string;
  name: string;
  phone: string;
  bought: number;
  profit: number;
  orders: number;
}

export interface CustomersReport {
  from: string;
  to: string;
  today: string;
  dues: CustomerDueRow[];
  top: TopCustomer[];
}

export interface DayBookLine {
  date: string;
  type: string;
  amount: number;
  balance: number;
  note: string | null;
  reference: string | null;
  category: string | null;
  by: string | null;
  source: string;
  source_id: string;
}

export interface DayBookAccount {
  account_id: string;
  name: string;
  kind: string;
  opening: number;
  money_in: number;
  money_out: number;
  closing: number;
  lines: DayBookLine[];
}

export interface DayBookReport {
  from: string;
  to: string;
  accounts: DayBookAccount[];
  locked_months: string[];
}

export interface InvestorRow {
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

export interface ChartMonth {
  month: string;
  your_profit: number;
  net_profit: number;
  money_in: number;
  money_out: number;
  locked: boolean;
}

export interface ChartsReport {
  from: string;
  to: string;
  months: ChartMonth[];
}

export interface DashboardAttention {
  expiring: number;
  sold_without_stock: number;
  dues_over_30: number;
  dues_over_30_amount: number;
  no_buy_price: number;
  no_weight: number;
  count_planned: number;
  count_done: number;
  count_due: boolean;
  last_month_locked: boolean;
  last_month: string;
}

export interface DashboardData {
  summary: MoneySummary;
  previous: { from: string; to: string; your_profit: number; net_profit: number } | null;
  attention: DashboardAttention;
}

/* ---------------------------------------------------- count and lock */

export type CountWhy = 'never' | 'oldest' | 'value' | 'fast';

export interface CountPlanRow {
  plan_id: string;
  product_id: string;
  variant_id: string | null;
  label: string;
  why: CountWhy;
  stock_unit: string;
  pack_size: number;
  system_units: number;
  last_count: string | null;
  counted: boolean;
  counted_units: number | null;
  difference: number | null;
  counted_date: string | null;
}

export interface CountPlan {
  month: string;
  inventory_mode: boolean;
  rows: CountPlanRow[];
}

export interface CountInput {
  product_id: string;
  variant_id: string | null;
  counted: number;
  note?: string;
}

export interface CountResult {
  count_id: string;
  product_id: string;
  variant_id: string | null;
  label: string;
  system_units: number;
  counted_units: number;
  difference: number;
  write_off_id: string | null;
}

export interface CountHistoryRow {
  id: string;
  count_date: string;
  label: string;
  stock_unit: string;
  system_units: number;
  counted_units: number;
  difference: number;
  planned: boolean;
  by: string | null;
  cost: number | null;
}

export interface LockItem {
  key: 'over' | 'balance' | 'orders' | 'payouts' | 'count';
  ok: boolean;
  title: string;
  detail: string;
  orders?: string[];
}

export interface LockChecklist {
  month: string;
  label: string;
  items: LockItem[];
  ready: boolean;
  locked: boolean;
  locked_at: string | null;
  locked_by: string | null;
  unlocked_at: string | null;
  unlocked_by: string | null;
  unlock_reason: string | null;
}

export interface LockedMonth {
  month: string;
  label: string;
  locked: boolean;
  locked_at: string | null;
  locked_by: string | null;
  unlocked_at: string | null;
  unlocked_by: string | null;
  unlock_reason: string | null;
}
