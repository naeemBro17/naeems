import { useEffect, useState } from 'react';

/**
 * Batch 53: how sure the courier + COD fee of one order is
 * (order_courier_costs_for in migration-054).
 *   exact      the payout held only this parcel: Steadfast's own numbers
 *   share      a share of a payout with several parcels (an estimate)
 *   expected   delivered, no payout yet: an expected fee
 *   none       handed over by hand: ৳0, final
 *   not_booked never booked on Steadfast: ৳0
 *   unknown    no payout and none of the above (shipped, returned)
 */
export type CourierKind = 'exact' | 'share' | 'expected' | 'none' | 'not_booked' | 'unknown';

export interface CourierLabel {
  /** The small grey label beside the amount. */
  label: string;
  /** An extra line under it, when one helps. */
  note: string | null;
}

const LABELS: Record<CourierKind, CourierLabel> = {
  exact: { label: 'From Steadfast', note: null },
  share: { label: 'Share of payout', note: null },
  expected: { label: 'Expected', note: 'Waiting for Steadfast payout' },
  none: { label: 'No courier', note: null },
  not_booked: { label: 'Not booked on Steadfast', note: null },
  unknown: { label: 'Not known yet', note: null },
};

export function isCourierKind(value: unknown): value is CourierKind {
  return typeof value === 'string' && value in LABELS;
}

/** The label for an order's courier amount. Before migration-054 runs the
 *  database sends no kind: then only "not known yet" is said, as before. */
export function courierLabel(kind: unknown, known: boolean): CourierLabel | null {
  if (isCourierKind(kind)) return LABELS[kind];
  return known ? null : LABELS.unknown;
}

/* ---------------- Refreshing an open order page ---------------- */

const EVENT = 'naeems:courier-costs-changed';
const CHANNEL = 'naeems-courier-costs';

/** Called after the Payouts page's Refresh: tells every open order page
 *  (this tab and other tabs) to read its profit again. */
export function announceCourierCostsChanged(): void {
  window.dispatchEvent(new Event(EVENT));
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage('changed');
  channel.close();
}

/**
 * A number that goes up whenever courier costs may have changed: the page
 * became visible again (tab or app came back), or the Payouts page was
 * refreshed (here or in another tab). No timer: nothing is read while the
 * page just sits there (Supabase bandwidth).
 */
export function useCourierCostsRefresh(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const onVisible = () => {
      if (document.visibilityState === 'visible') bump();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(EVENT, bump);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
    if (channel) channel.onmessage = bump;
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(EVENT, bump);
      channel?.close();
    };
  }, []);
  return tick;
}
