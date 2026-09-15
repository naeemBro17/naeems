import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { formatTaka } from '../../lib/format';
import { useAuth } from '../../contexts/AuthContext';

interface WholesaleRevealProps {
  /** Whether a wholesale price exists at all (value may still be withheld). */
  hasWholesale: boolean;
  /** The price, or null when the API withheld it from this viewer. */
  price: number | null | undefined;
}

const WHOLESALE_REVEAL_MS = 5000;

/**
 * The wholesale row on the product detail page, for the product itself or
 * for the selected variant.
 *
 * Access is enforced in the database, not here: products_view and
 * product_variants_view only compute wholesale_price for
 * is_wholesaler_or_admin(), and the base tables' column is not readable by
 * any API role. So for a signed-out visitor, or a signed-in customer who is
 * not an approved wholesaler or admin, the value is genuinely absent from the
 * API response — and this component renders nothing at all rather than a
 * placeholder that would hint the price exists.
 */
export function WholesaleReveal({ hasWholesale, price }: WholesaleRevealProps) {
  const { session } = useAuth();
  const [revealed, setRevealed] = useState(false);
  const timerRef = useRef<number>();

  useEffect(() => {
    return () => window.clearTimeout(timerRef.current);
  }, []);

  // Re-blur whenever the row switches to a different price (variant change).
  useEffect(() => {
    setRevealed(false);
  }, [price]);

  // No wholesale price, signed out, or signed in without approval → no row.
  if (!hasWholesale) return null;
  if (session === null) return null;
  if (price === null || price === undefined) return null;

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
        revealed ? `Wholesale price ${formatTaka(price)}` : 'Tap to reveal wholesale price'
      }
    >
      <span className="wholesale-row__label">Wholesale</span>
      <span
        className={`wholesale-row__value${
          revealed ? '' : ' wholesale-row__value--blurred'
        }`}
      >
        {formatTaka(price)}
      </span>
      <span className="wholesale-row__lock" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {revealed ? (
            <>
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 017.9-1" />
            </>
          ) : (
            <>
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 018 0v4" />
            </>
          )}
        </svg>
      </span>
    </button>
  );
}
