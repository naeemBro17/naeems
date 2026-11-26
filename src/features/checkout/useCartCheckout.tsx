import { useCallback, useState, type ReactNode } from 'react';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { useAuth } from '../../contexts/AuthContext';
import { CheckoutLoginSheet } from '../../components/checkout/CheckoutLoginSheet';
import { trackInitiateCheckout } from '../../lib/analytics';
import { useCheckoutState } from './useCheckoutState';

export interface CartCheckout {
  /** The cart's Checkout button: records the start of checkout, then goes
   *  to the delivery step, or asks a logged-out visitor to sign in first.
   *  `beforeSignIn` lets the side cart close itself before the sign-in
   *  sheet opens (it calls `open` when it is out of the way). */
  checkout: (beforeSignIn?: (open: () => void) => void) => void;
  /** The sign-in sheet; render it once next to the Checkout button. */
  loginSheet: ReactNode;
}

/**
 * The cart's Checkout (Batch 70: shared by the cart page and the side cart,
 * so both run exactly the same steps). Already logged in (customer,
 * wholesaler or admin alike) skips the ask entirely; only a fully
 * logged-out visitor sees the sign-in sheet.
 */
export function useCartCheckout(): CartCheckout {
  const { items, subtotal } = useCheckoutState();
  const { session } = useAuth();
  const navigate = useAppNavigate();
  const [showLoginSheet, setShowLoginSheet] = useState(false);

  const track = useCallback(() => {
    trackInitiateCheckout(
      items.map((item) => ({
        id: item.product.id,
        name: item.product.name,
        price: item.unitPrice,
        quantity: item.quantity,
      })),
      subtotal
    );
  }, [items, subtotal]);

  const checkout = useCallback(
    (beforeSignIn?: (open: () => void) => void) => {
      track();
      if (session) {
        navigate('/checkout/delivery');
        return;
      }
      const open = () => setShowLoginSheet(true);
      if (beforeSignIn) beforeSignIn(open);
      else open();
    },
    [track, session, navigate]
  );

  const loginSheet = (
    <CheckoutLoginSheet
      isOpen={showLoginSheet}
      onClose={() => setShowLoginSheet(false)}
      redirectTo={`${window.location.origin}/checkout/delivery`}
    />
  );

  return { checkout, loginSheet };
}
