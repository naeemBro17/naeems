import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Product } from '../../types';
import { formatTaka } from '../../lib/format';
import { useAuth } from '../../contexts/AuthContext';
import { useAuthModal } from '../../contexts/AuthModalContext';

const WHOLESALE_REVEAL_MS = 5000;

/**
 * The wholesale row, in three states (Part 8). Because wholesale_price is now
 * genuinely absent from the API response for anyone not approved (products_view
 * + column REVOKE), the state is derived from login status plus whether the
 * value is present. `has_wholesale` distinguishes "not approved" from "this
 * product simply has no wholesale price" (in which case nothing renders).
 */
export function WholesaleReveal({ product }: { product: Product }) {
  const { session } = useAuth();
  const { openAuth } = useAuthModal();
  const [revealed, setRevealed] = useState(false);
  const timerRef = useRef<number>();

  useEffect(() => {
    return () => window.clearTimeout(timerRef.current);
  }, []);

  // The product has no wholesale price at all → no row for anyone.
  if (!product.has_wholesale) return null;

  const price = product.wholesale_price;

  // State 3 — approved (wholesaler/admin): value present, blurred tap-to-reveal.
  if (price !== null) {
    const handleTap = (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (revealed) return;
      setRevealed(true);
      try {
        navigator.vibrate?.(25);
      } catch {
        // Vibration unsupported — non-blocking.
      }
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setRevealed(false), WHOLESALE_REVEAL_MS);
    };

    return (
      <button
        type="button"
        className="wholesale-row"
        onClick={handleTap}
        aria-label={
          revealed
            ? `Wholesale price ${formatTaka(price)}`
            : 'Tap to reveal wholesale price'
        }
      >
        <span className="wholesale-row__label">Wholesale</span>
        <span
          className={`wholesale-row__value${
            revealed ? '' : ' wholesale-row__value--blurred'
          }`}
        >
          {revealed ? formatTaka(price) : '৳ ••••'}
        </span>
      </button>
    );
  }

  // State 1 — not logged in: no number; tap opens the wholesaler auth flow.
  if (session === null) {
    return (
      <button
        type="button"
        className="wholesale-row wholesale-row--cta"
        onClick={(e) => {
          e.stopPropagation();
          openAuth('wholesaler');
        }}
        aria-label="Log in to view the wholesale price"
      >
        <span className="wholesale-row__label">Wholesale</span>
        <span className="wholesale-row__cta">Login to view</span>
      </button>
    );
  }

  // State 2 — logged in but not approved (pending/rejected/revoked): no action.
  return (
    <div className="wholesale-row wholesale-row--static">
      <span className="wholesale-row__label">Wholesale</span>
      <span className="wholesale-row__muted">Awaiting approval</span>
    </div>
  );
}
