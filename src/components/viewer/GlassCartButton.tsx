import { useLocation } from 'react-router-dom';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { CartIcon } from './CartButton';
import { CartCountBadge, useCartBump } from './CartBadgeButton';

/** The product page — where the floating cart is a little smaller. */
function isProductPage(pathname: string): boolean {
  return pathname.startsWith('/product/');
}

/** The shop pages that show the floating cart (Batch 27 Part 2; the product
 *  page joined in Batch 28, where it is the only cart button). Never the
 *  cart, checkout, account, orders or admin. */
export function showsGlassCart(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/search' ||
    pathname === '/brands' ||
    pathname.startsWith('/brand/') ||
    isProductPage(pathname)
  );
}

/**
 * Round crystal-glass cart button at the middle of the right edge — the one
 * cart entry point on the shop pages (Batch 28 Part 5). Shown while the cart
 * has something in it: it jumps in the first time an item is added, gives a
 * small pulse on every later add (on the product page also on every remove),
 * and opens the cart when tapped.
 *
 * Rendered next to the bottom nav, outside the page's animated subtree, so
 * its fixed position is never thrown off by a transform (see App.tsx). It
 * sits above the page but below the bottom nav, sheets and dialogs.
 */
export function GlassCartButton() {
  const location = useLocation();
  const navigate = useAppNavigate();
  const onThisPage = showsGlassCart(location.pathname);
  const onProductPage = isProductPage(location.pathname);
  const { itemCount, bump, key } = useCartBump(onThisPage, onProductPage);

  if (itemCount <= 0 || !onThisPage) return null;

  return (
    <button
      type="button"
      className={`glass-cart${onProductPage ? ' glass-cart--pdp' : ''}`}
      onClick={() => navigate('/cart')}
      aria-label={`Open cart, ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}
      data-testid="glass-cart"
    >
      <span key={key} className={`glass-cart__inner${bump === 'none' ? '' : ` cart-bump--${bump}`}`}>
        <CartIcon className="glass-cart__icon" />
        <CartCountBadge count={itemCount} testId="glass-cart-badge" />
      </span>
    </button>
  );
}
