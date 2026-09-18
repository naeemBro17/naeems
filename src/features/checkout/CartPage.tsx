// Step 1 of the checkout flow. Shows the customer's cart: one row per line
// item with a quantity stepper, and a sticky bottom bar with the running
// total and a "Checkout" button. Reads/writes via useCheckoutState (which
// itself reads the cart from CartContext). Routes to DeliveryDetailsPage
// on "Checkout".
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BackButton } from '../../components/shared/BackButton';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog';
import { CartIcon } from '../../components/viewer/CartButton';
import { coverImage } from '../../lib/productImages';
import { productPath } from '../../lib/slugify';
import { formatTaka } from '../../lib/format';
import { useCheckoutState } from './useCheckoutState';
import { CheckoutProgressBar } from './CheckoutProgressBar';
import type { CartItem } from './types';

export function CartPage() {
  const { items, subtotal, updateQuantity, removeItem } = useCheckoutState();
  const navigate = useNavigate();
  const [pendingRemove, setPendingRemove] = useState<CartItem | null>(null);

  const handleDecrement = (item: CartItem) => {
    if (item.quantity > 1) {
      updateQuantity(item.product.id, item.quantity - 1, item.variantId);
    } else {
      setPendingRemove(item);
    }
  };

  const handleConfirmRemove = () => {
    if (pendingRemove) removeItem(pendingRemove.product.id, pendingRemove.variantId);
    setPendingRemove(null);
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
                  {item.variantImage ?? coverImage(item.product) ? (
                    <img src={item.variantImage ?? coverImage(item.product) ?? ''} alt={item.product.name} />
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
                      className="checkout-cart__step-btn"
                      onClick={() =>
                        updateQuantity(item.product.id, item.quantity + 1, item.variantId)
                      }
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
          <button
            type="button"
            className="button button--primary"
            onClick={() => navigate('/checkout/delivery')}
          >
            Checkout
          </button>
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingRemove !== null}
        title="Remove this item?"
        message={
          pendingRemove ? `"${pendingRemove.product.name}" will be removed from your cart.` : ''
        }
        confirmLabel="Remove"
        onConfirm={handleConfirmRemove}
        onClose={() => setPendingRemove(null)}
      />
    </div>
  );
}
