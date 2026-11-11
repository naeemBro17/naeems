/* Batch 43: sales speed and dates — the plain rules every smart helper
   shares. Dates are Dhaka dates "YYYY-MM-DD". */

/** Days in an average month (the Stock report uses the same). */
export const DAYS_PER_MONTH = 30.4;

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface Speed {
  /** Units a month. */
  perMonth: number;
  /** Less than 30 days of history: the speed is from what exists. */
  isNew: boolean;
}

/**
 * Units sold in the last 90 days ÷ 3 = a month (the same as the Stock
 * report). With fewer than 30 days of history, the units sold so far
 * scaled to 30 days, marked "new".
 */
export function salesSpeed(units90: number, historyDays: number): Speed {
  if (historyDays >= 30) return { perMonth: round1(units90 / 3), isNew: false };
  return { perMonth: round1((units90 / Math.max(historyDays, 1)) * 30), isNew: true };
}

function utc(date: string): number {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** The last day of the expiry month: a product is good until then. */
export function expiryEnd(expiry: string): string {
  const [y, m] = expiry.slice(0, 10).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

export function isExpired(expiry: string, today: string): boolean {
  return expiryEnd(expiry) < today;
}

/** Months until the end of the expiry month (0 when it has passed). */
export function monthsToExpiry(expiry: string, today: string): number {
  return Math.max(daysBetween(today, expiryEnd(expiry)), 0) / DAYS_PER_MONTH;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mar 2027" from "2027-03-01". */
export function expiryText(expiry: string): string {
  const [y, m] = expiry.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2", "2.5" — at most one decimal. */
export function amountText(n: number): string {
  const r = round1(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** "4 months", "1 month", "less than a month". */
export function monthsText(months: number): string {
  if (months < 1) return 'less than a month';
  const r = Math.round(months);
  return r === 1 ? '1 month' : `${r} months`;
}

/** "2" for pieces, "400 ml" for ml / g. */
export function unitsText(units: number, stockUnit: string): string {
  return stockUnit === 'pcs' ? amountText(units) : `${amountText(units)} ${stockUnit}`;
}
