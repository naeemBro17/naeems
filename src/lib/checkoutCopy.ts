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
 */
export const PAY_ON_DELIVERY_LABEL = 'ডেলিভারিতে দেবেন';

/** The total line of a just-placed web order: bKash is paid in full up
 *  front; cash on delivery is paid to the rider. */
export function placedTotalLabel(paymentMethod: string): string {
  return paymentMethod === 'bkash' ? 'Total paid' : PAY_ON_DELIVERY_LABEL;
}
