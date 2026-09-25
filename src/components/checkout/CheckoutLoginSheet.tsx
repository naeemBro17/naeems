import { useState } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { GoogleSignInButton } from '../shared/GoogleSignInButton';
import { useAuth } from '../../contexts/AuthContext';
import { CHECKOUT_LOGIN_COPY } from '../../lib/checkoutCopy';

interface CheckoutLoginSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Where Google should send the browser back to — the cart survives this
   *  round trip on its own (it's in localStorage), so this only needs to
   *  land the customer back on the checkout flow, not the homepage. */
  redirectTo: string;
}

/**
 * Shown when a logged-out customer taps "Checkout". A friendly ask, not a
 * wall — Cancel returns to the cart with nothing lost, nothing here blocks
 * browsing or adding to cart.
 */
export function CheckoutLoginSheet({ isOpen, onClose, redirectTo }: CheckoutLoginSheetProps) {
  const { signInWithGoogle } = useAuth();
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogleSignIn = async () => {
    setIsStarting(true);
    setError(null);
    const { error: signInError } = await signInWithGoogle(redirectTo);
    if (signInError) {
      setError(signInError);
      setIsStarting(false);
    }
    // On success the whole page navigates away to Google — nothing left to do.
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={CHECKOUT_LOGIN_COPY.title}>
      <div className="login-sheet">
        <p className="login-sheet__message">{CHECKOUT_LOGIN_COPY.message}</p>

        {error && (
          <p className="login-sheet__error" role="alert">
            {error}
          </p>
        )}

        <div className="login-sheet__actions">
          <GoogleSignInButton
            label={CHECKOUT_LOGIN_COPY.googleButton}
            onClick={handleGoogleSignIn}
            disabled={isStarting}
          />
          <button
            type="button"
            className="login-sheet__cancel"
            onClick={onClose}
            disabled={isStarting}
          >
            {CHECKOUT_LOGIN_COPY.cancel}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
