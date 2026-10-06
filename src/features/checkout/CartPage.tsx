// Step 1 of the checkout flow. Shows the customer's cart: one row per line
// item with a quantity stepper, and a sticky bottom bar with the running
// total and a "Checkout" button. Reads/writes via useCheckoutState (which
// itself reads the cart from CartContext). Routes to DeliveryDetailsPage
// on "Checkout".
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppNavigate as useNavigate } from '../../hooks/useAppNavigate';
import { BackButton } from '../../components/shared/BackButton';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { CartIcon } from '../../components/viewer/CartButton';
import { cardImage } from '../../lib/productImages';
import { productPath } from '../../lib/slugify';
import { formatTaka } from '../../lib/format';
import { useAuth } from '../../contexts/AuthContext';
import { CheckoutLoginSheet } from '../../components/checkout/CheckoutLoginSheet';
import { useCheckoutState } from './useCheckoutState';
import { CheckoutProgressBar } from './CheckoutProgressBar';
import { trackInitiateCheckout } from '../../lib/analytics';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { stockLimitMessage } from '../../hooks/useCartLine';
import { stockLimit } from '../../lib/stockStatus';
import type { CartItem } from './types';

export function CartPage() {
  useDocumentTitle("Your Cart — NAEEM'S");
  const { items, subtotal, updateQuantity } = useCheckoutState();
  const { session } = useAuth();
  const navigate = useNavigate();
  const { variantsFor } = useProducts();
  const { showToast } = useToast();
  const [showLoginSheet, setShowLoginSheet] = useState(false);

  const handleCheckout = () => {
    trackInitiateCheckout(
      items.map((item) => ({
        id: item.product.id,
        name: item.product.name,
        price: item.unitPrice,
        quantity: item.quantity,
      })),
      subtotal
    );
    // Already logged in — customer, wholesaler, or admin alike — skip the
    // ask entirely. Only a fully logged-out visitor sees the sheet.
    if (session) {
      navigate('/checkout/delivery');
      return;
    }
    setShowLoginSheet(true);
  };

  // − at 1 removes the line at once, like the cards and the product page's
  // buy bar (Batch 29 Part 4) — the "Removed · Undo" toast puts it back.
  const handleDecrement = (item: CartItem) => {
    updateQuantity(item.product.id, item.quantity - 1, item.variantId);
  };

  // + stops at the tracked stock count (Batch 28 Part 6) — the same limit
  // the cards and the product page use: the option's own count for a line
  // with an option, the product's count otherwise (blank = not tracked).
  const lineLimit = (item: CartItem): number => {
    const variant =
      item.variantId !== null ? variantsFor(item.product.id).find((v) => v.id === item.variantId) : undefined;
    return stockLimit(variant ? variant.stock_quantity : item.product.stock_quantity);
  };

  const handleIncrement = (item: CartItem) => {
    const limit = lineLimit(item);
    if (item.quantity >= limit) {
      showToast(stockLimitMessage(limit), 'info');
      return;
    }
    updateQuantity(item.product.id, item.quantity + 1, item.variantId);
  };

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">Cart</h1>
        <div className="detail-header__actions" />
      </header>

      <CheckoutProgressBar currentStep={1} />

      <main className="detail-main">
        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon" aria-hidden="true">
              <CartIcon />
            </div>
            <p className="empty-state__message">Your cart is empty</p>
            <Link to="/" className="button button--primary">
              Browse products
            </Link>
          </div>
        ) : (
          <ul className="checkout-cart__list">
            {items.map((item) => (
              <li key={`${item.product.id}::${item.variantId ?? ''}`} className="checkout-cart__row">
                <Link to={productPath(item.product)} className="checkout-cart__thumb">
                  {item.variantImage ?? cardImage(item.product) ? (
                    <img src={item.variantImage ?? cardImage(item.product) ?? ''} alt={item.product.name} />
                  ) : (
                    <span className="checkout-cart__thumb-empty" aria-hidden="true" />
                  )}
                </Link>

                <div className="checkout-cart__info">
                  <Link to={productPath(item.product)} className="checkout-cart__name">
                    {item.product.name}
                  </Link>
                  {item.variantLabel && (
                    <span className="checkout-cart__variant">{item.variantLabel}</span>
                  )}
                  <span className="checkout-cart__unit-price">{formatTaka(item.unitPrice)}</span>
                </div>

                <div className="checkout-cart__row-end">
                  <div className="checkout-cart__stepper">
                    <button
                      type="button"
                      className="checkout-cart__step-btn"
                      onClick={() => handleDecrement(item)}
                      aria-label={`Decrease quantity of ${item.product.name}`}
                    >
                      &minus;
                    </button>
                    <span className="checkout-cart__step-count">{item.quantity}</span>
                    <button
                      type="button"
                      className={`checkout-cart__step-btn${
                        item.quantity >= lineLimit(item) ? ' checkout-cart__step-btn--max' : ''
                      }`}
                      onClick={() => handleIncrement(item)}
                      aria-label={`Increase quantity of ${item.product.name}`}
                    >
                      +
                    </button>
                  </div>
                  <span className="checkout-cart__line-total">
                    {formatTaka(item.unitPrice * item.quantity)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      {items.length > 0 && (
        <div className="checkout-cart__sticky-bar">
          <div className="checkout-cart__sticky-total">
            <span className="checkout-cart__sticky-label">Total</span>
            <span className="checkout-cart__sticky-amount">{formatTaka(subtotal)}</span>
          </div>
          <button type="button" className="button button--primary" onClick={handleCheckout}>
            Checkout
          </button>
        </div>
      )}

      <CheckoutLoginSheet
        isOpen={showLoginSheet}
        onClose={() => setShowLoginSheet(false)}
        redirectTo={`${window.location.origin}/checkout/delivery`}
      />
    </div>
  );
}
