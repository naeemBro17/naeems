import { useEffect, useState, type MouseEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { useAuth } from '../../contexts/AuthContext';
import { rememberPendingSave, useWishlist } from '../../contexts/WishlistContext';
import { BottomSheet } from '../shared/BottomSheet';
import { GoogleSignInButton } from '../shared/GoogleSignInButton';

/** How long "Saved to your wishlist" / "Removed … Undo" stays up. */
const WISH_TOAST_MS = 4000;

export function HeartIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20.3s-7.6-4.5-9.3-9.4C1.6 7.6 3.6 4.4 6.9 4.2c2-.1 3.6 1 5.1 2.9 1.5-1.9 3.1-3 5.1-2.9 3.3.2 5.3 3.4 4.2 6.7-1.7 4.9-9.3 9.4-9.3 9.4z" />
    </svg>
  );
}

/**
 * Batch 51 Part 4: the round glass heart on the product photo (top right,
 * matching the back button). Outline; filled near-black when saved (white
 * in dark mode).
 */
export function HeartButton({ productId, productName }: { productId: string; productName: string }) {
  const { has, toggle } = useWishlist();
  const saved = has(productId);
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    toggle(productId);
  };
  return (
    <button
      type="button"
      className={`wish-heart${saved ? ' wish-heart--saved' : ''}`}
      onClick={onClick}
      aria-pressed={saved}
      aria-label={saved ? `Remove ${productName} from your wishlist` : `Save ${productName} to your wishlist`}
      data-testid="wish-heart"
    >
      <HeartIcon filled={saved} className="wish-heart__icon" />
    </button>
  );
}

function placement(pathname: string): string {
  if (pathname.startsWith('/product/')) return 'undo-toast--above-buybar';
  return '';
}

/**
 * "Saved to your wishlist · View" / "Removed from your wishlist · Undo" —
 * dark glass at the bottom of the screen. Rendered once in App.tsx.
 */
export function WishlistToast() {
  const { toast, dismissToast, undo } = useWishlist();
  const navigate = useAppNavigate();
  const location = useLocation();
  const toastId = toast?.id ?? null;

  useEffect(() => {
    if (toastId === null) return;
    const timer = window.setTimeout(dismissToast, WISH_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toastId, dismissToast]);

  if (!toast) return null;
  const saved = toast.kind === 'saved';
  return (
    <div
      key={toast.id}
      className={`wish-toast ${placement(location.pathname)}`}
      role="status"
      aria-live="polite"
      data-testid="wish-toast"
    >
      <HeartIcon filled={saved} className="wish-toast__icon" />
      <span className="wish-toast__text">{saved ? 'Saved to your wishlist' : 'Removed from your wishlist'}</span>
      {saved ? (
        location.pathname !== '/wishlist' && (
          <button
            type="button"
            className="wish-toast__action"
            onClick={() => {
              dismissToast();
              navigate('/wishlist');
            }}
            data-testid="wish-toast-view"
          >
            View
          </button>
        )
      ) : (
        <button type="button" className="wish-toast__action" onClick={undo} data-testid="wish-toast-undo">
          Undo
        </button>
      )}
    </div>
  );
}

/** Logged out: "Log in to save your favourites". Back from Google on the
 *  same product, the product is saved (WishlistProvider). */
export function WishlistLoginSheet() {
  const { loginFor, closeLogin } = useWishlist();
  const { signInWithGoogle } = useAuth();
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const logIn = async () => {
    if (!loginFor) return;
    setIsStarting(true);
    setError(null);
    rememberPendingSave(loginFor);
    const { error: signInError } = await signInWithGoogle(window.location.href);
    if (signInError) {
      setError(signInError);
      setIsStarting(false);
    }
  };

  return (
    <BottomSheet isOpen={loginFor !== null} onClose={closeLogin} title="Log in to save your favourites">
      <div className="login-sheet" data-testid="wish-login">
        <p className="login-sheet__message">Your wishlist stays with your account, on any phone.</p>
        {error && (
          <p className="login-sheet__error" role="alert">
            {error}
          </p>
        )}
        <div className="login-sheet__actions">
          <GoogleSignInButton label="Log in" onClick={() => void logIn()} disabled={isStarting} />
          <button type="button" className="login-sheet__cancel" onClick={closeLogin} disabled={isStarting}>
            Not now
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
