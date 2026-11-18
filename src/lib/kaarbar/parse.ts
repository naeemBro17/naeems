import type { SheetCell } from '../inventory/opening';
import type { MoneyAccount, Party } from '../money/types';
import { bdPhoneKey } from '../phone';

/**
 * Batch 49: reading Kaarbar's "All Party Report" and "Expense Report"
 * (.xlsx) and sorting every row into what the import will do with it.
 * Pure functions: the screen and the unit tests use the same code. The
 * file itself never leaves the browser — only the rows that are imported.
 */

/* ------------------------------------------------------------- cells */

/** Header names compared without case, spaces or punctuation. */
export function headerKey(value: SheetCell): string {
  return cellText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function cellText(value: SheetCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  return String(value);
}

function isBlankRow(row: readonly SheetCell[] | undefined): boolean {
  return !row || row.every((c) => cellText(c).trim() === '');
}

/** "৳1,250.50", "1250", "(300)" → numbers; empty → null. */
export function parseAmountCell(value: SheetCell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = cellText(value).trim();
  if (text === '') return null;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
  const digits = text.replace(/[^0-9.]/g, '');
  if (digits === '' || !/^\d*\.?\d*$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Kaarbar's Date column (a date-time) → "YYYY-MM-DD", or null when it
 * can't be read. Excel dates arrive as a Date at the same clock time in
 * UTC, so the UTC day is the day Kaarbar shows. Typed dates are read as
 * day / month / year (the Bangladeshi way) unless that is impossible.
 */
export function parseDateCell(value: SheetCell): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number') {
    if (value < 20000 || value > 80000) return null;
    const date = new Date(Math.round((value - 25569) * 86400000));
    return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const text = cellText(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return b > 12 && a <= 12 ? isoDate(Number(m[3]), a, b) : isoDate(Number(m[3]), b, a);
  }
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s,-]+(\d{4})/.exec(text);
  if (m) {
    const month = MONTH_NAMES.indexOf(m[2].slice(0, 3).toLowerCase());
    return month < 0 ? null : isoDate(Number(m[3]), month + 1, Number(m[1]));
  }
  m = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (m) {
    const month = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase());
    return month < 0 ? null : isoDate(Number(m[3]), month + 1, Number(m[2]));
  }
  return null;
}

/* ------------------------------------------------------------ header */

interface ColumnSpec<K extends string> {
  key: K;
  label: string;
  names: readonly string[];
  required: boolean;
}

export interface HeaderFound<K extends string> {
  /** Index of the header row in the sheet. */
  row: number;
  columns: Record<K, number>;
}

/**
 * The header is the first non-empty row that has every required column
 * (title rows Kaarbar may put above it are passed over). Columns are found
 * by name, never by position.
 */
export function findHeader<K extends string>(
  cells: readonly (readonly SheetCell[])[],
  spec: readonly ColumnSpec<K>[],
  reportName: string
): { header: HeaderFound<K> | null; error: string | null } {
  let firstMissing: string[] | null = null;
  let seen = 0;
  for (let i = 0; i < cells.length && seen < 30; i++) {
    const row = cells[i];
    if (isBlankRow(row)) continue;
    seen++;
    const keys = row.map(headerKey);
    const columns = {} as Record<K, number>;
    const missing: string[] = [];
    for (const col of spec) {
      const at = keys.findIndex((k) => col.names.includes(k));
      columns[col.key] = at;
      if (at < 0 && col.required) missing.push(col.label);
    }
    if (missing.length === 0) return { header: { row: i, columns }, error: null };
    if (firstMissing === null) firstMissing = missing;
  }
  if (firstMissing === null) return { header: null, error: 'The file is empty.' };
  return {
    header: null,
    error: `This does not look like Kaarbar's ${reportName}: the column${firstMissing.length > 1 ? 's' : ''} ${firstMissing
      .map((m) => `"${m}"`)
      .join(', ')} ${firstMissing.length > 1 ? 'are' : 'is'} missing.`,
  };
}

function cellAt(row: readonly SheetCell[], index: number): SheetCell {
  return index < 0 ? null : row[index];
}

/* ----------------------------------------------------------- parties */

type PartyColumn = 'name' | 'contact' | 'receivable' | 'payable';

const PARTY_COLUMNS: readonly ColumnSpec<PartyColumn>[] = [
  { key: 'name', label: 'Party Name', names: ['partyname', 'name', 'party'], required: true },
  { key: 'contact', label: 'Contact', names: ['contact', 'contactno', 'phone', 'phoneno', 'mobile', 'mobileno'], required: true },
  { key: 'receivable', label: 'Receivable', names: ['receivable', 'receivableamount', 'toreceive'], required: true },
  { key: 'payable', label: 'Payable', names: ['payable', 'payableamount', 'topay'], required: true },
];

export interface PartyRow {
  /** Excel row number (1 = the first row of the sheet). */
  n: number;
  name: string;
  contact: string;
  /** 01XXXXXXXXX, or null when there is no phone or it isn't a mobile number. */
  phoneKey: string | null;
  receivable: number;
  payable: number;
}

const MOBILE = /^01[3-9]\d{8}$/;

/** Any way Kaarbar shows a number → 01XXXXXXXXX (null if not a BD mobile). */
export function cleanPhone(raw: string): string | null {
  const key = bdPhoneKey(raw);
  return key && MOBILE.test(key) ? key : null;
}

export function readParties(cells: readonly (readonly SheetCell[])[]): { rows: PartyRow[]; error: string | null } {
  const { header, error } = findHeader(cells, PARTY_COLUMNS, 'All Party Report');
  if (!header) return { rows: [], error };
  const c = header.columns;
  const rows: PartyRow[] = [];
  for (let i = header.row + 1; i < cells.length; i++) {
    const row = cells[i];
    if (isBlankRow(row)) continue;
    const name = cellText(cellAt(row, c.name)).replace(/\s+/g, ' ').trim();
    const contact = cellText(cellAt(row, c.contact)).trim();
    // A totals line at the bottom is not a party.
    if (name === '' || (/^(grand\s*)?total$/i.test(name) && contact === '')) continue;
    rows.push({
      n: i + 1,
      name,
      contact,
      phoneKey: cleanPhone(contact),
      receivable: parseAmountCell(cellAt(row, c.receivable)) ?? 0,
      payable: parseAmountCell(cellAt(row, c.payable)) ?? 0,
    });
  }
  if (rows.length === 0) return { rows, error: 'The file has no parties under the header.' };
  return { rows, error: null };
}

/** "Cash", "Walk-in", "Cash Sale", "Walk in customer" … */
export function isCashName(name: string): boolean {
  const k = name.toLowerCase().replace(/[^a-z]/g, '');
  return /^(cash|cashsale|cashsales|cashcustomer|walkin|walkincustomer|walkincustomers)$/.test(k);
}

export type CustomerGroup = 'new' | 'existing' | 'samePhone' | 'noPhone' | 'supplier' | 'cashName';

export interface SiteMatch {
  siteKey: string | null;
  siteName: string | null;
  siteDue: number;
}

export interface CustomerPreviewRow extends PartyRow {
  group: CustomerGroup;
  /** Rows that share one phone (or, with no phone, one name). */
  pairKey: string | null;
  tickable: boolean;
  tickedByDefault: boolean;
  site: SiteMatch;
}

/** The key the site would give this party: its phone, or its name. */
export function partyKey(row: Pick<PartyRow, 'phoneKey' | 'name'>): string {
  return row.phoneKey ? `ph:${row.phoneKey}` : `n:${row.name.trim().toLowerCase()}`;
}

export function classifyParties(rows: readonly PartyRow[], matches: ReadonlyMap<number, SiteMatch>): CustomerPreviewRow[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (matches.get(r.n)?.siteKey) continue;
    const k = partyKey(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return rows.map((r) => {
    const site = matches.get(r.n) ?? { siteKey: null, siteName: null, siteDue: 0 };
    const key = partyKey(r);
    let group: CustomerGroup;
    if (site.siteKey) group = 'existing';
    else if ((counts.get(key) ?? 0) > 1) group = 'samePhone';
    else if (r.payable > 0) group = 'supplier';
    else if (isCashName(r.name)) group = 'cashName';
    else if (!r.phoneKey) group = 'noPhone';
    else group = 'new';
    return {
      ...r,
      group,
      pairKey: group === 'samePhone' ? key : null,
      tickable: group !== 'existing',
      tickedByDefault: group === 'new' || group === 'noPhone',
      site,
    };
  });
}

/** Ticking one of a same-phone pair unticks the other: the site keeps one
 *  customer per phone number. */
export function toggleTick(rows: readonly CustomerPreviewRow[], ticked: ReadonlySet<number>, n: number): Set<number> {
  const next = new Set(ticked);
  const row = rows.find((r) => r.n === n);
  if (!row || !row.tickable) return next;
  if (next.has(n)) {
    next.delete(n);
    return next;
  }
  next.add(n);
  if (row.pairKey) {
    for (const other of rows) if (other.n !== n && other.pairKey === row.pairKey) next.delete(other.n);
  }
  return next;
}

export interface DueDifference {
  n: number;
  name: string;
  phoneKey: string | null;
  kaarbar: number;
  site: number;
}

/** Information only: whose Kaarbar Receivable differs from the site's due. */
export function dueDifferences(rows: readonly CustomerPreviewRow[]): DueDifference[] {
  return rows
    .filter((r) => Math.abs(Math.round(r.receivable) - Math.round(r.site.siteDue)) >= 1)
    .map((r) => ({ n: r.n, name: r.name, phoneKey: r.phoneKey, kaarbar: r.receivable, site: r.site.siteDue }));
}

export interface CustomerImportRow {
  name: string;
  phone_key: string | null;
  contact: string | null;
}

export function customerImportRows(rows: readonly CustomerPreviewRow[], ticked: ReadonlySet<number>): CustomerImportRow[] {
  const seen = new Set<string>();
  const out: CustomerImportRow[] = [];
  for (const r of rows) {
    if (!r.tickable || !ticked.has(r.n)) continue;
    const key = partyKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: r.name, phone_key: r.phoneKey, contact: r.phoneKey ? null : r.contact || null });
  }
  return out;
}

/* ---------------------------------------------------------- expenses */

type ExpenseColumn = 'date' | 'bill' | 'type' | 'category' | 'mode' | 'amount' | 'note';

const EXPENSE_COLUMNS: readonly ColumnSpec<ExpenseColumn>[] = [
  { key: 'date', label: 'Date', names: ['date', 'datetime', 'dateandtime'], required: true },
  { key: 'bill', label: 'Bill No', names: ['billno', 'billnumber', 'bill', 'billnum'], required: true },
  { key: 'type', label: 'Type', names: ['type'], required: true },
  { key: 'category', label: 'Category', names: ['category'], required: true },
  { key: 'mode', label: 'Payment Mode', names: ['paymentmode', 'paymentmethod', 'mode'], required: true },
  { key: 'amount', label: 'Total Amount', names: ['totalamount', 'amount', 'total'], required: true },
  { key: 'note', label: 'Notes/Remarks', names: ['notesremarks', 'notes', 'remarks', 'note', 'noteremarks'], required: false },
];

export interface ExpenseRow {
  n: number;
  /** YYYY-MM-DD, or null when the date can't be read. */
  date: string | null;
  dateText: string;
  billNo: string;
  type: string;
  category: string;
  mode: string;
  amount: number | null;
  /** Exactly as in Kaarbar (line breaks and Bengali kept). */
  note: string;
}

function billText(value: SheetCell): string {
  if (typeof value === 'number') return String(value);
  return cellText(value).trim();
}

export function readExpenses(cells: readonly (readonly SheetCell[])[]): { rows: ExpenseRow[]; error: string | null } {
  const { header, error } = findHeader(cells, EXPENSE_COLUMNS, 'Expense Report');
  if (!header) return { rows: [], error };
  const c = header.columns;
  const rows: ExpenseRow[] = [];
  for (let i = header.row + 1; i < cells.length; i++) {
    const row = cells[i];
    if (isBlankRow(row)) continue;
    const dateCell = cellAt(row, c.date);
    const billNo = billText(cellAt(row, c.bill));
    // A totals line (no date, no Bill No) is not an expense.
    if (billNo === '' && cellText(dateCell).trim() === '') continue;
    const note = cellText(cellAt(row, c.note));
    rows.push({
      n: i + 1,
      date: parseDateCell(dateCell),
      dateText: cellText(dateCell).trim(),
      billNo,
      type: cellText(cellAt(row, c.type)).trim(),
      category: cellText(cellAt(row, c.category)).replace(/\s+/g, ' ').trim(),
      mode: cellText(cellAt(row, c.mode)).trim(),
      amount: parseAmountCell(cellAt(row, c.amount)),
      note: note.trim() === '' ? '' : note,
    });
  }
  if (rows.length === 0) return { rows, error: 'The file has no expenses under the header.' };
  return { rows, error: null };
}

/** Category names compared without case or extra spaces. */
export function categoryKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isProfitShare(category: string): boolean {
  return categoryKey(category).replace(/[^a-z]/g, '') === 'profitshare';
}

/** Kaarbar's Payment Mode → the money account with that name / method. */
export function matchAccount(mode: string, accounts: readonly MoneyAccount[]): MoneyAccount | null {
  const m = mode.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (m === '') return null;
  const open = accounts.filter((a) => !a.archived && a.kind !== 'steadfast');
  const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    open.find((a) => norm(a.name) === m) ??
    open.find((a) => norm(a.payment_method) === m) ??
    open.find((a) => a.kind === m) ??
    null
  );
}

export type ExpenseStatus = 'new' | 'profitShare' | 'already' | 'notExpense' | 'locked' | 'noAccount' | 'bad';

export interface ExpenseContext {
  /** Money opening-balance date (YYYY-MM-DD). */
  startDate: string;
  today: string;
  lockedMonths: ReadonlySet<string>;
  billNos: ReadonlySet<string>;
  accounts: readonly MoneyAccount[];
}

export interface ExpensePreviewRow extends ExpenseRow {
  status: ExpenseStatus;
  reason: string;
  account: MoneyAccount | null;
  /** Before the start date: history only, no account balance changes. */
  history: boolean;
}

export function classifyExpenses(rows: readonly ExpenseRow[], ctx: ExpenseContext): ExpensePreviewRow[] {
  const billCount = new Map<string, number>();
  for (const r of rows) if (r.billNo) billCount.set(r.billNo, (billCount.get(r.billNo) ?? 0) + 1);
  return rows.map((r) => {
    const account = matchAccount(r.mode, ctx.accounts);
    const history = r.date !== null && r.date < ctx.startDate;
    const out = (status: ExpenseStatus, reason: string): ExpensePreviewRow => ({ ...r, status, reason, account, history });
    if (r.billNo === '') return out('bad', 'no Bill No');
    if ((billCount.get(r.billNo) ?? 0) > 1) return out('bad', 'Bill No is twice in the file');
    if (r.date === null) return out('bad', `date not readable${r.dateText ? ` ("${r.dateText}")` : ''}`);
    if (r.date > ctx.today) return out('bad', 'date is in the future');
    if (r.amount === null || r.amount <= 0) return out('bad', 'no amount above 0');
    if (r.type.trim().toLowerCase() !== 'expense') return out('notExpense', `Type is "${r.type || 'empty'}"`);
    if (ctx.billNos.has(r.billNo)) return out('already', 'already on the site');
    if (ctx.lockedMonths.has(r.date.slice(0, 7))) return out('locked', 'month is locked');
    if (!account) return out('noAccount', `no money account for "${r.mode || 'empty'}"`);
    if (r.category === '') return out('bad', 'no category');
    if (isProfitShare(r.category)) return out('profitShare', 'profit share');
    return out('new', history ? 'history (before the start date)' : 'new');
  });
}

/** Who a PROFIT SHARE row was paid to: "party:<id>", "owner", or "" (leave out). */
export type ProfitShareWho = string;

export function defaultProfitShareWho(note: string, investors: readonly Party[]): ProfitShareWho {
  const text = note.toLowerCase();
  const named = investors.find((p) => {
    const first = p.name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    return first.length >= 3 && text.includes(first);
  });
  if (named) return `party:${named.id}`;
  return investors.length === 1 ? `party:${investors[0].id}` : '';
}

export interface ExpenseImportRow {
  bill_no: string;
  date: string;
  kind: 'expense' | 'investor_profit_share' | 'owner_withdrawal';
  category: string | null;
  account_id: string;
  party_id: string | null;
  amount: number;
  note: string;
}

export function expenseImportRows(
  rows: readonly ExpensePreviewRow[],
  who: ReadonlyMap<string, ProfitShareWho>
): ExpenseImportRow[] {
  const out: ExpenseImportRow[] = [];
  for (const r of rows) {
    if (!r.account || r.date === null || r.amount === null) continue;
    if (r.status === 'new') {
      out.push({ bill_no: r.billNo, date: r.date, kind: 'expense', category: r.category, account_id: r.account.id, party_id: null, amount: r.amount, note: r.note });
    } else if (r.status === 'profitShare') {
      const w = who.get(r.billNo) ?? '';
      if (w === 'owner') {
        out.push({ bill_no: r.billNo, date: r.date, kind: 'owner_withdrawal', category: null, account_id: r.account.id, party_id: null, amount: r.amount, note: r.note });
      } else if (w.startsWith('party:')) {
        out.push({
          bill_no: r.billNo,
          date: r.date,
          kind: 'investor_profit_share',
          category: null,
          account_id: r.account.id,
          party_id: w.slice(6),
          amount: r.amount,
          note: r.note,
        });
      }
    }
  }
  return out;
}

export interface Total {
  key: string;
  label: string;
  amount: number;
  count: number;
}

function addTo(map: Map<string, Total>, key: string, label: string, amount: number) {
  const t = map.get(key) ?? { key, label, amount: 0, count: 0 };
  t.amount += amount;
  t.count += 1;
  map.set(key, t);
}

/** Totals of the expenses that will be added, by month (newest first). */
export function totalsByMonth(rows: readonly ExpensePreviewRow[]): Total[] {
  const map = new Map<string, Total>();
  for (const r of rows) if (r.status === 'new' && r.date && r.amount) addTo(map, r.date.slice(0, 7), r.date.slice(0, 7), r.amount);
  return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
}

/** Totals of the expenses that will be added, by category (largest first). */
export function totalsByCategory(rows: readonly ExpensePreviewRow[]): Total[] {
  const map = new Map<string, Total>();
  for (const r of rows) if (r.status === 'new' && r.amount) addTo(map, categoryKey(r.category), r.category, r.amount);
  return [...map.values()].sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
}

/** How much each money account goes down: only rows on or after the start date. */
export function accountDecreases(rows: readonly ExpenseImportRow[], startDate: string, accounts: readonly MoneyAccount[]): Total[] {
  const map = new Map<string, Total>();
  for (const r of rows) {
    if (r.date < startDate) continue;
    const name = accounts.find((a) => a.id === r.account_id)?.name ?? 'Account';
    addTo(map, r.account_id, name, r.amount);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

/** Newest first; the same day by Bill No (largest first). */
export function newestFirst<T extends { date: string | null; billNo: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.billNo.localeCompare(a.billNo, undefined, { numeric: true }));
}
