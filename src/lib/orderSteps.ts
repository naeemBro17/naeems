import { supabase } from './supabase';
import {
  ORDER_STEPS,
  deriveOrderStep,
  stepFromTrackingText,
  stepLabel,
  type StepResult,
  type TrackingEvent,
} from '../../supabase/functions/_shared/steadfastSteps';
import type { Order } from '../types';

export { ORDER_STEPS, deriveOrderStep, stepLabel };
export type { StepResult, TrackingEvent };

/* Batch 30 Part 5 — the real order steps. The step rules live in
   supabase/functions/_shared/steadfastSteps.ts (shared with the steadfast
   function); this file adds the website side: asking the function for the
   parcel's tracking steps, with a short cache. */

export interface TrackingAnswer {
  courierStatus: string | null;
  events: TrackingEvent[];
  fetchedAt: string | null;
}

/** Steadfast caches answers 60 s, so asking sooner tells nothing new. */
const CACHE_MS = 60_000;
const memory = new Map<string, { at: number; answer: TrackingAnswer }>();

function readSession(orderId: string): { at: number; answer: TrackingAnswer } | null {
  try {
    const raw = window.sessionStorage.getItem(`order-tracking:${orderId}`);
    return raw ? (JSON.parse(raw) as { at: number; answer: TrackingAnswer }) : null;
  } catch {
    return null;
  }
}

function writeSession(orderId: string, value: { at: number; answer: TrackingAnswer }): void {
  try {
    window.sessionStorage.setItem(`order-tracking:${orderId}`, JSON.stringify(value));
  } catch {
    // Private mode / storage full: the in-memory copy still works.
  }
}

/**
 * The parcel's tracking steps from the steadfast function. Null when the
 * function doesn't have the "tracking" action yet (not deployed) or can't
 * be reached — the page then shows what is saved on the order, exactly as
 * before, with no error.
 */
export async function fetchTracking(orderId: string): Promise<TrackingAnswer | null> {
  const now = Date.now();
  const cached = memory.get(orderId) ?? readSession(orderId);
  if (cached && now - cached.at < CACHE_MS) return cached.answer;

  try {
    const { data, error } = await supabase.functions.invoke('steadfast', { body: { action: 'tracking', orderId } });
    if (error) return null;
    const body = data as { ok?: boolean; courierStatus?: string | null; events?: TrackingEvent[]; fetchedAt?: string | null };
    if (!body?.ok || !Array.isArray(body.events)) return null;
    const answer: TrackingAnswer = {
      courierStatus: body.courierStatus ?? null,
      events: body.events,
      fetchedAt: body.fetchedAt ?? null,
    };
    const entry = { at: now, answer };
    memory.set(orderId, entry);
    writeSession(orderId, entry);
    return answer;
  } catch {
    return null;
  }
}

/** The step for an order from what is saved on it (lists, no live call). */
export function savedOrderStep(order: Pick<Order, 'status' | 'steadfast_consignment_id' | 'steadfast_status'>): StepResult {
  return deriveOrderStep({
    status: order.status,
    booked: Boolean(order.steadfast_consignment_id),
    courierStatus: order.steadfast_status,
  });
}

/**
 * When each step was reached, where the site knows it: the order's own
 * History for placed / processing / booked / delivered, and the first
 * Steadfast tracking text that proves In Transit / Out for Delivery.
 */
export function stepTimesFrom(
  history: { new_status: string; changed_at: string }[],
  events: TrackingEvent[]
): Partial<Record<(typeof ORDER_STEPS)[number]['id'], string>> {
  const firstHistory = (status: string) => history.find((h) => h.new_status === status)?.changed_at;
  const firstEvent = (step: string) => events.find((e) => stepFromTrackingText(e.text) === step)?.at ?? undefined;
  const times: Partial<Record<(typeof ORDER_STEPS)[number]['id'], string>> = {};
  const set = (id: (typeof ORDER_STEPS)[number]['id'], value: string | undefined) => {
    if (value) times[id] = value;
  };
  set('placed', firstHistory('pending') ?? history[0]?.changed_at);
  set('processing', firstHistory('confirmed'));
  set('booked', firstHistory('shipped'));
  set('in_transit', firstEvent('in_transit'));
  set('out_for_delivery', firstEvent('out_for_delivery'));
  set('delivered', firstHistory('delivered'));
  return times;
}
