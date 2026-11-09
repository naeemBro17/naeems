import { supabase } from '../supabase';
import { isMissingSchema, type LoadState } from '../payouts';
import type {
  AccountBalance,
  CustomerDue,
  CustomerMoneyHistory,
  DueChoice,
  LedgerRow,
  LotPayments,
  MoneyAccount,
  MoneyCategory,
  MoneyMovement,
  MoneySummary,
  NewEntry,
  OpeningDueRow,
  OpeningPayableInput,
  OpeningPreview,
  Party,
  SupplierRef,
  ToGiveRow,
  WriteOff,
  WriteOffReason,
} from './types';

/**
 * Batch 41: the money screens' database calls (migration-043). Every read
 * is refused by the database for anyone without "View profit & costs"
 * (account names and categories also for "Add money entries"); every write
 * is a function that checks the same again.
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

/** Numbers come back from the database as text; this turns every numeric
 *  field of a plain object into a number (dates and ids stay text). */
function numbers<T>(row: Record<string, unknown>, keys: readonly string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) out[k] = numOrNull(row[k]);
  return out as T;
}

export async function fetchAccounts(): Promise<LoadState<MoneyAccount[]>> {
  const { data, error } = await supabase
    .from('money_accounts')
    .select('id, name, kind, payment_method, sort_order, archived')
    .order('sort_order')
    .order('created_at');
  if (error) return fail(error);
  return { kind: 'ready', data: (data ?? []) as MoneyAccount[] };
}

export async function fetchCategories(): Promise<LoadState<MoneyCategory[]>> {
  const { data, error } = await supabase.from('money_categories').select('id, name, sort_order, archived').order('sort_order');
  if (error) return fail(error);
  return { kind: 'ready', data: (data ?? []) as MoneyCategory[] };
}

export async function fetchParties(): Promise<LoadState<Party[]>> {
  const { data, error } = await supabase.from('parties_payable').select('id, name, phone, kind, note').order('name');
  if (error) return fail(error);
  return { kind: 'ready', data: (data ?? []) as Party[] };
}

export async function fetchSuppliers(): Promise<SupplierRef[]> {
  const { data } = await supabase.from('suppliers').select('id, name').order('name');
  return (data ?? []) as SupplierRef[];
}

export async function fetchBalances(): Promise<LoadState<AccountBalance[]>> {
  const { data, error } = await supabase.rpc('money_account_balances');
  if (error) return fail(error);
  return {
    kind: 'ready',
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      account_id: r.account_id as string,
      name: r.name as string,
      kind: r.kind as AccountBalance['kind'],
      archived: r.archived === true,
      balance: num(r.balance),
    })),
  };
}

export async function fetchSummary(from: string, to: string): Promise<LoadState<MoneySummary>> {
  const { data, error } = await supabase.rpc('money_summary', { p_from: from, p_to: to });
  if (error) return fail(error);
  return { kind: 'ready', data: data as MoneySummary };
}

const MOVEMENT_COLUMNS =
  'id, entry_date, account_id, amount, type, category_id, party_id, supplier_id, lot_id, order_id, payout_id, transfer_id, note, reference, bill_path, created_by_username, created_at, updated_at, updated_by_username';

function toMovement(r: Record<string, unknown>): MoneyMovement {
  return { ...(r as unknown as MoneyMovement), amount: num(r.amount) };
}

/** Expenses (or any type) between two dates, newest first. */
export async function fetchMovements(
  filter: { from: string; to: string; types?: readonly string[]; categoryId?: string | null }
): Promise<LoadState<MoneyMovement[]>> {
  let query = supabase
    .from('money_movements')
    .select(MOVEMENT_COLUMNS)
    .gte('entry_date', filter.from)
    .lte('entry_date', filter.to)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1000);
  if (filter.types && filter.types.length > 0) query = query.in('type', [...filter.types]);
  if (filter.categoryId) query = query.eq('category_id', filter.categoryId);
  const { data, error } = await query;
  if (error) return fail(error);
  return { kind: 'ready', data: ((data ?? []) as Record<string, unknown>[]).map(toMovement) };
}

export async function fetchMovement(id: string): Promise<LoadState<MoneyMovement | null>> {
  const { data, error } = await supabase.from('money_movements').select(MOVEMENT_COLUMNS).eq('id', id).maybeSingle();
  if (error) return fail(error);
  return { kind: 'ready', data: data ? toMovement(data as Record<string, unknown>) : null };
}

/** The other row of a move between accounts. */
export async function fetchTransferPair(transferId: string): Promise<MoneyMovement[]> {
  const { data } = await supabase.from('money_movements').select(MOVEMENT_COLUMNS).eq('transfer_id', transferId);
  return ((data ?? []) as Record<string, unknown>[]).map(toMovement);
}

/** One account's ledger (everything in and out), newest first. */
export async function fetchLedger(accountId: string, from: string, to: string): Promise<LoadState<LedgerRow[]>> {
  const { data, error } = await supabase
    .from('money_ledger')
    .select('source, source_id, entry_date, account_id, amount, type, category_id, note, reference, order_id, created_by_username, created_at')
    .eq('account_id', accountId)
    .gte('entry_date', from)
    .lte('entry_date', to)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) return fail(error);
  return { kind: 'ready', data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as LedgerRow), amount: num(r.amount) })) };
}

export async function addEntry(entry: NewEntry): Promise<Answer<string[]>> {
  const { data, error } = await supabase.rpc('money_add_entry', {
    p_type: entry.kind,
    p_amount: entry.amount,
    p_account: entry.accountId,
    p_date: entry.date,
    p_note: entry.note.trim() || null,
    p_category: entry.categoryId ?? null,
    p_party: entry.partyId ?? null,
    p_supplier: entry.supplierId ?? null,
    p_to_account: entry.toAccountId ?? null,
    p_bill_path: entry.billPath ?? null,
  });
  if (error) return { ok: false, error: message(error) };
  return { ok: true, data: ((data as { ids?: string[] } | null)?.ids ?? []) as string[] };
}

export async function updateEntry(
  id: string,
  entry: Omit<NewEntry, 'kind' | 'billPath'>
): Promise<Answer<true>> {
  const { error } = await supabase.rpc('money_update_entry', {
    p_id: id,
    p_amount: entry.amount,
    p_account: entry.accountId,
    p_date: entry.date,
    p_note: entry.note.trim() || null,
    p_category: entry.categoryId ?? null,
    p_party: entry.partyId ?? null,
    p_supplier: entry.supplierId ?? null,
    p_to_account: entry.toAccountId ?? null,
  });
  return error ? { ok: false, error: message(error) } : { ok: true, data: true };
}

export async function deleteEntry(id: string, typedAmount: number): Promise<Answer<true>> {
  const { error } = await supabase.rpc('money_delete_entry', { p_id: id, p_confirm_amount: typedAmount });
  return error ? { ok: false, error: message(error) } : { ok: true, data: true };
}

export async function saveAccount(input: {
  id: string | null;
  name: string;
  kind: string;
  paymentMethod: string | null;
  archived: boolean;
}): Promise<Answer<string>> {
  const { data, error } = await supabase.rpc('money_save_account', {
    p_id: input.id,
    p_name: input.name,
    p_kind: input.kind,
    p_payment_method: input.paymentMethod,
    p_archived: input.archived,
  });
  return error ? { ok: false, error: message(error) } : { ok: true, data: data as string };
}

export async function saveCategory(id: string | null, name: string, archived: boolean): Promise<Answer<string>> {
  const { data, error } = await supabase.rpc('money_save_category', { p_id: id, p_name: name, p_archived: archived });
  return error ? { ok: false, error: message(error) } : { ok: true, data: data as string };
}

export async function saveParty(input: { id: string | null; name: string; phone: string; kind: string; note: string }): Promise<Answer<string>> {
  const { data, error } = await supabase.rpc('money_save_party', {
    p_id: input.id,
    p_name: input.name,
    p_phone: input.phone,
    p_kind: input.kind,
    p_note: input.note,
  });
  return error ? { ok: false, error: message(error) } : { ok: true, data: data as string };
}

export async function placePayout(payoutId: string, accountId: string): Promise<Answer<string>> {
  const { data, error } = await supabase.rpc('money_place_payout', { p_payout_id: payoutId, p_account: accountId });
  return error ? { ok: false, error: message(error) } : { ok: true, data: data as string };
}

export async function fetchToGive(): Promise<LoadState<ToGiveRow[]>> {
  const { data, error } = await supabase.rpc('money_to_give_rows');
  if (error) return fail(error);
  return {
    kind: 'ready',
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      ...numbers<ToGiveRow>(r, ['owed', 'capital_in', 'capital_back', 'share_month', 'share_year', 'share_all']),
      owed: num(r.owed),
      lots: ((r.lots ?? []) as { lot_id: string; code: string; owed: unknown }[]).map((l) => ({ ...l, owed: num(l.owed) })),
    })),
  };
}

/* ------------------------------------------------------------- lots */

function toLotPayments(raw: Record<string, unknown>): LotPayments {
  return {
    landed: num(raw.landed),
    owed: num(raw.owed),
    rows: ((raw.rows ?? []) as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      account_id: r.account_id as string,
      account: r.account as string,
      amount: num(r.amount),
      date: r.date as string,
    })),
    supplier_payments: ((raw.supplier_payments ?? []) as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      account: r.account as string,
      amount: num(r.amount),
      date: r.date as string,
    })),
  };
}

export async function fetchLotPayments(lotId: string): Promise<LoadState<LotPayments>> {
  const { data, error } = await supabase.rpc('money_lot_payments', { p_lot_id: lotId });
  if (error) return fail(error);
  return { kind: 'ready', data: toLotPayments(data as Record<string, unknown>) };
}

export async function saveLotPayments(
  lotId: string,
  rows: { account_id: string; amount: number; date: string }[]
): Promise<Answer<LotPayments>> {
  const { data, error } = await supabase.rpc('money_set_lot_payments', { p_lot_id: lotId, p_rows: rows });
  return error ? { ok: false, error: message(error) } : { ok: true, data: toLotPayments(data as Record<string, unknown>) };
}

/* --------------------------------------------------------- customers */

export async function fetchCustomerDues(): Promise<Map<string, CustomerDue>> {
  const { data, error } = await supabase.rpc('money_customer_dues');
  const map = new Map<string, CustomerDue>();
  if (error) return map;
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const row: CustomerDue = {
      customer_key: r.customer_key as string,
      phone_key: (r.phone_key as string | null) ?? null,
      order_due: num(r.order_due),
      previous_left: num(r.previous_left),
      latest_unpaid_order_id: (r.latest_unpaid_order_id as string | null) ?? null,
      latest_unpaid_order_number: (r.latest_unpaid_order_number as string | null) ?? null,
      last_reminder_at: (r.last_reminder_at as string | null) ?? null,
      last_reminder_amount: numOrNull(r.last_reminder_amount),
      reminders: num(r.reminders),
    };
    map.set(row.customer_key, row);
  }
  return map;
}

export async function fetchCustomerHistory(customerKey: string, phone: string): Promise<CustomerMoneyHistory | null> {
  const { data, error } = await supabase.rpc('money_customer_history', { p_customer_key: customerKey, p_phone: phone });
  if (error || !data) return null;
  const raw = data as Record<string, unknown>;
  return {
    phone_key: (raw.phone_key as string | null) ?? null,
    previous: ((raw.previous ?? []) as Record<string, unknown>[]).map((p) => ({
      id: p.id as string,
      amount: num(p.amount),
      at: p.at as string,
      choice: p.choice as string,
      kaarbar_amount: numOrNull(p.kaarbar_amount),
      site_due_then: numOrNull(p.site_due_then),
    })),
    previous_left: num(raw.previous_left),
    payments: ((raw.payments ?? []) as Record<string, unknown>[]).map((p) => ({
      id: p.id as string,
      amount: num(p.amount),
      date: p.date as string,
      account: p.account as string,
      note: (p.note as string | null) ?? null,
      by: (p.by as string | null) ?? null,
    })),
    reminders: ((raw.reminders ?? []) as Record<string, unknown>[]).map((p) => ({
      at: p.at as string,
      amount: num(p.amount),
      how: p.how as 'whatsapp' | 'copied',
      by: (p.by as string | null) ?? null,
    })),
  };
}

export async function recordReminder(input: {
  customerKey: string;
  phone: string;
  amount: number;
  orderId: string | null;
  how: 'whatsapp' | 'copied';
}): Promise<Answer<string>> {
  const { data, error } = await supabase.rpc('money_record_reminder', {
    p_customer_key: input.customerKey,
    p_phone: input.phone,
    p_amount: input.amount,
    p_order_id: input.orderId,
    p_how: input.how,
  });
  return error ? { ok: false, error: message(error) } : { ok: true, data: data as string };
}

export async function addDuePayment(input: { phone: string; amount: number; accountId: string; date: string; note: string }): Promise<Answer<string>> {
  const { data, error } = await supabase.rpc('money_add_due_payment', {
    p_phone: input.phone,
    p_amount: input.amount,
    p_account: input.accountId,
    p_date: input.date,
    p_note: input.note.trim() || null,
  });
  return error ? { ok: false, error: message(error) } : { ok: true, data: data as string };
}

export async function deleteDuePayment(id: string, typedAmount: number): Promise<Answer<true>> {
  const { error } = await supabase.rpc('money_delete_due_payment', { p_id: id, p_confirm_amount: typedAmount });
  return error ? { ok: false, error: message(error) } : { ok: true, data: true };
}

/** The signed-in customer's own previous balance (0 when none). */
export async function fetchMyPreviousBalance(): Promise<number> {
  const { data, error } = await supabase.rpc('customer_previous_balance');
  return error ? 0 : num(data);
}

/* ------------------------------------------------------- write-offs */

export async function writeOff(input: {
  productId: string;
  variantId: string | null;
  units: number;
  reason: WriteOffReason;
  note: string;
  lotItemId: string | null;
}): Promise<Answer<WriteOff>> {
  const { data, error } = await supabase.rpc('money_write_off', {
    p_product_id: input.productId,
    p_variant_id: input.variantId,
    p_units: input.units,
    p_reason: input.reason,
    p_note: input.note.trim() || null,
    p_lot_item_id: input.lotItemId,
  });
  if (error) return { ok: false, error: message(error) };
  const raw = data as Record<string, unknown>;
  return { ok: true, data: { ...(raw as unknown as WriteOff), cost_bdt: num(raw.cost_bdt), units: num(raw.units) } };
}

export async function fetchWriteOffs(filter: { from: string; to: string; productId?: string }): Promise<LoadState<WriteOff[]>> {
  let query = supabase
    .from('stock_write_offs')
    .select('id, write_date, product_id, variant_id, label, units, reason, note, cost_bdt, order_id, lots, created_by_username, created_at, orders(order_number)')
    .gte('write_date', filter.from)
    .lte('write_date', filter.to)
    .order('created_at', { ascending: false })
    .limit(500);
  if (filter.productId) query = query.eq('product_id', filter.productId);
  const { data, error } = await query;
  if (error) return fail(error);
  return {
    kind: 'ready',
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      ...(r as unknown as WriteOff),
      cost_bdt: num(r.cost_bdt),
      units: num(r.units),
      order_number: (r.orders as { order_number?: string } | null)?.order_number ?? null,
    })),
  };
}

/** "Mark returned" with damaged items (they are written off, not restocked). */
export async function markReturnedDamaged(
  orderId: string,
  note: string | null,
  damaged: { order_item_id: string; units: number }[]
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_mark_order_returned_damaged', { p_order_id: orderId, p_note: note, p_damaged: damaged });
  return { error: error ? message(error) : null };
}

/* ------------------------------------------------- opening balances */

export async function fetchBooks(): Promise<{ start_date: string | null; confirmed_at: string | null; confirmed_by_username: string | null } | null> {
  const { data } = await supabase.from('money_books').select('start_date, confirmed_at, confirmed_by_username').eq('id', 1).maybeSingle();
  return (data as { start_date: string | null; confirmed_at: string | null; confirmed_by_username: string | null } | null) ?? null;
}

export async function previewOpeningDues(rows: OpeningDueRow[]): Promise<Answer<OpeningPreview>> {
  const { data, error } = await supabase.rpc('money_opening_preview', { p_rows: rows });
  if (error) return { ok: false, error: message(error) };
  const raw = data as { rows: Record<string, unknown>[]; site_total_due: unknown };
  return {
    ok: true,
    data: {
      site_total_due: num(raw.site_total_due),
      rows: (raw.rows ?? []).map((r) => ({
        n: num(r.n),
        phone: (r.phone as string) ?? '',
        phone_key: (r.phone_key as string | null) ?? null,
        name: (r.name as string) ?? '',
        due: numOrNull(r.due),
        customer_key: (r.customer_key as string | null) ?? null,
        known: r.known === true,
        site_name: (r.site_name as string | null) ?? null,
        site_due: num(r.site_due),
        previous_already: num(r.previous_already),
        problem: (r.problem as string | null) ?? null,
      })),
    },
  };
}

export async function confirmOpening(input: {
  start: string;
  accounts: { account_id: string; amount: number }[];
  dues: { phone: string; name: string; due: number; choice: DueChoice }[];
  payables: OpeningPayableInput[];
}): Promise<Answer<Record<string, unknown>>> {
  const { data, error } = await supabase.rpc('money_confirm_opening', {
    p_start: input.start,
    p_accounts: input.accounts,
    p_dues: input.dues,
    p_payables: input.payables.map((p) => ({ kind: p.kind, name: p.name, phone: p.phone, amount: p.amount, note: p.note })),
  });
  return error ? { ok: false, error: message(error) } : { ok: true, data: data as Record<string, unknown> };
}

export async function undoOpening(typed: string): Promise<Answer<true>> {
  const { error } = await supabase.rpc('money_undo_opening', { p_confirm: typed });
  return error ? { ok: false, error: message(error) } : { ok: true, data: true };
}

/** The opening lot L-000's date, when it exists (the start date must match). */
export async function fetchOpeningLotDate(): Promise<string | null> {
  const { data } = await supabase.from('lots').select('lot_date').eq('kind', 'opening').maybeSingle();
  return (data as { lot_date: string } | null)?.lot_date ?? null;
}

/** What the money tables hold for the opening screen (after confirming). */
export async function fetchOpeningRows(): Promise<{
  accounts: { account_id: string; amount: number }[];
  dues: { phone_key: string; full_name: string; amount: number; choice: string }[];
  payables: { party_id: string | null; supplier_id: string | null; amount: number; note: string | null }[];
}> {
  const [acc, dues, pay] = await Promise.all([
    supabase.from('money_movements').select('account_id, amount').eq('type', 'opening_balance'),
    supabase.from('customer_opening_dues').select('phone_key, full_name, amount, choice').order('created_at'),
    supabase.from('money_opening_payables').select('party_id, supplier_id, amount, note').order('created_at'),
  ]);
  return {
    accounts: ((acc.data ?? []) as Record<string, unknown>[]).map((r) => ({ account_id: r.account_id as string, amount: num(r.amount) })),
    dues: ((dues.data ?? []) as Record<string, unknown>[]).map((r) => ({
      phone_key: r.phone_key as string,
      full_name: (r.full_name as string) ?? '',
      amount: num(r.amount),
      choice: r.choice as string,
    })),
    payables: ((pay.data ?? []) as Record<string, unknown>[]).map((r) => ({
      party_id: (r.party_id as string | null) ?? null,
      supplier_id: (r.supplier_id as string | null) ?? null,
      amount: num(r.amount),
      note: (r.note as string | null) ?? null,
    })),
  };
}

/* ------------------------------------------------------- bill photos */

/** A short-lived link to look at a bill photo (private bucket). */
export async function billPhotoUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('money-bills').createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}
