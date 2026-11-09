/**
 * Batch 41: money — accounts, entries, the ledger, investors, dues, opening
 * balances and the Money page (migration-043). Amounts are taka; a money
 * entry's amount is + for money in and − for money out.
 */

export type AccountKind = 'cash' | 'bkash' | 'bank' | 'nagad' | 'other' | 'steadfast';

export interface MoneyAccount {
  id: string;
  name: string;
  kind: AccountKind;
  payment_method: string | null;
  sort_order: number;
  archived: boolean;
}

export interface AccountBalance {
  account_id: string;
  name: string;
  kind: AccountKind;
  archived: boolean;
  balance: number;
}

export interface MoneyCategory {
  id: string;
  name: string;
  sort_order: number;
  archived: boolean;
}

export type PartyKind = 'investor' | 'other';

export interface Party {
  id: string;
  name: string;
  phone: string | null;
  kind: PartyKind;
  note: string | null;
}

export interface SupplierRef {
  id: string;
  name: string;
}

/** The types stored in money_movements. */
export type MovementType =
  | 'opening_balance'
  | 'expense'
  | 'transfer_out'
  | 'transfer_in'
  | 'investor_in'
  | 'investor_profit_share'
  | 'investor_capital_back'
  | 'owner_withdrawal'
  | 'owner_money_in'
  | 'non_business_in'
  | 'non_business_out'
  | 'supplier_payment'
  | 'steadfast_payout_in'
  | 'adjustment'
  | 'lot_payment';

/** Ledger rows also hold customer payments and Steadfast's side. */
export type LedgerType =
  | MovementType
  | 'customer_payment'
  | 'customer_refund'
  | 'previous_balance_payment'
  | 'steadfast_payout_out'
  | 'courier_fees'
  | 'steadfast_unmatched';

/** What the "Add money" screen can add (a move is stored as a pair). */
export type EntryKind =
  | 'expense'
  | 'transfer'
  | 'investor_in'
  | 'investor_profit_share'
  | 'investor_capital_back'
  | 'owner_withdrawal'
  | 'owner_money_in'
  | 'non_business_in'
  | 'non_business_out'
  | 'supplier_payment'
  | 'adjustment';

export interface MoneyMovement {
  id: string;
  entry_date: string;
  account_id: string;
  amount: number;
  type: MovementType;
  category_id: string | null;
  party_id: string | null;
  supplier_id: string | null;
  lot_id: string | null;
  order_id: string | null;
  payout_id: string | null;
  transfer_id: string | null;
  note: string | null;
  reference: string | null;
  bill_path: string | null;
  created_by_username: string | null;
  created_at: string;
  updated_at: string;
  updated_by_username: string | null;
}

export interface LedgerRow {
  source: 'movement' | 'payout_out' | 'payment' | 'due_payment' | 'payout_fees' | 'payout_unmatched';
  source_id: string;
  entry_date: string;
  account_id: string;
  amount: number;
  type: LedgerType;
  category_id: string | null;
  note: string | null;
  reference: string | null;
  order_id: string | null;
  created_by_username: string | null;
  created_at: string;
}

export interface NewEntry {
  kind: EntryKind;
  /** Typed positive (a count difference may be negative). */
  amount: number;
  accountId: string;
  date: string;
  note: string;
  categoryId?: string | null;
  partyId?: string | null;
  supplierId?: string | null;
  toAccountId?: string | null;
  billPath?: string | null;
}

export interface ProfitParts {
  from: string;
  to: string;
  orders: number;
  uncosted_orders: number;
  sales: number;
  cost: number;
  provisional: number;
  delivery: number;
  courier: number;
  cost_adjustments: number;
  expenses: number;
  write_offs: number;
  net_profit: number;
  profit_share: number;
  your_profit: number;
  withdrawals: number;
  left_in_business: number;
  owner_money_in: number;
  not_shop_money: number;
  count_differences: number;
}

export interface OpeningNetWorth {
  accounts: number;
  previous_balances: number;
  stock: number;
  site_orders: number;
  payables: number;
  total: number;
}

export interface UnplacedPayout {
  payout_id: string;
  paid_at: string | null;
  amount: number;
  parcels: number;
}

export interface MoneyPosition {
  start_date: string | null;
  accounts: AccountBalance[];
  accounts_total: number;
  with_steadfast: number;
  steadfast_reported: number | null;
  steadfast_reported_at: string | null;
  unplaced_payouts: UnplacedPayout[];
  to_receive: number;
  previous_balances: number;
  customer_advances: number;
  stock_value: number;
  goods_on_open_orders: number;
  open_orders_value: number;
  sold_without_stock: number;
  to_give: number;
  to_give_investors: number;
  to_give_suppliers: number;
  to_give_others: number;
  have: number;
  owe: number;
  net_worth: number;
  opening: OpeningNetWorth | null;
  since_start: ProfitParts | null;
  outside_orders: number;
  outside_fees: number;
  outside_unmatched: number;
  outside: number;
  expected: number | null;
  difference: number | null;
  balanced: boolean | null;
  first_wrong: string | null;
}

export interface MoneySummary {
  profit: ProfitParts;
  expenses_by_category: { category_id: string; name: string; amount: number }[];
  position: MoneyPosition;
  roi: { average_money: number | null; begin: number | null; end: number | null; percent: number | null };
  last_payout_account_id: string | null;
  confirmed: boolean;
  inventory_mode: boolean;
}

export interface ToGiveRow {
  kind: 'investor' | 'supplier' | 'other';
  id: string | null;
  name: string;
  owed: number;
  capital_in: number | null;
  capital_back: number | null;
  share_month: number | null;
  share_year: number | null;
  share_all: number | null;
  lots: { lot_id: string; code: string; owed: number }[];
}

export interface CustomerDue {
  customer_key: string;
  phone_key: string | null;
  order_due: number;
  previous_left: number;
  latest_unpaid_order_id: string | null;
  latest_unpaid_order_number: string | null;
  last_reminder_at: string | null;
  last_reminder_amount: number | null;
  reminders: number;
}

export interface CustomerMoneyHistory {
  phone_key: string | null;
  previous: { id: string; amount: number; at: string; choice: string; kaarbar_amount: number | null; site_due_then: number | null }[];
  previous_left: number;
  payments: { id: string; amount: number; date: string; account: string; note: string | null; by: string | null }[];
  reminders: { at: string; amount: number; how: 'whatsapp' | 'copied'; by: string | null }[];
}

export interface LotPayments {
  landed: number;
  owed: number;
  rows: { id: string; account_id: string; account: string; amount: number; date: string }[];
  supplier_payments: { id: string; account: string; amount: number; date: string }[];
}

export type WriteOffReason = 'expired' | 'damaged' | 'gift' | 'own_use' | 'lost' | 'count_difference';

export interface WriteOff {
  id: string;
  write_date: string;
  product_id: string | null;
  variant_id: string | null;
  label: string;
  units: number;
  reason: WriteOffReason | 'damaged_return';
  note: string | null;
  cost_bdt: number;
  order_id: string | null;
  /** The returned order (damaged returns). */
  order_number?: string | null;
  lots: { lot_item_id: string; code: string; units: number; unit_cost: number }[];
  created_by_username: string | null;
  created_at: string;
}

/** One row of the opening dues file, as read from Excel. */
export interface OpeningDueRow {
  phone: string;
  name: string;
  due: string;
}

export interface OpeningPreviewRow {
  n: number;
  phone: string;
  phone_key: string | null;
  name: string;
  due: number | null;
  customer_key: string | null;
  known: boolean;
  site_name: string | null;
  site_due: number;
  previous_already: number;
  problem: string | null;
}

export interface OpeningPreview {
  rows: OpeningPreviewRow[];
  site_total_due: number;
}

/** What to do when a Kaarbar due belongs to someone who already owes on the site. */
export type DueChoice = 'keep_site' | 'kaarbar' | 'both';

export interface OpeningPayableInput {
  kind: 'investor' | 'supplier' | 'other';
  name: string;
  phone: string;
  amount: string;
  note: string;
}
