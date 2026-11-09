import { formatTakaBd } from '../adminNav';
import { bdPhoneKey, whatsAppChatUrl } from '../phone';
import type { SheetCell } from '../inventory/opening';
import type { EntryKind, LedgerType, OpeningDueRow, WriteOffReason } from './types';

/* Batch 41: plain helpers for the money screens — no database calls here,
   so the unit tests can check every one. */

/** Whole paisa, so sums never pick up floating-point dust. */
function paisa(amount: number): number {
  return Math.round(amount * 100);
}

/** ৳1,24,300 or ৳415.20 (paisa only when there are any). */
export function moneyText(amount: number): string {
  const p = paisa(amount);
  const negative = p < 0;
  const whole = Math.trunc(Math.abs(p) / 100);
  const rest = Math.abs(p) % 100;
  const base = formatTakaBd(whole);
  return `${negative ? '−' : ''}${base}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/** +৳500 / −৳500 (a plus only when asked for). */
export function signedMoney(amount: number, plus = false): string {
  if (paisa(amount) > 0) return `${plus ? '+' : ''}${moneyText(amount)}`;
  return moneyText(amount);
}

/**
 * Reads a typed amount: "1,000", "1000.50", "৳ 2 500", Bangla digits too.
 * Null when it isn't a number; two decimals at most.
 */
export function parseAmount(raw: string): number | null {
  const bangla = '০১২৩৪৫৬৭৮৯';
  const ascii = raw.replace(/[০-৯]/g, (d) => String(bangla.indexOf(d)));
  const clean = ascii.replace(/[৳,\s]/g, '').replace(/^tk\.?/i, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------ the form */

export interface KindChoice {
  kind: EntryKind;
  label: string;
}

/** The big buttons at the top of "Add money", and what each one holds. */
export interface KindGroup {
  id: 'expense' | 'transfer' | 'investor' | 'me' | 'not_shop' | 'supplier';
  label: string;
  choices: KindChoice[];
  /** Needs "View profit & costs" (else "Add money entries" is enough). */
  profitOnly: boolean;
}

export const KIND_GROUPS: readonly KindGroup[] = [
  { id: 'expense', label: 'Expense', choices: [{ kind: 'expense', label: 'Expense' }], profitOnly: false },
  { id: 'transfer', label: 'Move money', choices: [{ kind: 'transfer', label: 'Move money' }], profitOnly: false },
  {
    id: 'investor',
    label: 'Investor',
    choices: [
      { kind: 'investor_in', label: 'Money in' },
      { kind: 'investor_profit_share', label: 'Profit share paid' },
      { kind: 'investor_capital_back', label: 'Capital returned' },
    ],
    profitOnly: true,
  },
  {
    id: 'me',
    label: 'Me',
    choices: [
      { kind: 'owner_withdrawal', label: 'I took money out' },
      { kind: 'owner_money_in', label: 'I put money in' },
    ],
    profitOnly: true,
  },
  {
    id: 'not_shop',
    label: 'Not shop money',
    choices: [
      { kind: 'non_business_in', label: 'Came in' },
      { kind: 'non_business_out', label: 'Went out' },
    ],
    profitOnly: true,
  },
  { id: 'supplier', label: 'Pay what I owe', choices: [{ kind: 'supplier_payment', label: 'Supplier / other' }], profitOnly: true },
];

/** Money comes in (true) or goes out (false) for an entry kind. */
export function kindIsIn(kind: EntryKind): boolean | null {
  switch (kind) {
    case 'investor_in':
    case 'owner_money_in':
    case 'non_business_in':
      return true;
    case 'adjustment':
    case 'transfer':
      return null;
    default:
      return false;
  }
}

const TYPE_LABELS: Record<LedgerType, string> = {
  opening_balance: 'Opening balance',
  expense: 'Expense',
  transfer_out: 'Moved out',
  transfer_in: 'Moved in',
  investor_in: 'Investor money in',
  investor_profit_share: 'Investor profit share',
  investor_capital_back: 'Investor capital returned',
  owner_withdrawal: 'My withdrawal',
  owner_money_in: 'My money put in',
  non_business_in: 'Not shop money in',
  non_business_out: 'Not shop money out',
  supplier_payment: 'Paid what I owe',
  steadfast_payout_in: 'Steadfast payout',
  adjustment: 'Count difference',
  lot_payment: 'Paid for a lot',
  customer_payment: 'Customer payment',
  customer_refund: 'Refund to customer',
  previous_balance_payment: 'Previous balance paid',
  steadfast_payout_out: 'Paid out by Steadfast',
  courier_fees: 'Courier & COD fees (in order profit)',
  steadfast_unmatched: 'Parcel not matched to an order',
};

export function typeLabel(type: LedgerType): string {
  return TYPE_LABELS[type] ?? type;
}

export const WRITE_OFF_REASONS: readonly { id: WriteOffReason; label: string }[] = [
  { id: 'expired', label: 'Expired' },
  { id: 'damaged', label: 'Damaged' },
  { id: 'gift', label: 'Gift / sample' },
  { id: 'own_use', label: 'Own use' },
  { id: 'lost', label: 'Lost' },
  { id: 'count_difference', label: 'Count difference' },
];

export function writeOffReasonLabel(reason: string): string {
  if (reason === 'damaged_return') return 'Damaged return';
  return WRITE_OFF_REASONS.find((r) => r.id === reason)?.label ?? reason;
}

/* ------------------------------------------------------------- periods */

export type PeriodKind = 'today' | 'month' | 'year' | 'custom';

/** Today / this month / this year, both ends included (Dhaka dates). */
export function periodRange(kind: PeriodKind, today: string, custom: { from: string; to: string }): { from: string; to: string } {
  if (kind === 'today') return { from: today, to: today };
  if (kind === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (kind === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  return custom;
}

/** The first and last day of a month ("2026-10" → 2026-10-01 … 2026-10-31). */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "11 Oct 2026" from "2026-10-11". */
export function dayText(date: string | null): string {
  if (!date) return '—';
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "October 2026" from "2026-10". */
export function monthText(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const long = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${long[m - 1]} ${y}`;
}

/** Each category's share of the total, whole percent, adding up to 100. */
export function categoryShares<T extends { amount: number }>(rows: readonly T[]): (T & { percent: number })[] {
  const total = rows.reduce((s, r) => s + paisa(r.amount), 0);
  if (total <= 0) return rows.map((r) => ({ ...r, percent: 0 }));
  const raw = rows.map((r) => (paisa(r.amount) * 100) / total);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((s, n) => s + n, 0);
  const order = raw.map((v, i) => ({ i, rest: v - Math.floor(v) })).sort((a, b) => b.rest - a.rest);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return rows.map((r, i) => ({ ...r, percent: floors[i] }));
}

/* ------------------------------------------------------ due reminder */

export const DEFAULT_REMINDER_TEMPLATE =
  "Hello {name},\nYou have Tk. {due} left to pay as on {date}.\nThank you!\n– Naeem's - SkinScience\nView your orders: {link}";

/** "3,070" (Bangladeshi grouping, paisa only when there are any). */
export function reminderAmount(amount: number): string {
  return moneyText(amount).replace('৳', '');
}

/**
 * The reminder text from the Settings template. {name} {due} {date}
 * {link}; when there is no unpaid site order (only a previous balance),
 * every line holding {link} is left out.
 */
export function reminderMessage(
  template: string,
  values: { name: string; due: number; date: string; link: string | null }
): string {
  const text = (template.trim() === '' ? DEFAULT_REMINDER_TEMPLATE : template).replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter((line) => values.link !== null || !line.includes('{link}'));
  return lines
    .join('\n')
    .split('{name}').join(values.name.trim() || 'there')
    .split('{due}').join(reminderAmount(values.due))
    .split('{date}').join(dayText(values.date))
    .split('{link}').join(values.link ?? '')
    .trim();
}

/** The customer's own order page on this site (Batch 35 tracking). */
export function customerOrderLink(origin: string, orderId: string): string {
  return `${origin.replace(/\/+$/, '')}/orders/${encodeURIComponent(orderId)}`;
}

/** https://wa.me/8801…?text=… — null when the phone can't be used. */
export function reminderWhatsAppUrl(phone: string, message: string): string | null {
  const chat = whatsAppChatUrl(phone);
  return chat ? `${chat}?text=${encodeURIComponent(message)}` : null;
}

/* --------------------------------------------------- opening dues file */

export const DUES_SHEET_NAME = 'Customer dues';
export const DUES_COLUMNS = ['phone', 'name', 'due_amount'] as const;

function cellText(value: SheetCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/**
 * The rows of the filled dues file: the header row is the first one that
 * names "phone" and a due column; blank rows are skipped. A phone typed as
 * a number in Excel ("1712345678") is kept as digits.
 */
export function readDueRows(cells: readonly SheetCell[][]): { rows: OpeningDueRow[]; error: string | null } {
  const headerAt = cells.findIndex((row) => {
    const names = row.map((c) => cellText(c).toLowerCase());
    return names.includes('phone') && names.some((n) => n.startsWith('due'));
  });
  if (headerAt < 0) return { rows: [], error: 'The file needs the columns phone, name and due_amount (download the template).' };
  const names = cells[headerAt].map((c) => cellText(c).toLowerCase());
  const phoneCol = names.indexOf('phone');
  const nameCol = names.indexOf('name');
  const dueCol = names.findIndex((n) => n.startsWith('due'));
  const rows: OpeningDueRow[] = [];
  for (const row of cells.slice(headerAt + 1)) {
    const phone = cellText(row[phoneCol]);
    const due = cellText(row[dueCol]).replace(/[৳,\s]/g, '');
    const name = nameCol >= 0 ? cellText(row[nameCol]) : '';
    if (phone === '' && due === '' && name === '') continue;
    rows.push({ phone, name, due });
  }
  if (rows.length === 0) return { rows, error: 'The file has no rows under the header.' };
  if (rows.length > 2000) return { rows: [], error: 'The file has more than 2,000 rows.' };
  return { rows, error: null };
}

/** The phone key the database uses (same rule as bd_phone_key()). */
export function duePhoneKey(phone: string): string | null {
  const key = bdPhoneKey(phone);
  return key && /^01\d{9}$/.test(key) ? key : null;
}

/**
 * The previous balance a Kaarbar due becomes (the database does the same):
 *   no due on the site       → the Kaarbar due;
 *   "Keep the site due"      → nothing (the site orders already hold it);
 *   "Use the Kaarbar due"    → Kaarbar's number is the whole due, so the
 *                              site orders' own due is taken off it;
 *   "Add both"               → the Kaarbar due on top of the site due.
 */
export function openingDueAmount(due: number, siteDue: number, choice: 'keep_site' | 'kaarbar' | 'both'): number {
  if (siteDue <= 0) return due;
  if (choice === 'keep_site') return 0;
  if (choice === 'kaarbar') return Math.max(Math.round((due - siteDue) * 100) / 100, 0);
  return due;
}
