import { useCart } from '../../contexts/CartContext';
import type { StockChange } from '../../lib/cartStock';

function itemName(change: StockChange): string {
  return change.label ? `${change.name} (${change.label})` : change.name;
}

/**
 * Batch 33 Part 3: the calm "just sold out" message shown on the cart and
 * the order summary after the cart was corrected to the live stock. Never
 * a database error — only what changed, in plain words.
 */
export function StockNotice() {
  const { stockNotice, dismissStockNotice } = useCart();
  if (!stockNotice || stockNotice.length === 0) return null;
  const anyRemoved = stockNotice.some((c) => c.available === 0);

  return (
    <div className="stock-notice" role="alert" data-testid="stock-notice">
      <svg
        className="stock-notice__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </svg>
      <div className="stock-notice__body">
        {stockNotice.map((change) => (
          <p key={`${change.productId}:${change.variantId ?? ''}`} className="stock-notice__line">
            {change.available === 0 ? (
              <>
                Sorry, <strong>{itemName(change)}</strong> just sold out.
              </>
            ) : (
              <>
                Only <strong>{change.available}</strong> left of <strong>{itemName(change)}</strong> — we've
                updated the quantity.
              </>
            )}
          </p>
        ))}
        {anyRemoved && <p className="stock-notice__line">We've updated your cart.</p>}
      </div>
      <button type="button" className="stock-notice__close" onClick={dismissStockNotice} aria-label="Close message">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
