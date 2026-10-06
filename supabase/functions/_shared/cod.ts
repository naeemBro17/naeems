// The COD amount a parcel is booked with. Shared by the steadfast function
// and the admin screens ("Book with Steadfast?" confirmation, the "COD on
// Steadfast should now be" banner, the New order summary) so all of them
// always agree.
//
// Batch 32 Part 1 — the one rule:
//   courier_cod = collect_mode = 'pay_later' ? 0 : max(0, total − paid)
// 'cod' (every order before Batch 32, and every website order): the courier
// collects whatever is still due. 'pay_later': the courier collects ৳0 and
// the rest stays due on the customer.

export type CollectMode = 'cod' | 'pay_later';

export const COLLECT_MODES: readonly CollectMode[] = ['cod', 'pay_later'];

/** Any stored value that isn't exactly 'pay_later' (including a missing
 *  column before migration-035) means the normal rule. */
export function normalizeCollectMode(value: unknown): CollectMode {
  return value === 'pay_later' ? 'pay_later' : 'cod';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The rule itself, from the order total and what has been paid so far. */
export function courierCod(total: number, paid: number, collectMode: CollectMode | null | undefined): number {
  if (normalizeCollectMode(collectMode) === 'pay_later') return 0;
  return Math.max(0, round2(Number(total) - Number(paid)));
}

/**
 * The same rule for a saved order. `due` is what is still due (total minus
 * every payment recorded, Batch 30); it is null before migration-033 (no
 * payments table yet) — then the Batch 22 rule stays: 0 when the order is
 * marked paid, otherwise the total.
 */
export function codAmountFor(
  order: { payment_status: string; total: number; collect_mode?: string | null },
  due: number | null
): number {
  if (normalizeCollectMode(order.collect_mode) === 'pay_later') return 0;
  if (due !== null && Number.isFinite(due)) {
    return Math.max(0, round2(due));
  }
  return order.payment_status === 'paid' ? 0 : Number(order.total);
}
