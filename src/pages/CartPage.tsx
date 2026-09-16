import { Link } from 'react-router-dom';
import { useCart } from '../contexts/CartContext';
import { useProducts } from '../contexts/ProductContext';
import { formatTaka } from '../lib/format';
import { coverImage } from '../lib/productImages';
import { productPath } from '../lib/slugify';
import { BackButton } from '../components/shared/BackButton';
import { CartIcon } from '../components/viewer/CartButton';
import type { Product } from '../types';

interface ResolvedCartRow {
  product: Product;
  quantity: number;
  priceAtAdd: number;
}

/**
 * Placeholder /cart route (Session 9 groundwork). Reads CartContext and
 * lists what's in it; the checkout session replaces this page entirely with
 * the real flow.
 */
export function CartPage() {
  const { items, removeItem, itemCount, subtotal } = useCart();
  const { products } = useProducts();

  // Line items whose product no longer exists (deleted since it was added)
  // are skipped rather than crashing the page.
  const rows: ResolvedCartRow[] = items.flatMap((item) => {
    const product = products.find((p) => p.id === item.productId);
    return product
      ? [{ product, quantity: item.quantity, priceAtAdd: item.priceAtAdd }]
      : [];
  });

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">Cart</h1>
        <div className="detail-header__actions" />
      </header>

      <main className="detail-main">
        {rows.length === 0 ? (
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
          <>
            <ul className="cart-page__list">
              {rows.map((row) => (
                <li key={row.product.id} className="cart-page__row">
                  <Link to={productPath(row.product)} className="cart-page__thumb">
                    {coverImage(row.product) ? (
                      <img src={coverImage(row.product) ?? ''} alt={row.product.name} />
                    ) : (
                      <span className="cart-page__thumb-empty" aria-hidden="true" />
                    )}
                  </Link>
                  <div className="cart-page__info">
                    <Link to={productPath(row.product)} className="cart-page__name">
                      {row.product.name}
                    </Link>
                    <span className="cart-page__qty">
                      Qty {row.quantity} &times; {formatTaka(row.priceAtAdd)}
                    </span>
                  </div>
                  <div className="cart-page__row-end">
                    <span className="cart-page__line-total">
                      {formatTaka(row.priceAtAdd * row.quantity)}
                    </span>
                    <button
                      type="button"
                      className="cart-page__remove"
                      onClick={() => removeItem(row.product.id)}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <div className="cart-page__summary">
              <span>{itemCount} item{itemCount === 1 ? '' : 's'}</span>
              <span className="cart-page__subtotal">{formatTaka(subtotal)}</span>
            </div>

            <p className="cart-page__note">Checkout is coming soon.</p>
          </>
        )}
      </main>
    </div>
  );
}
