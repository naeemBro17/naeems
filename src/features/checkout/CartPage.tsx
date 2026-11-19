// Step 1 of the checkout flow. Shows the customer's cart: one row per line
// item with a quantity stepper, and a sticky bottom bar with the running
// total and a "Checkout" button. Reads/writes via useCheckoutState (which
// itself reads the cart from CartContext). Routes to DeliveryDetailsPage
// on "Checkout".
import { useMemo, useState } from 'react';
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
import { useSellLimit } from '../../hooks/useSellLimit';
import { useCartCover } from '../../hooks/useCartCover';
import { LimitPopup } from '../../components/viewer/LimitPopup';
import { cartBuyAfterNote, type LimitReason } from '../../lib/sellRules';
import { lineKey } from '../../lib/cartStock';
import { StockNotice } from '../../components/checkout/StockNotice';
import { useCartStockCheck } from '../../hooks/useCartStockCheck';
import type { CartItem } from './types';

export function CartPage() {
  useDocumentTitle("Your Cart — NAEEM'S");
  const { items, subtotal, updateQuantity } = useCheckoutState();
  const { session } = useAuth();
  const navigate = useNavigate();
  const { variantsFor, settings } = useProducts();
  const sell = useSellLimit();
  const [showLoginSheet, setShowLoginSheet] = useState(false);
  // Batch 51: the limit popup over one line's stepper.
  const [popup, setPopup] = useState<{ key: string; reason: LimitReason } | null>(null);
  // Batch 33: catch a line that sold out while it sat in the cart.
  useCartStockCheck();

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

  // + stops at the order limit (Batch 51) — the same rule the cards and
  // the product page use: the option's own stock for a line with an option
  // that sells only from stock, the product's otherwise.
  const lineFacts = (item: CartItem) => {
    const variant =
      item.variantId !== null ? variantsFor(item.product.id).find((v) => v.id === item.variantId) ?? null : null;
    return sell.factsFor(item.product, variant);
  };
  const lineLimit = (item: CartItem): number => sell.maxFor(lineFacts(item));

  const handleIncrement = (item: CartItem) => {
    if (item.quantity >= lineLimit(item)) {
      setPopup({ key: lineKey(item.product.id, item.variantId), reason: sell.reasonFor(lineFacts(item)) });
      return;
    }
    updateQuantity(item.product.id, item.quantity + 1, item.variantId);
  };

  // Batch 51: "Get it in 3–5 days" under a line stock does not fully cover.
  const coverLines = useMemo(
    () =>
      items.map((item) => ({
        productId: item.product.id,
        variantId: item.variantId,
        quantity: item.quantity,
        keepSelling: item.product.keep_selling === true,
      })),
    [items]
  );
  const notCovered = useCartCover(coverLines);

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">Cart</h1>
        <div className="detail-header__actions" />
      </header>

      <CheckoutProgressBar currentStep={1} />

      <main className="detail-main">
        <StockNotice />
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
                    <img
                      src={item.variantImage ?? cardImage(item.product) ?? ''}
                      alt={item.product.name}
                      width={64}
                      height={64}
                      loading="lazy"
                      decoding="async"
                    />
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
                  {notCovered.has(lineKey(item.product.id, item.variantId)) && (
                    <span className="checkout-cart__eta" data-testid="cart-buy-after">
                      {cartBuyAfterNote(settings)}
                    </span>
                  )}
                </div>

                <div className="checkout-cart__row-end">
                  <div className="checkout-cart__stepper">
                    <button
                      type="button"
                      className="checkout-cart__step-btn"
                      onClick={() => {
                        setPopup(null);
                        handleDecrement(item);
                      }}
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
                    {popup && popup.key === lineKey(item.product.id, item.variantId) && (
                      <LimitPopup
                        reason={popup.reason}
                        productName={item.product.name}
                        optionLabel={item.variantLabel}
                        onClose={() => setPopup(null)}
                      />
                    )}
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
