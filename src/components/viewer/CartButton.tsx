import { useState, type MouseEvent } from 'react';
import { useCart } from '../../contexts/CartContext';
import { trackAddToCart } from '../../lib/analytics';

interface CartButtonProps {
  productId: string;
  productName: string;
  price: number;
  outOfStock: boolean;
  /** True when the product has Region/Size variants — the card only shows
   *  a "from" price, so which exact variant to add is ambiguous here. */
  hasVariants?: boolean;
  /** Called instead of adding to cart when hasVariants is true, so the
   *  customer picks a variant on the detail page first. */
  onRequiresVariant?: () => void;
}

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
 *
 * The checkmark reflects real cart membership (items.some(...)), not a
 * timer — a local "just added" flag used to revert to the plain icon after
 * ~500ms even though the item was still genuinely in the cart, which read as
 * "the tap didn't work." It now only ever shows the plain icon when this
 * product truly isn't in the cart.
 */
export function CartButton({
  productId,
  productName,
  price,
  outOfStock,
  hasVariants = false,
  onRequiresVariant,
}: CartButtonProps) {
  const { items, addItem } = useCart();
  // A card only ever adds the plain product (variants require the detail
  // page — see onRequiresVariant), so "in cart" here means any line for this
  // product, regardless of which variant it ended up as.
  const inCart = items.some((item) => item.productId === productId);
  // Bumped on every tap so the pulse ring span remounts and its CSS
  // animation restarts, even on rapid repeat taps.
  const [pulseId, setPulseId] = useState(0);

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (outOfStock) return;

    if (hasVariants) {
      onRequiresVariant?.();
      return;
    }

    addItem(productId, price);
    trackAddToCart({ id: productId, name: productName, price }, 1);

    // navigator.vibrate is undefined on iOS Safari — guard so it never throws.
    if (typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(15);
      } catch {
        // Some embedded webviews advertise vibrate but reject the call.
      }
    }

    setPulseId((id) => id + 1);
  };

  return (
    <button
      type="button"
      className={`cart-button${inCart ? ' cart-button--added' : ''}`}
      onClick={handleClick}
      disabled={outOfStock}
      aria-label={
        outOfStock
          ? `${productName} is out of stock`
          : hasVariants
            ? `Choose options for ${productName}`
            : `Add ${productName} to cart`
      }
    >
      {pulseId > 0 && <span key={pulseId} className="cart-button__pulse" aria-hidden="true" />}
      {inCart ? (
        <CheckIcon className="cart-button__icon" />
      ) : (
        <CartIcon className="cart-button__icon" />
      )}
    </button>
  );
}
