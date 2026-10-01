import type { KeyboardEvent, MouseEvent } from 'react';
import { useCart } from '../../contexts/CartContext';
import { useCartLine } from '../../hooks/useCartLine';
import { trackAddToCart } from '../../lib/analytics';
import type { Product, VariantOption } from '../../types';

interface CartButtonProps {
  product: Product;
  /** variantOptionsFor(product, its variants) — length 1 means no options. */
  options: VariantOption[];
  price: number;
  outOfStock: boolean;
  /** True when the product has Region/Size variants — the card only shows
   *  a "from" price, so which exact variant to add is ambiguous here. */
  hasVariants?: boolean;
  /** Called instead of adding to cart when hasVariants is true, so the
   *  customer picks a variant first (the card opens VariantPickerSheet). */
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

function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M6 12h12" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M12 6v12M6 12h12" />
    </svg>
  );
}

/** A short tap buzz where the phone supports it (never on iOS Safari). */
export function tapHaptic(): void {
  if (typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(15);
  } catch {
    // Some embedded webviews advertise vibrate but reject the call.
  }
}

/** Keeps a tap or key press on the control from also opening the card. */
function stop(e: MouseEvent | KeyboardEvent) {
  e.stopPropagation();
}

/**
 * The card's cart control (Batch 27 Part 3). A neutral round cart button
 * until the product is in the cart; then a compact "− 1 +" stepper showing
 * the real cart quantity — read from the cart itself, so it always agrees
 * with the cart page, the product page and any other card of the product.
 * − at 1 takes it out of the cart and the button comes back. + stops at the
 * tracked stock count with a gentle message. A product with options opens
 * its option picker first; after that the stepper follows the option added.
 */
export function CartButton({
  product,
  options,
  price,
  outOfStock,
  hasVariants = false,
  onRequiresVariant,
}: CartButtonProps) {
  const { addItem } = useCart();
  const line = useCartLine(product, options);

  if (line.quantity > 0) {
    return (
      <div
        className="cart-stepper"
        role="group"
        aria-label={`${product.name} in cart`}
        data-testid="card-stepper"
        onClick={stop}
        onKeyDown={stop}
      >
        <button
          type="button"
          className="cart-stepper__step"
          onClick={() => {
            line.decrement();
            tapHaptic();
          }}
          aria-label={line.quantity === 1 ? `Remove ${product.name} from cart` : `One less ${product.name}`}
        >
          <MinusIcon />
        </button>
        <span className="cart-stepper__qty" aria-live="polite" data-testid="card-stepper-qty">
          {line.quantity}
        </span>
        <button
          type="button"
          className={`cart-stepper__step${line.quantity >= line.limit ? ' cart-stepper__step--max' : ''}`}
          onClick={() => {
            line.increment();
            tapHaptic();
          }}
          aria-label={`One more ${product.name}`}
        >
          <PlusIcon />
        </button>
      </div>
    );
  }

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (outOfStock) return;

    if (hasVariants) {
      onRequiresVariant?.();
      return;
    }

    addItem(product.id, price);
    trackAddToCart({ id: product.id, name: product.name, price }, 1);
    tapHaptic();
  };

  return (
    <button
      type="button"
      className="cart-button"
      onClick={handleClick}
      onKeyDown={stop}
      disabled={outOfStock}
      aria-label={
        outOfStock
          ? `${product.name} is out of stock`
          : hasVariants
            ? `Choose options for ${product.name}`
            : `Add ${product.name} to cart`
      }
    >
      <CartIcon className="cart-button__icon" />
    </button>
  );
}
