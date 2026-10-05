import { ORDER_STEPS, stepLabel, type StepResult, type TrackingEvent } from '../../lib/orderSteps';

function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * Batch 30 Part 5: the six order steps as a calm vertical list — done
 * steps get a check, the current one is highlighted, later ones are grey.
 * Under the current step: Steadfast's latest words and time (for a
 * customer these never include a rider's name or phone — the steadfast
 * function removes them). A side state (on hold, returning…) shows as a
 * note above the list.
 */
export function OrderSteps({
  step,
  audience,
  stepTimes = {},
  labelTestId = 'order-step-label',
}: {
  step: StepResult;
  audience: 'customer' | 'admin';
  /** The customer page keeps its Batch 24 test id ("delivery-status"). */
  labelTestId?: string;
  /** When a step was reached, where the site knows it (order history). */
  stepTimes?: Partial<Record<(typeof ORDER_STEPS)[number]['id'], string>>;
}) {
  const label = stepLabel(step, audience);
  const cancelled = step.side === 'cancelled';
  return (
    <section className="order-steps" aria-label="Order progress" data-testid="order-steps">
      <p className="order-steps__now">
        <strong data-testid={labelTestId}>{label}</strong>
      </p>
      {step.side && step.side !== 'cancelled' && (
        <p className={`order-steps__side order-steps__side--${step.side}`} data-testid="order-step-side">
          {step.side === 'on_hold' && 'The courier has paused this delivery for now. We will contact you.'}
          {step.side === 'returning' && 'The parcel is coming back to us. We will contact you.'}
          {step.side === 'partly_delivered' && 'Part of this order was delivered.'}
          {step.side === 'needs_attention' &&
            (audience === 'admin' ? 'Steadfast reports a problem with this parcel — check it on Steadfast.' : 'We are checking with the courier and will contact you.')}
        </p>
      )}
      {!cancelled && (
        <ol className="order-steps__list">
          {ORDER_STEPS.map((s, index) => {
            const state = index < step.index ? 'done' : index === step.index ? 'current' : 'todo';
            const isDone = state === 'done' || (state === 'current' && s.id === 'delivered' && !step.awaitingConfirmation);
            const time = stepTimes[s.id];
            return (
              <li
                key={s.id}
                className={`order-steps__step order-steps__step--${state}${state === 'todo' ? '' : ' order-timeline__step--reached'}`}
                data-step={s.id}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <span className={`order-steps__dot${isDone ? ' order-steps__dot--check' : ''}`} aria-hidden="true">
                  {isDone && <CheckIcon />}
                </span>
                <span className="order-steps__body">
                  <span className="order-steps__label">{s.label}</span>
                  {time && state !== 'todo' && <span className="order-steps__time">{shortTime(time)}</span>}
                  {state === 'current' && step.latest && (
                    <span className="order-steps__latest" data-testid="order-step-latest">
                      {step.latest.text}
                      {step.latest.at && shortTime(step.latest.at) !== shortTime(time ?? null) && (
                        <span className="order-steps__latest-time"> · {shortTime(step.latest.at)}</span>
                      )}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** Admin only: every step Steadfast recorded, newest first (rider name and
 *  phone included). */
export function CourierTimeline({ events }: { events: TrackingEvent[] }) {
  if (events.length === 0) return <p className="admin-panel__description">Steadfast has no tracking steps for this parcel yet.</p>;
  const newestFirst = [...events].reverse();
  return (
    <ol className="courier-timeline" data-testid="courier-timeline">
      {newestFirst.map((e, i) => (
        <li key={`${e.at ?? ''}-${i}`} className="courier-timeline__row">
          <span className="courier-timeline__text">{e.text}</span>
          {e.at && <span className="courier-timeline__time">{shortTime(e.at)}</span>}
        </li>
      ))}
    </ol>
  );
}
