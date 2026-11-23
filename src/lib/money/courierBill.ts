import type { CourierBillStatus } from './types';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "21 Nov" from "2026-11-21". */
export function shortDay(date: string): string {
  const [, m, d] = date.slice(0, 10).split('-').map(Number);
  return `${d} ${SHORT_MONTHS[m - 1]}`;
}

export type CourierBillLine = { kind: 'owed'; amount: number } | { kind: 'paid'; text: string } | null;

/**
 * Batch 58: what the order page says after "delivery bill ৳65 paid outside
 * this payout": still owed (not taken from any account yet), or where it
 * was paid from. Nothing for a bill on an order counted before the money
 * start date (it is inside the opening balances).
 */
export function courierBillLine(status: CourierBillStatus | null): CourierBillLine {
  if (!status || status.bill <= 0) return null;
  if (Math.round(status.owed * 100) > 0) return { kind: 'owed', amount: status.owed };
  if (status.payments.length === 0) return null;
  const parts = status.payments.map((p) => `${p.account} on ${shortDay(p.date)}`);
  return { kind: 'paid', text: `paid from ${parts.join(', ')}` };
}
