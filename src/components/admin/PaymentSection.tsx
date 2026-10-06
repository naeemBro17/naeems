// Batch 32 Part 1 — the payment section of New order and Edit order:
//   1. Paid now (৳, default 0) + "Full amount"; when more than 0, how it was
//      paid (bKash · Nagad · Cash · Bank) and an optional TrxID;
//   2. Remaining ৳X — Collect on delivery (the courier collects it) or
//      Customer pays later (the courier collects ৳0, it stays due);
//   3. a live summary: Paid now · Courier collects (COD) · Due after delivery.
// The numbers come from lib/paymentPlan.ts; the COD rule itself is the one
// shared with the steadfast function (supabase/functions/_shared/cod.ts).
import { formatTaka } from '../../lib/format';
import { PAID_NOW_METHODS, PAYMENT_METHOD_NAMES, type PaymentMethodId } from '../../lib/payments';
import { COLLECT_MODE_LABELS, type CollectMode, type PaymentPlan } from '../../lib/paymentPlan';

const MODES: CollectMode[] = ['cod', 'pay_later'];

interface PaymentSectionProps {
  idPrefix: string;
  total: number;
  plan: PaymentPlan;
  /** What earlier payments on the order add up to (Edit order only). */
  alreadyPaid?: number;
  /** Whether a payment can be typed here (Edit order needs "Change order
   *  status"; New order always can). */
  canAddPayment?: boolean;
  paidNowInput: string;
  onPaidNowInput: (value: string) => void;
  method: PaymentMethodId | null;
  onMethod: (method: PaymentMethodId) => void;
  trxId: string;
  onTrxId: (value: string) => void;
  mode: CollectMode;
  onMode: (mode: CollectMode) => void;
  /** False until migration-035 is live: "Customer pays later" is shown but
   *  can't be picked yet. */
  payLaterAvailable: boolean;
  /** Shown under the method chips when an amount is typed but no method. */
  methodMissing?: boolean;
}

export function PaymentSection({
  idPrefix,
  total,
  plan,
  alreadyPaid = 0,
  canAddPayment = true,
  paidNowInput,
  onPaidNowInput,
  method,
  onMethod,
  trxId,
  onTrxId,
  mode,
  onMode,
  payLaterAvailable,
  methodMissing = false,
}: PaymentSectionProps) {
  const room = Math.max(0, Math.round((total - alreadyPaid) * 100) / 100);
  const paidLabel = alreadyPaid > 0 ? 'Add a payment now' : 'Paid now';

  return (
    <div className="pay-section" data-testid="payment-section">
      {canAddPayment && (
        <div className="form-field">
          <label className="form-label" htmlFor={`${idPrefix}-paid-now`}>
            {paidLabel} (৳)
          </label>
          <div className="pay-section__amount-row">
            <input
              id={`${idPrefix}-paid-now`}
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              className={`form-input pay-section__amount${plan.error ? ' form-input--error' : ''}`}
              value={paidNowInput}
              placeholder="0"
              onChange={(e) => onPaidNowInput(e.target.value)}
              aria-invalid={plan.error ? true : undefined}
              aria-describedby={plan.error ? `${idPrefix}-paid-now-error` : undefined}
              data-testid="paid-now-input"
            />
            <button
              type="button"
              className="adm-btn adm-btn--ghost pay-section__full"
              onClick={() => onPaidNowInput(String(room))}
              disabled={room <= 0}
            >
              Full amount
            </button>
          </div>
          {plan.error && (
            <p className="form-error" id={`${idPrefix}-paid-now-error`} role="alert" data-testid="paid-now-error">
              {plan.error}
            </p>
          )}
        </div>
      )}

      {canAddPayment && plan.paidNow > 0 && (
        <>
          <div className="form-field">
            <span className="form-label">How was it paid?</span>
            <div className="chip-group" role="group" aria-label="How was it paid">
              {PAID_NOW_METHODS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`chip-select${method === id ? ' chip-select--on' : ''}`}
                  aria-pressed={method === id}
                  onClick={() => onMethod(id)}
                >
                  {PAYMENT_METHOD_NAMES[id]}
                </button>
              ))}
            </div>
            {methodMissing && (
              <p className="form-error" role="alert">
                Choose how it was paid.
              </p>
            )}
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor={`${idPrefix}-trx`}>
              TrxID (optional)
            </label>
            <input
              id={`${idPrefix}-trx`}
              type="text"
              className="form-input"
              value={trxId}
              onChange={(e) => onTrxId(e.target.value)}
              autoComplete="off"
            />
          </div>
        </>
      )}

      {plan.remaining > 0 && (
        <div className="form-field">
          <span className="form-label" id={`${idPrefix}-remaining`}>
            Remaining {formatTaka(plan.remaining)}
          </span>
          <div className="adm-segment pay-section__modes" role="radiogroup" aria-labelledby={`${idPrefix}-remaining`}>
            {MODES.map((m) => {
              const disabled = m === 'pay_later' && !payLaterAvailable && mode !== 'pay_later';
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  disabled={disabled}
                  className={`adm-segment__item${mode === m ? ' adm-segment__item--on' : ''}`}
                  onClick={() => onMode(m)}
                >
                  {COLLECT_MODE_LABELS[m]}
                </button>
              );
            })}
          </div>
          {!payLaterAvailable && (
            <p className="form-hint" data-testid="pay-later-unavailable">
              "Customer pays later" needs the Batch 32 database update. Until then the courier collects what is due.
            </p>
          )}
        </div>
      )}

      <div className="pay-section__summary" aria-live="polite" data-testid="payment-summary">
        {alreadyPaid > 0 && (
          <div className="pay-section__row">
            <span>Paid before</span>
            <span>{formatTaka(alreadyPaid)}</span>
          </div>
        )}
        <div className="pay-section__row">
          <span>Paid now</span>
          <span data-testid="summary-paid-now">{formatTaka(plan.paidNow)}</span>
        </div>
        <div className="pay-section__row">
          <span>Courier collects (COD)</span>
          <span data-testid="summary-courier">{formatTaka(plan.courierCollects)}</span>
        </div>
        <div className="pay-section__row pay-section__row--strong">
          <span>Due after delivery</span>
          <span data-testid="summary-due">{formatTaka(plan.dueAfterDelivery)}</span>
        </div>
      </div>
    </div>
  );
}
