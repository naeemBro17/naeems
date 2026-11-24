// Batch 60: My Wallet — money a customer keeps with the shop and spends on
// orders. In the code it is the "store wallet" (the checkout already calls
// bKash / Nagad its "wallet" choice); customers only ever see "My Wallet".
//
// The database (migration-060) does every money rule itself: what is
// shown here is worked out the same way for the screen only, and
// place_order_wallet() checks the balance again.
import { supabase } from './supabase';
import { isMissingSchema } from './payouts';
import { whatsAppChatUrl } from './phone';
import { computeAdvanceDiscount, isWalletMethod, takaTight, type AdvanceDiscountRule } from './advanceDiscount';

/** The smallest amount a customer may send. */
export const STORE_WALLET_MIN = 500;
/** Batch 60: the advance-payment discount only when at least this much is
 *  paid in advance by bKash / Nagad for the order. */
export const ADVANCE_MIN = 1000;
/** The quick amount chips in "Add money". */
export const STORE_WALLET_CHIPS = [1000, 2000, 5000] as const;

export type StoreWalletMethod = 'bkash' | 'nagad';
export type StoreWalletKind = 'added' | 'order' | 'order_back' | 'overpaid' | 'correction';

export const STORE_WALLET_METHOD_NAMES: Record<StoreWalletMethod, string> = {
  bkash: 'bKash',
  nagad: 'Nagad',
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------- the money */

export interface StoreWalletSplit {
  /** Taken from the wallet. */
  fromStore: number;
  /** Left to pay (on delivery, or now by bKash / Nagad). */
  rest: number;
  /** The wallet covers everything. */
  fullyPaid: boolean;
}

/**
 * The wallet pays first: up to the balance and up to what the order asks
 * (before any advance-payment discount). Off: nothing from the wallet.
 */
export function splitStoreWallet(payBeforeStore: number, balance: number, useStore: boolean): StoreWalletSplit {
  const pay = Math.max(0, round2(payBeforeStore));
  const fromStore = useStore ? Math.min(Math.max(0, round2(balance)), pay) : 0;
  const rest = round2(pay - fromStore);
  return { fromStore, rest, fullyPaid: useStore && fromStore > 0 && rest <= 0 };
}

/** True when the part paid in advance earns the advance-payment discount. */
export function advanceQualifies(advancePart: number): boolean {
  return round2(advancePart) >= ADVANCE_MIN;
}

/**
 * The advance-payment discount with the Batch 60 rules: only bKash /
 * Nagad, only when what is left after the wallet is ৳1,000 or more, and
 * worked out on the products' part of that (never on the wallet part,
 * never on delivery). Same rule as place_order_core().
 */
export function advanceDiscountFor(input: {
  rule: AdvanceDiscountRule;
  /** Products after the promo code. */
  productsAfterPromo: number;
  /** What is left to pay after the wallet, before this discount. */
  leftAfterStore: number;
  method: string;
}): number {
  if (!isWalletMethod(input.method) || !advanceQualifies(input.leftAfterStore)) return 0;
  return computeAdvanceDiscount(input.rule, Math.min(input.productsAfterPromo, input.leftAfterStore), input.method);
}

/* --------------------------------------------------------------- WhatsApp */

/** The message the customer sends after "Add money" (Bangla, as agreed). */
export function storeWalletWhatsAppMessage(input: { amount: number; method: StoreWalletMethod; trx: string; name: string }): string {
  return [
    `হাই, আমি আমার Wallet-এ ${takaTight(input.amount)} পাঠিয়েছি।`,
    `${STORE_WALLET_METHOD_NAMES[input.method]}, Transaction ID: ${input.trx}`,
    `নাম: ${input.name.trim()}`,
    'প্লিজ কনফার্ম করবেন। ধন্যবাদ!',
  ].join('\n');
}

/** WhatsApp to the shop's own number with the message typed. Null when the
 *  shop has no WhatsApp number (the button is hidden). */
export function storeWalletWhatsAppUrl(shopNumber: string | null | undefined, message: string): string | null {
  const base = whatsAppChatUrl(shopNumber);
  if (!base) return null;
  return `${base}?text=${encodeURIComponent(message)}`;
}

/* ---------------------------------------------------------------- history */

export interface StoreWalletEntry {
  id: string;
  date: string;
  at: string;
  kind: StoreWalletKind;
  amount: number;
  orderId: string | null;
  orderNumber: string | null;
  /** Added by the shop (not from the customer's own request). */
  byShop: boolean;
  /** Admin view only. */
  account?: string | null;
  note?: string | null;
  by?: string | null;
}

/** What a history row says. */
export function storeWalletEntryLabel(entry: Pick<StoreWalletEntry, 'kind' | 'amount' | 'orderNumber' | 'byShop'>): string {
  const order = entry.orderNumber ?? 'an order';
  switch (entry.kind) {
    case 'added':
      return entry.byShop ? "Added by NAEEM'S" : 'Added';
    case 'order':
      return entry.amount < 0 ? `Used on order ${order}` : `Returned from order ${order}`;
    case 'order_back':
      return entry.amount > 0 ? `Returned from order ${order}` : `Used on order ${order}`;
    case 'overpaid':
      return entry.amount > 0 ? `Extra paid on order ${order}` : `Used on order ${order}`;
    default:
      return 'Correction';
  }
}

/** "+৳3,000" / "−৳1,070". */
export function storeWalletSigned(amount: number): string {
  return `${amount < 0 ? '−' : '+'}${takaTight(Math.abs(amount))}`;
}

/** "23 Nov 2026" from a yyyy-mm-dd date. */
export function storeWalletDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/* ------------------------------------------------------------ the requests */

export interface StoreWalletWaiting {
  id: string;
  amount: number;
  method: StoreWalletMethod;
  trxId: string;
  createdAt: string;
  sender?: string;
}

export interface StoreWalletResult {
  id: string;
  amount: number;
  method: StoreWalletMethod;
  status: 'confirmed' | 'rejected';
  decidedAt: string | null;
}

export interface MyStoreWallet {
  /** False for anyone but a signed-in customer (or before migration-060). */
  available: boolean;
  /** Batch 62: the wallet is opened by the shop (invitation only). Before
   *  migration-061 the answer has no "open" and every wallet counts as open. */
  open: boolean;
  balance: number;
  /** What they owe on orders and an older balance ("Due ৳X"). */
  due: number;
  waiting: StoreWalletWaiting[];
  /** Answers not seen yet: a toast for confirmed, a line for rejected. */
  results: StoreWalletResult[];
  history: StoreWalletEntry[];
}

export const EMPTY_STORE_WALLET: MyStoreWallet = { available: false, open: false, balance: 0, due: 0, waiting: [], results: [], history: [] };

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const method = (v: unknown): StoreWalletMethod => (v === 'nagad' ? 'nagad' : 'bkash');
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

function toEntry(row: Record<string, unknown>): StoreWalletEntry {
  const kind = str(row.kind);
  return {
    id: str(row.id),
    date: str(row.date),
    at: str(row.at),
    kind: (['added', 'order', 'order_back', 'overpaid', 'correction'].includes(kind) ? kind : 'correction') as StoreWalletKind,
    amount: num(row.amount),
    orderId: strOrNull(row.order_id),
    orderNumber: strOrNull(row.order_number),
    byShop: row.by_shop === true,
    account: strOrNull(row.account),
    note: strOrNull(row.note),
    by: strOrNull(row.by),
  };
}

function toWaiting(row: Record<string, unknown>): StoreWalletWaiting {
  return {
    id: str(row.id),
    amount: num(row.amount),
    method: method(row.method),
    trxId: str(row.trx_id),
    createdAt: str(row.created_at),
    sender: strOrNull(row.sender) ?? undefined,
  };
}

/** Parses store_wallet_my() (exported for the tests). */
export function parseMyStoreWallet(raw: unknown): MyStoreWallet {
  if (!raw || typeof raw !== 'object') return EMPTY_STORE_WALLET;
  const j = raw as Record<string, unknown>;
  return {
    available: j.available === true,
    open: j.available === true && j.open !== false,
    balance: num(j.balance),
    due: num(j.due),
    waiting: list(j.waiting).map(toWaiting),
    results: list(j.results).map((r) => ({
      id: str(r.id),
      amount: num(r.amount),
      method: method(r.method),
      status: r.status === 'rejected' ? 'rejected' : 'confirmed',
      decidedAt: strOrNull(r.decided_at),
    })),
    history: list(j.history).map(toEntry),
  };
}

/** The signed-in customer's wallet. Anything wrong (signed out, the SQL not
 *  run yet) is simply "no wallet", never an error on the page. */
export async function fetchMyStoreWallet(): Promise<MyStoreWallet> {
  const { data, error } = await supabase.rpc('store_wallet_my');
  if (error) return EMPTY_STORE_WALLET;
  return parseMyStoreWallet(data);
}

export interface Done<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function errorText(error: { code?: string; message?: string }): string {
  if (isMissingSchema(error)) return 'The wallet is not ready yet. Please try again later.';
  return error.message?.trim() || 'Something went wrong. Please try again.';
}

/** "I sent money". The database checks everything again. */
export async function sendStoreWalletRequest(input: {
  amount: number;
  method: StoreWalletMethod;
  trxId: string;
  sender: string;
}): Promise<Done<StoreWalletWaiting>> {
  const { data, error } = await supabase.rpc('store_wallet_request', {
    p_amount: input.amount,
    p_method: input.method,
    p_trx_id: input.trxId,
    p_sender: input.sender,
  });
  if (error) return { ok: false, error: errorText(error) };
  return { ok: true, data: toWaiting((data ?? {}) as Record<string, unknown>) };
}

/** The customer saw an answer (the toast, or dismissed the line). */
export async function markStoreWalletSeen(requestId: string): Promise<void> {
  await supabase.rpc('store_wallet_seen', { p_request_id: requestId });
}

/** "Paid from wallet ৳X" per order (empty before migration-060). */
export async function fetchOrdersPaidFromWallet(orderIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  const { data, error } = await supabase.rpc('store_wallet_order_paid', { p_order_ids: orderIds });
  if (error || !Array.isArray(data)) return out;
  for (const row of data as Record<string, unknown>[]) {
    const amount = num(row.from_wallet);
    if (amount > 0) out.set(str(row.order_id), amount);
  }
  return out;
}

/* ------------------------------------------------------------------ admin */

export interface CustomerStoreWalletRequest {
  id: string;
  amount: number;
  method: StoreWalletMethod;
  trxId: string;
  status: 'confirmed' | 'rejected';
  reason: string | null;
  by: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface CustomerStoreWallet {
  /** Batch 62: open (true before migration-061, which has no switch). */
  open: boolean;
  /** False before migration-061: the Wallet open switch is hidden. */
  canSwitch: boolean;
  balance: number;
  waiting: StoreWalletWaiting[];
  requests: CustomerStoreWalletRequest[];
  history: StoreWalletEntry[];
}

/** A customer's wallet on their admin page. null = not allowed or the SQL
 *  has not been run (the card stays hidden). */
export async function fetchCustomerStoreWallet(customerKey: string): Promise<CustomerStoreWallet | null> {
  const { data, error } = await supabase.rpc('store_wallet_customer', { p_customer_key: customerKey });
  if (error || !data || typeof data !== 'object') return null;
  const j = data as Record<string, unknown>;
  return {
    open: j.open !== false,
    canSwitch: typeof j.open === 'boolean',
    balance: num(j.balance),
    waiting: list(j.waiting).map(toWaiting),
    requests: list(j.requests).map((r) => ({
      id: str(r.id),
      amount: num(r.amount),
      method: method(r.method),
      trxId: str(r.trx_id),
      status: r.status === 'rejected' ? 'rejected' : 'confirmed',
      reason: strOrNull(r.reason),
      by: strOrNull(r.by),
      decidedAt: strOrNull(r.decided_at),
      createdAt: str(r.created_at),
    })),
    history: list(j.history).map(toEntry),
  };
}

export interface WaitingStoreWalletRequest {
  id: string;
  customerKey: string;
  name: string;
  amount: number;
  method: StoreWalletMethod;
  trxId: string;
  createdAt: string;
}

/** Batch 62: how a wallet request is listed: the name, else the phone,
 *  else "A customer" — never the internal key (p:… / ph:…). */
export function storeWalletRequestName(name: string, phone?: string | null): string {
  const clean = name.trim();
  if (clean !== '' && !/^(p|ph|n):/.test(clean)) return clean;
  const fromKey = clean.startsWith('ph:') ? clean.slice(3) : '';
  const number = (phone ?? '').trim() || fromKey;
  return number !== '' ? number : 'A customer';
}

/** Every waiting request (Home "Needs attention"). */
export async function fetchWaitingStoreWalletRequests(): Promise<WaitingStoreWalletRequest[]> {
  const { data, error } = await supabase.rpc('store_wallet_waiting');
  if (error || !Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).map((r) => ({
    id: str(r.id),
    customerKey: str(r.customer_key),
    name: storeWalletRequestName(str(r.name)),
    amount: num(r.amount),
    method: method(r.method),
    trxId: str(r.trx_id),
    createdAt: str(r.created_at),
  }));
}

export async function confirmStoreWalletRequest(requestId: string, accountId: string | null): Promise<Done<number>> {
  const { data, error } = await supabase.rpc('store_wallet_confirm', { p_request_id: requestId, p_account_id: accountId });
  if (error) return { ok: false, error: errorText(error) };
  return { ok: true, data: num((data as Record<string, unknown> | null)?.balance) };
}

export async function rejectStoreWalletRequest(requestId: string, reason: string): Promise<Done<true>> {
  const { error } = await supabase.rpc('store_wallet_reject', { p_request_id: requestId, p_reason: reason.trim() || null });
  if (error) return { ok: false, error: errorText(error) };
  return { ok: true, data: true };
}

export async function addToStoreWallet(input: {
  customerKey: string;
  amount: number;
  accountId: string;
  date: string;
  note: string;
}): Promise<Done<number>> {
  const { data, error } = await supabase.rpc('store_wallet_add', {
    p_customer_key: input.customerKey,
    p_amount: input.amount,
    p_account_id: input.accountId,
    p_date: input.date,
    p_note: input.note.trim() || null,
  });
  if (error) return { ok: false, error: errorText(error) };
  return { ok: true, data: num((data as Record<string, unknown> | null)?.balance) };
}

/** Batch 62: the admin "Wallet open" switch. Closing is refused by the
 *  database while the wallet holds money or a waiting request. */
export async function setStoreWalletOpen(customerKey: string, open: boolean): Promise<Done<boolean>> {
  const { data, error } = await supabase.rpc('store_wallet_set_open', { p_customer_key: customerKey, p_open: open });
  if (error) return { ok: false, error: errorText(error) };
  return { ok: true, data: (data as Record<string, unknown> | null)?.open === true };
}

/** Batch 62: the WhatsApp message a customer sends to ask for a wallet. */
export function storeWalletOpenMessage(name: string): string {
  return ['হাই, আমি আমার Wallet চালু করতে চাই।', `নাম: ${name.trim()}`].join('\n');
}

export async function correctStoreWallet(customerKey: string, newBalance: number, note: string): Promise<Done<number>> {
  const { data, error } = await supabase.rpc('store_wallet_correct', {
    p_customer_key: customerKey,
    p_new_balance: newBalance,
    p_note: note,
  });
  if (error) return { ok: false, error: errorText(error) };
  return { ok: true, data: num((data as Record<string, unknown> | null)?.new) };
}

/** The account a request is received in by default: bKash for bKash,
 *  Nagad (or bKash when there is no Nagad account) for Nagad. */
export function defaultStoreWalletAccount<T extends { id: string; payment_method: string | null; kind: string }>(
  accounts: T[],
  requestMethod: StoreWalletMethod
): string {
  const usable = accounts.filter((a) => a.kind !== 'steadfast');
  return (
    usable.find((a) => a.payment_method === requestMethod)?.id ??
    usable.find((a) => a.payment_method === 'bkash')?.id ??
    usable[0]?.id ??
    ''
  );
}

export interface OrderStoreWallet {
  customerKey: string | null;
  balance: number;
  /** Wallet money already on the order. */
  onOrder: number;
  due: number;
}

/** The wallet as Edit order sees it (null before migration-060). */
export async function fetchOrderStoreWallet(orderId: string): Promise<OrderStoreWallet | null> {
  const { data, error } = await supabase.rpc('store_wallet_for_order', { p_order_id: orderId });
  if (error || !data || typeof data !== 'object') return null;
  const j = data as Record<string, unknown>;
  return { customerKey: strOrNull(j.customer_key), balance: num(j.balance), onOrder: num(j.on_order), due: num(j.due) };
}

/** A customer's balance for New order (by their login, else their phone). */
export async function fetchCustomerStoreWalletBalance(profileId: string | null, phone: string): Promise<number> {
  const { data, error } = await supabase.rpc('store_wallet_for_customer', { p_profile_id: profileId, p_phone: phone });
  if (error || !data || typeof data !== 'object') return 0;
  return num((data as Record<string, unknown>).balance);
}

/** "Use wallet balance" on an admin order. Returns what was taken. */
export async function applyStoreWalletToOrder(orderId: string, amount: number): Promise<Done<number>> {
  const { data, error } = await supabase.rpc('store_wallet_use', { p_order_id: orderId, p_amount: amount });
  if (error) return { ok: false, error: errorText(error) };
  return { ok: true, data: num(data) };
}
