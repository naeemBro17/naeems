// The six order steps a customer and the admin see (Batch 30 Part 5), and
// how Steadfast's statuses and tracking texts map onto them. Pure code (no
// Deno or browser APIs) so the steadfast functions and the website share
// one copy — the website imports this file directly, the same way
// src/lib/testOrders.test.ts imports _shared/testOrders.ts.
//
// Statuses and the /trackings_by_invoice shape come from Steadfast's own
// API guide PDF. Tracking texts are free English written by Steadfast's
// staff, so the text rules are tolerant (case-insensitive, any hub name)
// and a text no rule recognises never moves the order forward.

export const ORDER_STEPS = [
  { id: 'placed', label: 'Order Placed' },
  { id: 'processing', label: 'Processing' },
  { id: 'booked', label: 'Booked' },
  { id: 'in_transit', label: 'In Transit' },
  { id: 'out_for_delivery', label: 'Out for Delivery' },
  { id: 'delivered', label: 'Delivered' },
] as const;

export type OrderStepId = (typeof ORDER_STEPS)[number]['id'];

/** Off the normal path — shown instead of the next step. */
export type OrderSideState = 'partly_delivered' | 'cancelled' | 'returning' | 'on_hold' | 'needs_attention';

export const SIDE_STATE_LABELS: Record<OrderSideState, string> = {
  partly_delivered: 'Partly delivered',
  cancelled: 'Cancelled',
  returning: 'Cancelled / Returning',
  on_hold: 'On hold',
  needs_attention: 'Needs attention',
};

/** The same side states in words for the customer (no internal wording). */
export const CUSTOMER_SIDE_STATE_LABELS: Record<OrderSideState, string> = {
  partly_delivered: 'Partly delivered',
  cancelled: 'Cancelled',
  returning: 'Cancelled / Returning',
  on_hold: 'On hold',
  needs_attention: "Delayed — we're checking",
};

export interface TrackingEvent {
  text: string;
  /** ISO time from Steadfast, or null when it sent none. */
  at: string | null;
}

const STEP_INDEX: Record<OrderStepId, number> = {
  placed: 0,
  processing: 1,
  booked: 2,
  in_transit: 3,
  out_for_delivery: 4,
  delivered: 5,
};

const HUB_WORD = /\b(hub|warehouse|sorting|depot)\b/i;
const HUB_MOVE = /\b(sent|send|received|receive|arrived|reached|dispatched|transferred|returned|shifted|moved)\b/i;
const RIDER_ASSIGNED =
  /(assigned to (a |the )?(rider|delivery ?man|dm\b)|rider (is )?assigned|delivery ?man assigned|out for delivery|on the way to (the )?(customer|recipient))/i;
const CREATED = /\b(consignment created|created by sender|parcel created|order created)\b/i;

/**
 * One tracking text → the step it proves, or null when the text says
 * nothing this site understands (then the last known step stays).
 *   "… sent to / received at … HUB / WAREHOUSE"  → In Transit
 *   "Assigned to rider …"                         → Out for Delivery
 *   "Consignment created …"                       → Booked
 * A hub movement wins over a rider mention ("returned to hub by rider")
 * because the parcel is back at the hub.
 */
export function stepFromTrackingText(text: string): OrderStepId | null {
  const t = text.trim();
  if (t === '') return null;
  if (HUB_WORD.test(t) && HUB_MOVE.test(t)) return 'in_transit';
  if (RIDER_ASSIGNED.test(t)) return 'out_for_delivery';
  if (HUB_WORD.test(t)) return 'in_transit';
  if (CREATED.test(t)) return 'booked';
  return null;
}

/** Oldest first; events without a time keep the order Steadfast sent. */
export function sortEvents(events: TrackingEvent[]): TrackingEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.at && b.e.at && a.e.at !== b.e.at) return a.e.at < b.e.at ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.e);
}

export interface StepInput {
  /** The order's own status on this site. */
  status: 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';
  /** Booked on Steadfast (has a consignment id). */
  booked: boolean;
  /** Steadfast's delivery_status, as saved or just fetched. */
  courierStatus: string | null;
  /** Steadfast's tracking steps, any order. */
  events?: TrackingEvent[];
}

export interface StepResult {
  /** Index into ORDER_STEPS of the step reached. */
  index: number;
  /** Set when the order left the normal path. */
  side: OrderSideState | null;
  /** The rider has marked it delivered but Steadfast hasn't confirmed. */
  awaitingConfirmation: boolean;
  /** The newest tracking step, if any. */
  latest: TrackingEvent | null;
}

/** The newest event a rule recognises, and its step. */
function latestRecognised(events: TrackingEvent[]): OrderStepId | null {
  const sorted = sortEvents(events);
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const step = stepFromTrackingText(sorted[i].text);
    if (step) return step;
  }
  return null;
}

export function deriveOrderStep(input: StepInput): StepResult {
  const events = input.events ?? [];
  const sorted = sortEvents(events);
  const latest = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const result = (index: number, side: OrderSideState | null, awaitingConfirmation = false): StepResult => ({
    index,
    side,
    awaitingConfirmation,
    latest,
  });

  const courier = input.booked ? (input.courierStatus ?? '').trim() : '';

  if (input.status === 'cancelled') return result(STEP_INDEX.placed, 'cancelled');

  if (courier === 'delivered') return result(STEP_INDEX.delivered, null);
  if (courier === 'delivered_approval_pending') return result(STEP_INDEX.delivered, null, true);
  if (courier.startsWith('partial_delivered')) return result(STEP_INDEX.delivered, 'partly_delivered');
  if (courier.startsWith('cancelled')) return result(STEP_INDEX.in_transit, 'returning');
  if (courier === 'hold') return result(STEP_INDEX.in_transit, 'on_hold');
  if (courier === 'exceptional' || courier === 'unknown' || courier === 'unknown_approval_pending') {
    return result(STEP_INDEX.in_transit, 'needs_attention');
  }

  if (input.status === 'delivered') return result(STEP_INDEX.delivered, null);

  if (input.booked) {
    // in_review, or booked with no status yet → Booked; pending → In Transit.
    const base = courier === 'pending' ? STEP_INDEX.in_transit : STEP_INDEX.booked;
    const fromText = latestRecognised(events);
    const textIndex = fromText ? STEP_INDEX[fromText] : -1;
    return result(Math.max(base, textIndex), null);
  }

  // Not on Steadfast: marked shipped by hand (another courier) → In Transit.
  if (input.status === 'shipped') return result(STEP_INDEX.in_transit, null);
  if (input.status === 'confirmed') return result(STEP_INDEX.processing, null);
  return result(STEP_INDEX.placed, null);
}

/** The words for where the order is now. */
export function stepLabel(step: StepResult, audience: 'customer' | 'admin'): string {
  if (step.side) {
    return audience === 'customer' ? CUSTOMER_SIDE_STATE_LABELS[step.side] : SIDE_STATE_LABELS[step.side];
  }
  if (step.awaitingConfirmation && audience === 'admin') return 'Delivered — awaiting Steadfast confirmation';
  return ORDER_STEPS[step.index].label;
}

const PHONE_NUMBER = /(?:\+?88\s?)?0?1[3-9](?:[\s-]?\d){8}/g;
const RIDER_WORDS = /\b(rider|delivery ?man|dm)\b/i;

/**
 * A tracking text made safe for the customer: never a rider's name or
 * phone. Anything about a rider becomes one plain sentence; any other text
 * loses phone numbers.
 */
export function customerSafeText(text: string): string {
  if (RIDER_WORDS.test(text)) {
    return stepFromTrackingText(text) === 'in_transit'
      ? 'Your parcel is back at the courier hub.'
      : 'Assigned to a rider — your parcel is out for delivery.';
  }
  return text.replace(PHONE_NUMBER, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').trim();
}

/** Steadfast's raw /trackings_by_invoice body → plain events. */
export function parseTrackingResponse(body: unknown): TrackingEvent[] {
  if (!body || typeof body !== 'object') return [];
  const list = (body as { tracking?: unknown }).tracking;
  if (!Array.isArray(list)) return [];
  const events: TrackingEvent[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { text?: unknown; created_at?: unknown };
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (text === '') continue;
    events.push({ text, at: typeof row.created_at === 'string' ? row.created_at : null });
  }
  return sortEvents(events);
}
