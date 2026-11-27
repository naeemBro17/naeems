// Step 1 of the checkout flow. Shows the customer's cart: one row per line
// item with a quantity stepper, and a sticky bottom bar with the running
// total and a "Checkout" button. Reads/writes via useCheckoutState (which
// itself reads the cart from CartContext). Routes to DeliveryDetailsPage
// on "Checkout".
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BackButton } from '../../components/shared/BackButton';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { cardImage } from '../../lib/productImages';
import { productPath } from '../../lib/slugify';
import { formatTaka } from '../../lib/format';
import { useAuth } from '../../contexts/AuthContext';
import { useCheckoutState } from './useCheckoutState';
import { CheckoutProgressBar } from './CheckoutProgressBar';
import { useProducts } from '../../contexts/ProductContext';
import { useCartLineLimits } from '../../hooks/useCartLineLimits';
import { useCartCheckout } from './useCartCheckout';
import { useCartCover } from '../../hooks/useCartCover';
import { LimitPopup } from '../../components/viewer/LimitPopup';
import { cartBuyAfterNote, type LimitReason } from '../../lib/sellRules';
import { lineKey } from '../../lib/cartStock';
import { StockNotice } from '../../components/checkout/StockNotice';
import { useCartStockCheck } from '../../hooks/useCartStockCheck';
import { MakeComboSheet, ShareComboCard } from '../../components/combo/ComboShare';
import { useCart } from '../../contexts/CartContext';
import type { CartItem } from './types';
import { CartSaleTag } from '../../components/campaign/CartSaleTag';
import { ArrowRightIcon, CheckIcon, ClockIcon, EmptyBagArt, MinusIcon, PlusIcon, ShieldIcon, TrashIcon } from '../../components/checkout/b67Icons';
import { cartYouSave, countPieces } from '../../lib/cartTotals';
import '../../styles/batch67.css';

export function CartPage() {
  useDocumentTitle("Your Cart | NAEEM'S");
  const { items, subtotal, updateQuantity } = useCheckoutState();
  const { isAdmin } = useAuth();
  const { clearCart } = useCart();
  // Batch 52: the admin's "Share as a combo" (real session role, never CSS).
  const [comboOpen, setComboOpen] = useState(false);
  const { settings } = useProducts();
  // Batch 51: the limit popup over one line's stepper.
  const [popup, setPopup] = useState<{ key: string; reason: LimitReason } | null>(null);
  // Batch 33: catch a line that sold out while it sat in the cart.
  useCartStockCheck();

  // Batch 70: the same Checkout the side cart runs.
  const { checkout, loginSheet } = useCartCheckout();
  const handleCheckout = () => checkout();

  // − at 1 removes the line at once, like the cards and the product page's
  // buy bar (Batch 29 Part 4) — the "Removed · Undo" toast puts it back.
  const handleDecrement = (item: CartItem) => {
    updateQuantity(item.product.id, item.quantity - 1, item.variantId);
  };

  // + stops at the order limit (Batch 51) — the same rule the cards, the
  // product page and the side cart use (useCartLineLimits).
  const { limitOf: lineLimit, reasonOf: lineReason } = useCartLineLimits();

  const handleIncrement = (item: CartItem) => {
    if (item.quantity >= lineLimit(item)) {
      setPopup({ key: lineKey(item.product.id, item.variantId), reason: lineReason(item) });
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
  const comboItems = useMemo(
    () => items.map((item) => ({ product_id: item.product.id, variant_id: item.variantId, quantity: item.quantity })),
    [items]
  );

  // Batch 67: how many pieces, and how much the customer saves against retail.
  const pieceCount = countPieces(items);
  const youSave = cartYouSave(items);

  return (
    <div className="viewer-shell detail-shell b67">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">Cart</h1>
        <div className="detail-header__actions">
          {items.length > 0 && (
            <span className="b67-count" data-testid="cart-count">
              {pieceCount} {pieceCount === 1 ? 'item' : 'items'}
            </span>
          )}
        </div>
      </header>

      {items.length > 0 && <CheckoutProgressBar currentStep={1} />}

      <main className="b67-main">
        <StockNotice />
        {items.length === 0 ? (
          <div className="b67-empty empty-state">
            <EmptyBagArt />
            <h2 className="b67-empty__title empty-state__message">Your cart is empty</h2>
            <p className="b67-empty__text">Find something your skin will love.</p>
            <Link to="/shop" className="b67-cta">
              Browse products
            </Link>
          </div>
        ) : (
          <>
            <ul className="b67-list">
              {items.map((item) => {
                const key = lineKey(item.product.id, item.variantId);
                const image = item.variantImage ?? cardImage(item.product);
                const atMax = item.quantity >= lineLimit(item);
                const struck = item.retail !== null && item.retail > item.unitPrice ? item.retail : null;
                return (
                  <li key={`${item.product.id}::${item.variantId ?? ''}`} className="b67-line" data-testid="cart-line">
                    <Link to={productPath(item.product)} className="b67-thumb" data-testid="cart-line-thumb">
                      {image && (
                        <img src={image} alt={item.product.name} width={84} height={84} loading="lazy" decoding="async" />
                      )}
                    </Link>

                    <div className="b67-info">
                      <Link to={productPath(item.product)} className="b67-name">
                        {item.product.name}
                      </Link>
                      {item.variantLabel && (
                        <span className="b67-variant" data-testid="cart-line-variant">
                          {item.variantLabel}
                        </span>
                      )}
                      {item.sale && <CartSaleTag sale={item.sale} />}
                      {notCovered.has(key) && (
                        <span className="b67-eta" data-testid="cart-buy-after">
                          <ClockIcon />
                          {cartBuyAfterNote(settings)}
                        </span>
                      )}

                      <div className="b67-row">
                        <div className="b67-price">
                          <b data-testid="cart-line-total">{formatTaka(item.unitPrice * item.quantity)}</b>
                          {item.quantity > 1 ? (
                            <em data-testid="cart-unit-price">
                              {formatTaka(item.unitPrice)} each{struck !== null && <> <s>{formatTaka(struck)}</s></>}
                            </em>
                          ) : (
                            struck !== null && <s>{formatTaka(struck)}</s>
                          )}
                        </div>

                        <div className="b67-qty" data-testid="cart-stepper">
                          <button
                            type="button"
                            className="b67-qty__btn"
                            onClick={() => {
                              setPopup(null);
                              handleDecrement(item);
                            }}
                            aria-label={
                              item.quantity === 1
                                ? `Remove ${item.product.name}`
                                : `Decrease quantity of ${item.product.name}`
                            }
                            data-testid="cart-minus"
                          >
                            {item.quantity === 1 ? <TrashIcon /> : <MinusIcon />}
                          </button>
                          <span className="b67-qty__count" data-testid="cart-qty">
                            {item.quantity}
                          </span>
                          <button
                            type="button"
                            className={`b67-qty__btn b67-qty__btn--plus${atMax ? ' b67-qty__btn--max' : ''}`}
                            onClick={() => handleIncrement(item)}
                            aria-label={`Increase quantity of ${item.product.name}`}
                            data-testid="cart-plus"
                          >
                            <PlusIcon />
                          </button>
                          {popup && popup.key === key && (
                            <LimitPopup
                              reason={popup.reason}
                              productName={item.product.name}
                              optionLabel={item.variantLabel}
                              onClose={() => setPopup(null)}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            <p className="b67-note" data-testid="cart-trust">
              <ShieldIcon />
              <span>
                <b>100% authentic,</b> imported by Naeem's.
              </span>
            </p>
          </>
        )}
        {isAdmin && items.length > 0 && <ShareComboCard onOpen={() => setComboOpen(true)} />}
      </main>

      {items.length > 0 && (
        <div className="b67-bar" data-testid="cart-bar">
          <div className="b67-bar__total">
            <small>Subtotal</small>
            <strong data-testid="cart-subtotal">{formatTaka(subtotal)}</strong>
            {youSave > 0 && (
              <span className="b67-save" data-testid="cart-you-save">
                <CheckIcon />
                You save {formatTaka(youSave)}
              </span>
            )}
          </div>
          <button type="button" className="b67-cta" onClick={handleCheckout}>
            Checkout
            <ArrowRightIcon />
          </button>
        </div>
      )}

      {isAdmin && (
        <MakeComboSheet isOpen={comboOpen} onClose={() => setComboOpen(false)} items={comboItems} onClearCart={clearCart} />
      )}

      {loginSheet}
    </div>
  );
}
