// Shared progress indicator shown at the top of all 4 checkout screens
// (CartPage, DeliveryDetailsPage, OrderSummaryPage, OrderSuccessPage).
// Purely presentational — takes the current step number and renders the
// 4-segment bar plus its text label; it reads no checkout state itself.

const STEP_NAMES = ['Your cart', 'Delivery details', 'Review and pay', 'Order placed'] as const;

interface CheckoutProgressBarProps {
  /** 1-4, the screen currently shown. */
  currentStep: 1 | 2 | 3 | 4;
}

export function CheckoutProgressBar({ currentStep }: CheckoutProgressBarProps) {
  return (
    <div className="checkout-progress">
      <div className="checkout-progress__segments">
        {STEP_NAMES.map((_, index) => (
          <span
            key={index}
            className={`checkout-progress__segment${
              index <= currentStep - 1 ? ' checkout-progress__segment--filled' : ''
            }`}
          />
        ))}
      </div>
      <p className="checkout-progress__label">
        Step {currentStep} of 4 — {STEP_NAMES[currentStep - 1]}
      </p>
    </div>
  );
}
