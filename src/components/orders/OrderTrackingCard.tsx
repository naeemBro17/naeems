import { useState } from 'react';
import {
  TRACK_STATUS,
  TRACK_STEPS,
  expectedDelivery,
  formatDayRange,
  formatDhakaDateTime,
  formatDhakaDay,
  formatDhakaTime,
  stepStates,
  type FriendlyUpdate,
  type PaymentPill,
  type PaymentUpdate,
  type StepState,
  type TrackResult,
  type TrackStatus,
} from '../../lib/orderTracking';
import { telHref } from '../../lib/phone';
import { steadfastTrackingUrl } from '../../lib/steadfastLink';
import { LineIcon } from './TrackIcons';

/** One friendly sentence for the step the order is on now. */
function stepSentence(status: TrackStatus, reachedArea: boolean): string {
  switch (status) {
    case 'processing':
      return 'We received your order.';
    case 'confirmed':
      return 'We checked your order and packed it.';
    case 'in_transit':
      return reachedArea ? 'Your parcel has reached your area. Almost there!' : 'Your parcel is on its way to your area.';
    case 'out_for_delivery':
      return 'Your rider is on the way. Please keep your phone nearby.';
    case 'delivered':
      return "Enjoy your new skincare. Thank you for shopping with NAEEM'S.";
    default:
      return '';
  }
}

const NOTE_TEXT: Record<NonNullable<TrackResult['note']>, string | null> = {
  on_hold: 'The courier has paused this delivery for now. We will contact you.',
  needs_attention: 'It is taking a little longer. We are checking with the courier.',
  partly_delivered: 'Part of this order was delivered.',
  awaiting_confirmation: null,
};

export interface CustomerTrackingView {
  orderNumber: string;
  track: TrackResult;
  zone: 'inside_dhaka' | 'outside_dhaka' | 'hand_delivered';
  createdAt: string;
  times: Partial<Record<TrackStatus, string>>;
  /** Courier updates, oldest first. */
  updates: FriendlyUpdate[];
  payments: PaymentUpdate[];
  pill: PaymentPill | null;
  trackingLink: string | null;
  booked: boolean;
  rider: { name: string; phone: string } | null;
}

/** The big line: "Expected delivery Fri 10 – Sat 11 Oct", "Today",
 *  "Delivered Thu, 10 Oct", or the cancelled / returned date. */
function headline(view: CustomerTrackingView): { label: string; value: string } {
  const { track, times } = view;
  if (track.status === 'delivered') {
    return { label: 'Delivered', value: times.delivered ? formatDhakaDay(times.delivered) : 'Delivered' };
  }
  if (track.status === 'cancelled' || track.status === 'returned') {
    const at = times[track.status];
    return { label: TRACK_STATUS[track.status].customer, value: at ? formatDhakaDay(at) : TRACK_STATUS[track.status].customer };
  }
  if (track.status === 'out_for_delivery') return { label: 'Expected delivery', value: 'Today' };
  const startAt = times.in_transit ?? times.confirmed ?? view.createdAt;
  return { label: 'Expected delivery', value: formatDayRange(expectedDelivery({ zone: view.zone, startAt })) };
}

function StepCircle({ status, state, delivered }: { status: TrackStatus; state: StepState; delivered: boolean }) {
  return (
    <span className={`ot-step__circle ot-step__circle--${state}${delivered ? ' ot-step__circle--delivered' : ''}`} aria-hidden="true">
      <LineIcon name={TRACK_STATUS[status].icon} />
      {state === 'done' && (
        <span className="ot-step__tick">
          <LineIcon name="tick" />
        </span>
      )}
    </span>
  );
}

/** Which main step an update belongs to: its own, or the step it came
 *  after (an update that proves nothing joins the step before it). */
function groupUpdates(updates: FriendlyUpdate[]): Map<TrackStatus, FriendlyUpdate[]> {
  const groups = new Map<TrackStatus, FriendlyUpdate[]>();
  let current: TrackStatus = 'in_transit';
  for (const u of updates) {
    if (u.step && TRACK_STEPS.includes(u.step)) current = u.step;
    const list = groups.get(current) ?? [];
    list.push(u);
    groups.set(current, list);
  }
  return groups;
}

function newestFirst<T extends { at: string | null }>(list: T[]): T[] {
  return [...list].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

/** "See all updates": one soft card per main step (newest at top) and the
 *  payments as green cards. */
function AllUpdates({ view, states }: { view: CustomerTrackingView; states: StepState[] }) {
  const groups = groupUpdates(view.updates);
  const upcoming = TRACK_STEPS.filter((_, i) => states[i] === 'upcoming').reverse();
  const currentIndex = states.indexOf('current');
  const current = currentIndex >= 0 ? TRACK_STEPS[currentIndex] : null;
  type Card =
    | { kind: 'step'; status: TrackStatus; at: string | null }
    | { kind: 'payment'; payment: PaymentUpdate; at: string };
  const dated: Card[] = [
    ...TRACK_STEPS.filter((_, i) => states[i] === 'done').map((status) => ({ kind: 'step' as const, status, at: view.times[status] ?? null })),
    ...view.payments.map((payment) => ({ kind: 'payment' as const, payment, at: payment.at })),
  ];
  const sorted = newestFirst(dated);
  const currentUpdates = current ? newestFirst(groups.get(current) ?? []) : [];

  return (
    <ol className="ot-all" data-testid="all-updates">
      {upcoming.map((status) => (
        <li key={status} className="ot-all__item ot-all__item--upcoming" data-step={status}>
          <span className="ot-all__dot" aria-hidden="true" />
          <div className="ot-all__card ot-all__card--upcoming">
            <span className="ot-all__title">{TRACK_STATUS[status].customer}</span>
          </div>
        </li>
      ))}
      {current && (
        <li className="ot-all__item ot-all__item--current" data-step={current}>
          <span className="ot-all__dot ot-all__dot--current" aria-hidden="true" />
          <div className={`ot-all__card ot-all__card--current${current === 'delivered' ? ' ot-all__card--delivered' : ''}`}>
            <div className="ot-all__head">
              <span className="ot-all__title">{TRACK_STATUS[current].customer}</span>
              {view.times[current] && <span className="ot-all__time">{formatDhakaDateTime(view.times[current] ?? '')}</span>}
            </div>
            {currentUpdates.length > 0 ? (
              <ul className="ot-all__updates">
                {currentUpdates.map((u, i) => (
                  <li key={`${u.at ?? ''}-${i}`} className="ot-all__update" data-testid="courier-update">
                    <span className="ot-all__update-text">{u.text}</span>
                    {u.at && <span className="ot-all__update-time">{formatDhakaDateTime(u.at)}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ot-all__line">{stepSentence(current, view.track.reachedArea)}</p>
            )}
          </div>
        </li>
      )}
      {sorted.map((card) =>
        card.kind === 'payment' ? (
          <li key={`pay-${card.at}-${card.payment.text}`} className="ot-all__item" data-testid="payment-update">
            <span className="ot-all__dot ot-all__dot--paid" aria-hidden="true" />
            <div className="ot-all__card ot-all__card--paid">
              <div className="ot-all__head">
                <span className="ot-all__title">{card.payment.title}</span>
                <span className="ot-all__time">{formatDhakaDateTime(card.payment.at)}</span>
              </div>
              <p className="ot-all__line">{card.payment.text}</p>
            </div>
          </li>
        ) : (
          <li key={card.status} className="ot-all__item ot-all__item--done" data-step={card.status}>
            <span className="ot-all__dot ot-all__dot--done" aria-hidden="true" />
            <div className="ot-all__card">
              <div className="ot-all__head">
                <span className="ot-all__title">{TRACK_STATUS[card.status].customer}</span>
                {card.at && <span className="ot-all__time">{formatDhakaDateTime(card.at)}</span>}
              </div>
              <p className="ot-all__line">
                {newestFirst(groups.get(card.status) ?? [])[0]?.text ?? stepSentence(card.status, false)}
              </p>
            </div>
          </li>
        )
      )}
    </ol>
  );
}

/**
 * Batch 35 Part 2: the customer's tracking card — the expected date (or
 * delivered date), the payment pill, the five steps with round icons, and
 * "See all updates" / "Track on Steadfast".
 */
export function OrderTrackingCard({ view }: { view: CustomerTrackingView }) {
  const [showAll, setShowAll] = useState(false);
  const { track } = view;
  const head = headline(view);
  const ended = track.status === 'cancelled' || track.status === 'returned';
  const states = stepStates(track);
  const latest = view.updates.length > 0 ? view.updates[view.updates.length - 1] : null;
  const note = track.note ? NOTE_TEXT[track.note] : null;

  return (
    <section className="ot-card ot-track" aria-label="Order tracking" data-testid="order-tracking">
      <p className="ot-track__label">{head.label}</p>
      <p className="ot-track__big" data-testid="tracking-headline">
        {head.value}
      </p>
      {view.pill && (
        <span className={`ot-pill ot-pill--${view.pill.tone}`} data-testid="payment-pill">
          {view.pill.text}
        </span>
      )}

      {ended ? (
        <div className="ot-ended" data-testid="order-ended">
          <span className="ot-ended__status" data-testid="delivery-status">
            {TRACK_STATUS[track.status].customer}
          </span>
          <p className="ot-ended__line">
            {track.status === 'cancelled'
              ? 'This order was cancelled. Questions? Chat with us.'
              : 'This parcel came back to us. Questions? Chat with us.'}
          </p>
        </div>
      ) : (
        <ol className="ot-steps order-steps" aria-label="Order progress" data-testid="order-steps">
          {TRACK_STEPS.map((status, index) => {
            const state = states[index];
            const time = view.times[status];
            const isDelivered = status === 'delivered' && state === 'current';
            return (
              <li
                key={status}
                className={`ot-step ot-step--${state} order-steps__step order-steps__step--${state === 'upcoming' ? 'todo' : state}${
                  state === 'upcoming' ? '' : ' order-timeline__step--reached'
                }`}
                data-step={status}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <StepCircle status={status} state={state} delivered={isDelivered} />
                {state === 'current' ? (
                  <div className="ot-step__body ot-step__body--current">
                    <span className="ot-step__name ot-step__name--current" data-testid="delivery-status">
                      {TRACK_STATUS[status].customer}
                    </span>
                    {time && <span className="ot-step__time">{formatDhakaDateTime(time)}</span>}
                    <p className="ot-step__sentence">{stepSentence(status, track.reachedArea)}</p>
                    {note && (
                      <p className="ot-step__note" data-testid="order-step-side">
                        {note}
                      </p>
                    )}
                    {latest && (status === 'in_transit' || status === 'out_for_delivery' || status === 'delivered') && (
                      <p className="ot-step__latest" data-testid="order-step-latest">
                        <span className="ot-step__latest-dot" aria-hidden="true" />
                        <span className="ot-step__latest-text">{latest.text}</span>
                        {latest.at && <span className="ot-step__latest-time">{formatDhakaTime(latest.at)}</span>}
                      </p>
                    )}
                    {status === 'out_for_delivery' && view.rider && (
                      <div className="ot-rider" data-testid="rider-row">
                        <span className="ot-rider__icon" aria-hidden="true">
                          <LineIcon name="bike" />
                        </span>
                        <span className="ot-rider__text">
                          <span className="ot-rider__name">Your rider: {view.rider.name}</span>
                          <span className="ot-rider__sub">Steadfast Courier</span>
                        </span>
                        <a className="ot-rider__call" href={telHref(view.rider.phone) ?? undefined}>
                          <LineIcon name="phone" />
                          Call
                        </a>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="ot-step__body">
                    <span className="ot-step__name">{TRACK_STATUS[status].customer}</span>
                    {state === 'done' && time && <span className="ot-step__time ot-step__time--right">{formatDhakaDateTime(time)}</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {showAll && <AllUpdates view={view} states={states} />}

      <div className="ot-track__footer">
        <button
          type="button"
          className="ot-link"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          data-testid="toggle-updates"
        >
          {showAll ? 'Hide updates' : 'See all updates'}
          <LineIcon name={showAll ? 'chevron-up' : 'chevron-down'} className="ot-link__icon" />
        </button>
        {view.booked && (
          <a
            className="ot-link order-detail__tracking-link"
            href={steadfastTrackingUrl(view.trackingLink)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Track on Steadfast
            <LineIcon name="external" className="ot-link__icon" />
          </a>
        )}
      </div>
    </section>
  );
}
