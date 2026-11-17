/**
 * All wording for the "please sign in" moment at checkout, in one place so
 * Naeem can change it later without hunting through component code.
 */
export const CHECKOUT_LOGIN_COPY = {
  title: 'Almost done!',
  message: 'Before we send your skincare, we just need to know who you are.',
  googleButton: 'Continue with Google',
  cancel: 'Cancel',
};

/**
 * Batch 47: the total line's wording. Cash on delivery means nothing has
 * been paid yet — never "Total paid". Only money really paid says paid.
 * Batch 48: in English.
 */
export const PAY_ON_DELIVERY_LABEL = 'Pay on delivery';

/** The total line of a just-placed web order: bKash / Nagad is paid in
 *  full up front; cash on delivery is paid to the rider. */
export function placedTotalLabel(paymentMethod: string): string {
  return paymentMethod === 'bkash' || paymentMethod === 'nagad' ? 'Total paid' : PAY_ON_DELIVERY_LABEL;
}

/** "Order placed": how it was paid. */
export function placedPaymentLabel(paymentMethod: string): string {
  if (paymentMethod === 'bkash') return 'bKash (paid in advance)';
  if (paymentMethod === 'nagad') return 'Nagad (paid in advance)';
  return 'Cash on Delivery';
}
