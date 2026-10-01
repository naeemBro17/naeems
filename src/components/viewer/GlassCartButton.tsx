import { useLocation } from 'react-router-dom';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { CartIcon } from './CartButton';
import { CartCountBadge, useCartBump } from './CartBadgeButton';

/** The pages that show the floating cart (Batch 27 Part 2). Not the product
 *  page (it has its own header cart), the cart, checkout, account or admin. */
export function showsGlassCart(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/search' ||
    pathname === '/brands' ||
    pathname.startsWith('/brand/')
  );
}

/**
 * Round glass cart button at the middle of the right edge (Batch 27 Part 2),
 * for shoppers who don't think of the Cart tab after adding. Shown while the
 * cart has something in it: it jumps in the first time an item is added,
 * gives a small pulse on every later add, and opens the cart when tapped.
 *
 * Rendered next to the bottom nav, outside the page's animated subtree, so
 * its fixed position is never thrown off by a transform (see App.tsx). It
 * sits above the page but below the bottom nav, sheets and dialogs.
 */
export function GlassCartButton() {
  const location = useLocation();
  const navigate = useAppNavigate();
  const onThisPage = showsGlassCart(location.pathname);
  const { itemCount, bump, key } = useCartBump(onThisPage);

  if (itemCount <= 0 || !onThisPage) return null;

  return (
    <button
      type="button"
      className="glass-cart"
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
