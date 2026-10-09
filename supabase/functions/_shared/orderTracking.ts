// Batch 35 Part 1 — ONE set of order status names for Naeem and the
// customer, and the friendly words for Steadfast's tracking updates.
//
// Every screen (admin list, admin order page, customer order page, My
// orders) and the Telegram text read from this file. Pure code (no Deno or
// browser APIs) so the steadfast functions and the website share one copy,
// the same way they already share steadfastSteps.ts.
//
// The database values are NOT renamed: an order's own status stays
// pending / confirmed / shipped / delivered / cancelled, and Steadfast's
// delivery_status stays as Steadfast sends it. This file only maps them.
//
// What Steadfast really sends (checked against live tracking answers, read
// only, Batch 35): /status_by_cid gives one delivery_status; the tracking
// list (/trackings_by_invoice) gives short English texts with a time, e.g.
//   "Consignment created by Sender(API)."
//   "Consignment status has been updated as Pending"
//   "Consignment sent to MIRPUR WAREHOUSE.  Dispatch ID: 18085103"
//   "Consignment has been received at PALLABI."
//   "Assigned to rider."  /  "Assigned to rider by self-scan at the hub."
//   "Consignment marked as delivered by rider."
// plus Naeem's own edits ("Changes: COD '4079' to '0'. By User Naeem(…)",
// "Address change requested …") which a customer must never see. No
// rider name or phone has ever been in these texts.

import { stepFromTrackingText, sortEvents, type TrackingEvent } from './steadfastSteps.ts';

export type { TrackingEvent };

/** The seven main statuses, in order. */
export type TrackStatus =
  | 'processing'
  | 'confirmed'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'returned';

export const TRACK_STATUS_ORDER: readonly TrackStatus[] = [
  'processing',
  'confirmed',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'returned',
];

export type TrackIcon = 'receipt' | 'check' | 'truck' | 'bike' | 'house' | 'cross' | 'return';

export interface TrackStatusInfo {
  /** Naeem's name for it (admin list, admin order page, Telegram). */
  admin: string;
  /** The customer's name for it. Only "Processing" reads differently. */
  customer: string;
  /** Pill colour (see .track-pill--{tone} in app.css / admin.css). */
  tone: 'amber' | 'blue' | 'purple' | 'teal' | 'green' | 'red' | 'grey';
  icon: TrackIcon;
}

export const TRACK_STATUS: Record<TrackStatus, TrackStatusInfo> = {
  processing: { admin: 'Processing', customer: 'Order placed', tone: 'amber', icon: 'receipt' },
  confirmed: { admin: 'Confirmed', customer: 'Confirmed', tone: 'blue', icon: 'check' },
  in_transit: { admin: 'In transit', customer: 'In transit', tone: 'purple', icon: 'truck' },
  out_for_delivery: { admin: 'Out for delivery', customer: 'Out for delivery', tone: 'teal', icon: 'bike' },
  delivered: { admin: 'Delivered', customer: 'Delivered', tone: 'green', icon: 'house' },
  cancelled: { admin: 'Cancelled', customer: 'Cancelled', tone: 'red', icon: 'cross' },
  returned: { admin: 'Returned', customer: 'Returned', tone: 'grey', icon: 'return' },
};

/** The five steps the customer's tracking card walks through. */
export const TRACK_STEPS: readonly TrackStatus[] = ['processing', 'confirmed', 'in_transit', 'out_for_delivery', 'delivered'];

/** Index into TRACK_STEPS, or -1 for Cancelled / Returned (no steps). */
export function stepIndexOf(status: TrackStatus): number {
  return TRACK_STEPS.indexOf(status);
}

/** The order's own status, as saved (never renamed in the database). */
export type SavedOrderStatus = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';

/** The admin name for a saved status — for history lines and toasts. */
export const SAVED_STATUS_NAME: Record<SavedOrderStatus, string> = {
  pending: 'Processing',
  confirmed: 'Confirmed',
  shipped: 'In transit',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/** Something off the normal path, shown as a note — never a new status. */
export type TrackNote = 'on_hold' | 'needs_attention' | 'partly_delivered' | 'awaiting_confirmation';

export interface TrackInput {
  status: SavedOrderStatus;
  /** Booked on Steadfast (has a consignment id). */
  booked: boolean;
  /** Steadfast's delivery_status, as saved or just fetched. */
  courierStatus: string | null;
  /** Steadfast's tracking texts, any order (raw or already translated). */
  events?: TrackingEvent[];
  /** The latest step a stored update proves (see latestStoredStep), for
   *  lists that don't have the texts themselves. */
  storedStep?: TrackStatus | null;
}

export interface TrackResult {
  status: TrackStatus;
  /** Index into TRACK_STEPS (-1 for Cancelled / Returned). */
  stepIndex: number;
  note: TrackNote | null;
  /** An update says the parcel reached the customer's delivery hub. */
  reachedArea: boolean;
}

/**
 * The one mapping. Rules, in order:
 *   order cancelled on the site                        → Cancelled
 *   Steadfast delivered / partial / delivered_approval → Delivered
 *   Steadfast cancelled* (every return state)          → Returned
 *   order marked delivered                             → Delivered
 *   pending  (not accepted yet)                        → Processing
 *   confirmed, not booked                              → Confirmed
 *   booked (any other courier state) or marked shipped → In transit,
 *     or Out for delivery when the newest recognised update is
 *     "Assigned to rider" (a later "back at the hub" puts it back).
 * hold / exceptional / unknown stay In transit with a note.
 */
export function trackOrder(input: TrackInput): TrackResult {
  const courier = input.booked ? (input.courierStatus ?? '').trim() : '';
  const events = input.events ?? [];
  const reachedArea = events.some((e) => translateCourierText(e.text).kind === 'area_hub');
  const result = (status: TrackStatus, note: TrackNote | null = null): TrackResult => ({
    status,
    stepIndex: stepIndexOf(status),
    note,
    reachedArea,
  });

  if (input.status === 'cancelled') return result('cancelled');
  if (courier === 'delivered') return result('delivered');
  if (courier === 'delivered_approval_pending') return result('delivered', 'awaiting_confirmation');
  if (courier.startsWith('partial_delivered')) return result('delivered', 'partly_delivered');
  if (courier.startsWith('cancelled')) return result('returned');
  if (input.status === 'delivered') return result('delivered');
  if (input.status === 'pending') return result('processing');
  if (input.status === 'confirmed' && !input.booked) return result('confirmed');

  const note: TrackNote | null =
    courier === 'hold'
      ? 'on_hold'
      : courier === 'exceptional' || courier === 'unknown' || courier === 'unknown_approval_pending'
        ? 'needs_attention'
        : null;
  const fromText = latestStepFromEvents(events);
  const latest = fromText ?? input.storedStep ?? null;
  if (latest === 'out_for_delivery' && note === null) return result('out_for_delivery');
  return result('in_transit', note);
}

/** The newest update that proves a step (In transit / Out for delivery). */
export function latestStepFromEvents(events: TrackingEvent[]): TrackStatus | null {
  const sorted = sortEvents(events);
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const step = translateCourierText(sorted[i].text).step;
    if (step === 'out_for_delivery' || step === 'in_transit') return step;
  }
  return null;
}

/** The customer's step state for the tracking card. */
export type StepState = 'done' | 'current' | 'upcoming';

/** Earlier steps fill automatically: everything before the current one is
 *  done, even when its own event never arrived (e.g. Delivered without an
 *  Out for delivery update). */
export function stepStates(track: TrackResult): StepState[] {
  return TRACK_STEPS.map((_, index) =>
    track.stepIndex < 0 ? 'upcoming' : index < track.stepIndex ? 'done' : index === track.stepIndex ? 'current' : 'upcoming'
  );
}

/* ------------------------------------------------------------------ */
/* Steadfast's texts in friendly English                              */
/* ------------------------------------------------------------------ */

export type CourierTextKind =
  | 'created'
  | 'picked_up'
  | 'to_sorting'
  | 'at_sorting'
  | 'to_area_hub'
  | 'area_hub'
  | 'rider'
  | 'delivered'
  | 'returned'
  | 'status'
  | 'internal'
  | 'other';

export interface CourierText {
  kind: CourierTextKind;
  /** The step this update proves, or null. */
  step: TrackStatus | null;
  /** Short friendly English for the customer; null = never shown to them. */
  friendly: string | null;
}

const PHONE_NUMBER = /(?:\+?88\s?)?0?1[3-9](?:[\s-]?\d){8}/g;
const SORTING_WORDS = /\b(sub\s+)?(warehouse|sorting\s+cent(?:er|re)|shorting\s+cent(?:er|re)|sort\s+cent(?:er|re)|sorting|depot)\b/i;
const RIDER_WORDS = /\b(rider|delivery\s?man|dm)\b/i;
const INTERNAL =
  /^(changes?:|address\s+(has\s+been\s+)?change|note\s|cod\s|price\s)|\bby\s+user\b|\bcod\s+'|\binvoice\b|\bapproved\s+by\b|\bdelivery\s+charge\b|\bweight\b|\blabel\s+reprint/i;

/** Every sentence translateCourierText writes, so it reads them back. */
const FRIENDLY_FORMS: [RegExp, CourierTextKind, TrackStatus | null][] = [
  [/^Handed to Steadfast$/, 'created', 'in_transit'],
  [/^Picked up by Steadfast$/, 'picked_up', 'in_transit'],
  [/^On the way to the (.+ )?sorting centre$/, 'to_sorting', 'in_transit'],
  [/^Reached the (.+ )?sorting centre$/, 'at_sorting', 'in_transit'],
  [/^Moving between courier hubs$/, 'at_sorting', 'in_transit'],
  [/^On the way to (.+ delivery hub|your local delivery hub)$/, 'to_area_hub', 'in_transit'],
  [/^Arrived at (.+ delivery hub|your local delivery hub)$/, 'area_hub', 'in_transit'],
  [/^Back at the courier hub$/, 'area_hub', 'in_transit'],
  [/^Out for delivery with a rider$/, 'rider', 'out_for_delivery'],
  [/^(Partly )?[Dd]elivered$/, 'delivered', 'delivered'],
  [/^Returned to the shop$/, 'returned', 'returned'],
  [/^Delivery cancelled, the parcel is coming back$/, 'returned', 'returned'],
  [/^Delivery paused by the courier for now$/, 'status', null],
  [/^Update from the delivery rider$/, 'other', null],
];

/** "MIRPUR WAREHOUSE" → "Mirpur", "PALASH (NARSINGDI)" → "Palash (Narsingdi)". */
export function placeName(raw: string): string {
  const cleaned = raw
    .replace(/\s*dispatch\s+id\s*:?.*$/i, '')
    .replace(/\s+by\s+.*$/i, '')
    .replace(/[.。]+\s*$/, '')
    .replace(SORTING_WORDS, '')
    .replace(/\b(delivery\s+)?hub\b/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([)])/g, '$1')
    .replace(/[\s-]+$/, '')
    .trim();
  return cleaned
    .toLowerCase()
    .replace(/(^|[\s(\-/])([a-z])/g, (_m, lead: string, ch: string) => `${lead}${ch.toUpperCase()}`);
}

/** An unknown text made safe: no phone numbers, IDs or codes. */
export function cleanCourierText(text: string): string {
  return text
    .replace(PHONE_NUMBER, '')
    .replace(/\(\s*#?\d+\s*\)/g, '')
    .replace(/#\d+/g, '')
    .replace(/\b(dispatch|consignment|tracking|invoice)\s+(id|no|number|code)\s*:?\s*[\w-]+/gi, '')
    .replace(/\bby\s+sorter\s+no\s*:?\s*\d+\.?/gi, '')
    .replace(/\b[A-Z]{0,4}\d{5,}\b/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .replace(/[.,]{2,}/g, '.')
    .trim();
}

/** One Steadfast text → what it means and its friendly words. Works on the
 *  raw text (staff) and on the cleaned text the function gives customers. */
export function translateCourierText(rawText: string): CourierText {
  const text = rawText.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (text === '') return { kind: 'other', step: null, friendly: null };

  // Already friendly (the customer gets these from the steadfast function):
  // the same words and meaning again, never translated twice.
  for (const [pattern, kind, step] of FRIENDLY_FORMS) {
    if (pattern.test(text)) return { kind, step, friendly: text };
  }

  if (INTERNAL.test(text)) return { kind: 'internal', step: null, friendly: null };

  if (/\bconsignment created\b|\bparcel created\b|\border created\b/i.test(text)) {
    return { kind: 'created', step: 'in_transit', friendly: 'Handed to Steadfast' };
  }

  const statusUpdate = /status has been updated as\s+(.+?)\.?$/i.exec(text);
  if (statusUpdate) {
    const value = statusUpdate[1].toLowerCase();
    if (value.startsWith('pending')) return { kind: 'picked_up', step: 'in_transit', friendly: 'Picked up by Steadfast' };
    if (value.startsWith('hold')) return { kind: 'status', step: null, friendly: 'Delivery paused by the courier for now' };
    if (value.startsWith('delivered')) return { kind: 'delivered', step: 'delivered', friendly: 'Delivered' };
    if (value.startsWith('partial')) return { kind: 'delivered', step: 'delivered', friendly: 'Partly delivered' };
    if (value.startsWith('cancel')) return { kind: 'returned', step: 'returned', friendly: 'Delivery cancelled, the parcel is coming back' };
    return { kind: 'status', step: null, friendly: null };
  }

  if (/returned?\s+to\s+(the\s+)?(merchant|sender|shop)|\breturn(ed)?\s+(to\s+)?merchant/i.test(lower)) {
    return { kind: 'returned', step: 'returned', friendly: 'Returned to the shop' };
  }

  if (/marked as delivered|\bdelivered to\b|\bdelivery (is )?(completed|successful)/i.test(text)) {
    return { kind: 'delivered', step: 'delivered', friendly: 'Delivered' };
  }

  const sent = /\b(?:sent|send|dispatched|transferred|shifted|moved)\s+to\s+(.+)$/i.exec(text);
  const received = /\b(?:received|arrived|reached|returned)\s+(?:at|to|in)\s+(.+)$/i.exec(text);
  const atHub = received ?? sent;
  if (atHub && !/^(the\s+)?(customer|recipient|receiver)\b/i.test(atHub[1])) {
    const where = atHub[1];
    const sorting = SORTING_WORDS.test(where);
    const place = placeName(where);
    if (received) {
      if (sorting) return { kind: 'at_sorting', step: 'in_transit', friendly: place ? `Reached the ${place} sorting centre` : 'Reached the sorting centre' };
      return {
        kind: 'area_hub',
        step: 'in_transit',
        friendly: place ? `Arrived at ${place} delivery hub` : 'Arrived at your local delivery hub',
      };
    }
    if (sorting) return { kind: 'to_sorting', step: 'in_transit', friendly: place ? `On the way to the ${place} sorting centre` : 'On the way to the sorting centre' };
    return { kind: 'to_area_hub', step: 'in_transit', friendly: place ? `On the way to ${place} delivery hub` : 'On the way to your local delivery hub' };
  }

  // The customer-safe sentence from earlier versions of the function.
  if (/back at the courier hub/i.test(text)) return { kind: 'area_hub', step: 'in_transit', friendly: 'Back at the courier hub' };

  const recognised = stepFromTrackingText(text);
  if (recognised === 'out_for_delivery' || /assigned to (a |the )?rider/i.test(text)) {
    return { kind: 'rider', step: 'out_for_delivery', friendly: 'Out for delivery with a rider' };
  }
  if (recognised === 'in_transit') return { kind: 'at_sorting', step: 'in_transit', friendly: 'Moving between courier hubs' };

  if (RIDER_WORDS.test(text)) return { kind: 'other', step: null, friendly: 'Update from the delivery rider' };

  const cleaned = cleanCourierText(text);
  return { kind: 'other', step: null, friendly: cleaned === '' ? null : cleaned };
}

/** The text the steadfast function sends a customer for one update, or
 *  null to leave it out (Naeem's own edits, addresses, internal codes). */
export function customerUpdateText(text: string): string | null {
  return translateCourierText(text).friendly;
}

/** One stored update as the customer page shows it. */
export interface FriendlyUpdate {
  step: TrackStatus | null;
  kind: CourierTextKind;
  text: string;
  at: string | null;
}

/** Steadfast's list → friendly updates (hidden ones left out), oldest
 *  first, the same text at the same time only once. */
export function friendlyUpdates(events: TrackingEvent[]): FriendlyUpdate[] {
  const seen = new Set<string>();
  const out: FriendlyUpdate[] = [];
  for (const e of sortEvents(events)) {
    const t = translateCourierText(e.text);
    if (!t.friendly) continue;
    const key = `${e.at ?? ''}|${t.friendly}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ step: t.step, kind: t.kind, text: t.friendly, at: e.at });
  }
  return out;
}

/** A short stable key for one courier update (the "no duplicates" rule of
 *  order_tracking_events): same time + same text = same key. FNV-1a. */
export function trackingEventKey(text: string, at: string | null): string {
  const source = `${at ?? ''}|${text.replace(/\s+/g, ' ').trim()}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}${source.length.toString(16)}`;
}

/** Rows for order_tracking_events (migration-037) from one tracking list. */
export function trackingEventRows(
  orderId: string,
  events: TrackingEvent[],
  source: 'steadfast_refresh' | 'steadfast_on_demand'
): {
  order_id: string;
  event_key: string;
  step: TrackStatus | null;
  friendly_text: string | null;
  courier_text: string;
  happened_at: string | null;
  source: string;
}[] {
  const rows = new Map<string, ReturnType<typeof trackingEventRows>[number]>();
  for (const e of events) {
    const t = translateCourierText(e.text);
    const key = trackingEventKey(e.text, e.at);
    rows.set(key, {
      order_id: orderId,
      event_key: key,
      step: t.step,
      friendly_text: t.friendly,
      courier_text: e.text,
      happened_at: e.at,
      source,
    });
  }
  return [...rows.values()];
}

/* ------------------------------------------------------------------ */
/* Rider (only ever shown when Naeem allows it)                       */
/* ------------------------------------------------------------------ */

export interface RiderInfo {
  name: string;
  phone: string;
}

/** A rider's name and phone, if a text gives both (Steadfast's texts have
 *  never included them so far — then this is null and nothing shows). */
export function riderFromText(text: string): RiderInfo | null {
  const match = /assigned to (?:a |the )?(?:rider|delivery ?man)\s*:?\s*([A-Za-z][A-Za-z .'-]{1,40}?)\s*[(,-]\s*(\+?(?:88)?01[3-9]\d{8})/i.exec(
    text.replace(/(\d)[\s-]+(?=\d)/g, '$1')
  );
  if (!match) return null;
  const name = match[1].trim().replace(/[.\s]+$/, '');
  const digits = match[2].replace(/\D/g, '');
  const phone = digits.startsWith('88') ? digits.slice(2) : digits;
  if (name === '' || phone.length !== 11) return null;
  return { name, phone };
}

/** The rider from the newest "assigned to rider" update, if it names one. */
export function latestRider(events: TrackingEvent[]): RiderInfo | null {
  const sorted = sortEvents(events);
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (translateCourierText(sorted[i].text).kind === 'rider') return riderFromText(sorted[i].text);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Expected delivery                                                  */
/* ------------------------------------------------------------------ */

/** The one place the delivery promise lives (days after the start). */
export const DELIVERY_DAYS: Record<'inside_dhaka' | 'outside_dhaka', { from: number; to: number }> = {
  inside_dhaka: { from: 1, to: 2 },
  outside_dhaka: { from: 2, to: 4 },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/** Midnight of the Dhaka calendar day of an instant, as a UTC-epoch "day
 *  number" (days since 1970-01-01 in Dhaka). Bangladesh has no DST. */
export function dhakaDayNumber(at: Date): number {
  return Math.floor((at.getTime() + DHAKA_OFFSET_MS) / DAY_MS);
}

export interface ExpectedRange {
  /** Dhaka day numbers (see dhakaDayNumber). */
  fromDay: number;
  toDay: number;
}

/**
 * The expected delivery window: inside Dhaka 1–2 days, outside 2–4 days,
 * counted from the In transit date (or Confirmed, or the order date). A
 * window that has already passed moves forward to start today, so a late
 * parcel never shows a date in the past.
 */
export function expectedDelivery(input: {
  zone: 'inside_dhaka' | 'outside_dhaka' | 'hand_delivered';
  startAt: string;
  now?: Date;
}): ExpectedRange {
  const days = DELIVERY_DAYS[input.zone === 'inside_dhaka' ? 'inside_dhaka' : 'outside_dhaka'];
  const start = dhakaDayNumber(new Date(input.startAt));
  const today = dhakaDayNumber(input.now ?? new Date());
  let fromDay = start + days.from;
  let toDay = start + days.to;
  if (fromDay < today) fromDay = today;
  if (toDay < fromDay) toDay = fromDay + 1;
  return { fromDay, toDay };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayParts(day: number): { weekday: string; date: number; month: string } {
  const d = new Date(day * DAY_MS);
  return { weekday: WEEKDAYS[d.getUTCDay()], date: d.getUTCDate(), month: MONTHS[d.getUTCMonth()] };
}

/** "Fri 10 – Sat 11 Oct", or "Fri 31 Oct – Mon 3 Nov" across a month. */
export function formatDayRange(range: ExpectedRange): string {
  const a = dayParts(range.fromDay);
  const b = dayParts(range.toDay);
  if (range.fromDay === range.toDay) return `${a.weekday} ${a.date} ${a.month}`;
  if (a.month === b.month) return `${a.weekday} ${a.date} – ${b.weekday} ${b.date} ${b.month}`;
  return `${a.weekday} ${a.date} ${a.month} – ${b.weekday} ${b.date} ${b.month}`;
}

/** "Thu, 10 Oct" in Dhaka time. */
export function formatDhakaDay(iso: string): string {
  const p = dayParts(dhakaDayNumber(new Date(iso)));
  return `${p.weekday}, ${p.date} ${p.month}`;
}

/** "10 Oct, 1:32 PM" in Dhaka time. */
export function formatDhakaDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() + DHAKA_OFFSET_MS);
  const hours = local.getUTCHours();
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}, ${h12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** "1:32 PM" in Dhaka time. */
export function formatDhakaTime(iso: string): string {
  const full = formatDhakaDateTime(iso);
  return full.slice(full.indexOf(',') + 2);
}

/** Telegram / plain text: the admin name for a saved order + courier state. */
export function trackStatusName(status: SavedOrderStatus, booked: boolean, courierStatus: string | null): string {
  return TRACK_STATUS[trackOrder({ status, booked, courierStatus }).status].admin;
}
