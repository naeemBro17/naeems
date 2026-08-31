import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Product } from '../../types';
import { formatTaka } from '../../lib/format';
import { useAuth } from '../../contexts/AuthContext';

const WHOLESALE_REVEAL_MS = 5000;

/**
 * The wholesale row on the product detail page. wholesale_price is genuinely
 * absent from the API response for anyone not approved (products_view + column
 * REVOKE), so the state is derived from login status plus whether the value is
 * present. Signed-out visitors get no row at all — wholesaler sign-in lives on
 * an unlisted route and is never advertised in the public UI.
 */
export function WholesaleReveal({ product }: { product: Product }) {
  const { session } = useAuth();
  const [revealed, setRevealed] = useState(false);
  const timerRef = useRef<number>();

  useEffect(() => {
    return () => window.clearTimeout(timerRef.current);
  }, []);

  // No wholesale price at all, or a signed-out visitor → no row.
  if (!product.has_wholesale) return null;
  if (session === null) return null;

  const price = product.wholesale_price;

  // Approved (wholesaler/admin): value present, blurred tap-to-reveal.
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

  // Logged in but not approved (pending/rejected/revoked): no action.
  return (
    <div className="wholesale-row wholesale-row--static">
      <span className="wholesale-row__label">Wholesale</span>
      <span className="wholesale-row__muted">Awaiting approval</span>
    </div>
  );
}
