// Batch 48: the slim labelled stepper at the top of the three checkout
// screens (CartPage, DeliveryDetailsPage, OrderSummaryPage): Cart ->
// Delivery -> Payment. Done steps get a small filled circle with a tick,
// the current step a ring with a filled centre, upcoming ones a light ring.
// The Order placed page shows no stepper. Purely presentational.

import { Fragment } from 'react';
import '../../styles/checkoutFinish.css';

const STEP_NAMES = ['Cart', 'Delivery', 'Payment'] as const;

interface CheckoutProgressBarProps {
  /** 1-3, the screen currently shown. */
  currentStep: 1 | 2 | 3;
}

export function CheckoutProgressBar({ currentStep }: CheckoutProgressBarProps) {
  return (
    <nav className="checkout-stepper" aria-label={`Checkout, step ${currentStep} of 3`} data-testid="checkout-stepper">
      {STEP_NAMES.map((name, index) => {
        const step = index + 1;
        const state = step < currentStep ? 'done' : step === currentStep ? 'on' : 'next';
        return (
          <Fragment key={name}>
            {index > 0 && (
              <i className={`checkout-stepper__line${step <= currentStep ? '' : ' checkout-stepper__line--off'}`} aria-hidden="true" />
            )}
            <span
              className={`checkout-stepper__step checkout-stepper__step--${state}`}
              aria-current={state === 'on' ? 'step' : undefined}
            >
              <i className="checkout-stepper__dot" aria-hidden="true">
                {state === 'done' && (
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 6.2l2.2 2.2L9.5 3.6" />
                  </svg>
                )}
              </i>
              {name}
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}
