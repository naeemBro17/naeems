import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useCart } from '../../contexts/CartContext';
import { useToast } from '../../hooks/useToast';

interface CartButtonProps {
  productId: string;
  productName: string;
  price: number;
  outOfStock: boolean;
}

/** How long the button shows the green checkmark before reverting. */
const ADDED_RESET_MS = 500;

export function CartIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="21" r="1.4" />
      <circle cx="19" cy="21" r="1.4" />
      <path d="M2.5 3h2.4l2.4 12.6a2 2 0 002 1.7h9a2 2 0 002-1.85L21.5 8H6" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * Circular add-to-cart button anchored in the card's reserved button column.
 * Wired to CartContext (Session 9 groundwork) — the checkout flow that reads
 * from it is a separate session.
 */
export function CartButton({ productId, productName, price, outOfStock }: CartButtonProps) {
  const { addItem } = useCart();
  const { showToast } = useToast();
  const [justAdded, setJustAdded] = useState(false);
  // Bumped on every tap so the pulse ring span remounts and its CSS
  // animation restarts, even on rapid repeat taps.
  const [pulseId, setPulseId] = useState(0);
  const resetTimerRef = useRef<number>();

  useEffect(() => {
    return () => window.clearTimeout(resetTimerRef.current);
  }, []);

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (outOfStock) return;

    addItem(productId, price);

    // navigator.vibrate is undefined on iOS Safari — guard so it never throws.
    if (typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(15);
      } catch {
        // Some embedded webviews advertise vibrate but reject the call.
      }
    }

    showToast('Added to cart');
    setJustAdded(true);
    setPulseId((id) => id + 1);
    window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setJustAdded(false), ADDED_RESET_MS);
  };

  return (
    <button
      type="button"
      className={`cart-button${justAdded ? ' cart-button--added' : ''}`}
      onClick={handleClick}
      disabled={outOfStock}
      aria-label={outOfStock ? `${productName} is out of stock` : `Add ${productName} to cart`}
    >
      {pulseId > 0 && <span key={pulseId} className="cart-button__pulse" aria-hidden="true" />}
      {justAdded ? (
        <CheckIcon className="cart-button__icon" />
      ) : (
        <CartIcon className="cart-button__icon" />
      )}
    </button>
  );
}
