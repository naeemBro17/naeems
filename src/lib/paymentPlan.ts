// Batch 32 Part 1 — the payment section of New order / Edit order: what was
// "paid now", then what happens to the rest (the courier collects it, or the
// customer pays later). Pure code: the live summary on screen and the order
// list's small payment tag. The COD rule itself lives in one place,
// supabase/functions/_shared/cod.ts, shared with the steadfast function.
import { courierCod, normalizeCollectMode, type CollectMode } from '../../supabase/functions/_shared/cod';
import type { PaymentSummary } from './payments';

export { courierCod, normalizeCollectMode, type CollectMode };

export const COLLECT_MODE_LABELS: Record<CollectMode, string> = {
  cod: 'Collect on delivery',
  pay_later: 'Customer pays later',
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PaymentPlan {
  /** What was typed as paid now (0 when empty or not a number). */
  paidNow: number;
  /** Total minus everything paid (already + now), never below 0. */
  remaining: number;
  /** What the courier will collect. */
  courierCollects: number;
  /** Still owed by the customer after the courier delivers. */
  dueAfterDelivery: number;
  /** Inline error for the Paid now field, or null. */
  error: string | null;
}

/**
 * The live summary. `alreadyPaid` is what earlier payments on the order
 * add up to (0 for a new order).
 */
export function planPayment(input: {
  total: number;
  paidNowInput: string;
  mode: CollectMode;
  alreadyPaid?: number;
  formatMoney: (n: number) => string;
}): PaymentPlan {
  const { total, paidNowInput, mode, formatMoney } = input;
  const alreadyPaid = Math.max(0, input.alreadyPaid ?? 0);
  const raw = paidNowInput.trim();
  const parsed = raw === '' ? 0 : Number(raw);
  const room = Math.max(0, round2(total - alreadyPaid));
  let error: string | null = null;
  if (!Number.isFinite(parsed) || parsed < 0) {
    error = 'Enter an amount of 0 or more.';
  } else if (parsed > room) {
    error = `Paid now can be at most ${formatMoney(room)}.`;
  }
  const paidNow = error ? 0 : round2(parsed);
  const paid = round2(alreadyPaid + paidNow);
  const remaining = Math.max(0, round2(total - paid));
  const courierCollects = courierCod(total, paid, mode);
  return {
    paidNow,
    remaining,
    courierCollects,
    dueAfterDelivery: round2(remaining - courierCollects),
    error,
  };
}

/** The old payment column an order keeps for the invoice and older screens
 *  (the database works out the same; this is for previews and fallbacks). */
export function legacyPaymentMethod(input: {
  total: number;
  paidNow: number;
  method: string | null;
  mode: CollectMode;
}): 'cod' | 'bkash' | 'cash' | 'due' {
  if (input.paidNow > 0 && input.paidNow >= input.total) return input.method === 'bkash' ? 'bkash' : 'cash';
  return input.mode === 'pay_later' ? 'due' : 'cod';
}

/**
 * The small neutral tag on the Orders list:
 *   "COD", "Paid", "Advance ৳1,000 · rest COD", "Due · pays later",
 *   "Advance ৳1,000 · ৳X due later". Null when nothing useful to say
 *   (refunded / cancelled — the state text already says it).
 */
export function orderPaymentTag(
  order: { total: number; status: string; collect_mode?: string | null },
  summary: Pick<PaymentSummary, 'paid' | 'due' | 'state'>,
  formatMoney: (n: number) => string
): string | null {
  if (order.status === 'cancelled' || summary.state === 'refunded') return null;
  const mode = normalizeCollectMode(order.collect_mode);
  if (summary.due <= 0) return 'Paid';
  if (summary.paid <= 0) return mode === 'pay_later' ? 'Due · pays later' : 'COD';
  const advance = `Advance ${formatMoney(summary.paid)}`;
  return mode === 'pay_later' ? `${advance} · ${formatMoney(summary.due)} due later` : `${advance} · rest COD`;
}
