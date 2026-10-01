import { useEffect, useRef, useState } from 'react';
import { useCart } from '../../contexts/CartContext';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { CartIcon } from './CartButton';

export type CartBump = 'none' | 'enter' | 'pulse';

/**
 * How a cart icon should react to the cart count right now (Batch 27):
 * 'enter' when the cart goes from empty to not empty while on screen (the
 * button jumps in), 'pulse' on every later add, 'none' otherwise. `key`
 * changes on every reaction so the CSS animation restarts each time. While
 * `enabled` is false (the button isn't on this page) adds are only counted,
 * so arriving on a page later never replays an old bounce.
 */
export function useCartBump(enabled = true): { itemCount: number; bump: CartBump; key: number } {
  const { itemCount } = useCart();
  const previous = useRef(itemCount);
  const [state, setState] = useState<{ bump: CartBump; key: number }>({ bump: 'none', key: 0 });

  useEffect(() => {
    const before = previous.current;
    previous.current = itemCount;
    if (!enabled) {
      setState((s) => (s.bump === 'none' ? s : { bump: 'none', key: s.key + 1 }));
      return;
    }
    if (itemCount <= before) return;
    setState((s) => ({ bump: before === 0 ? 'enter' : 'pulse', key: s.key + 1 }));
  }, [itemCount, enabled]);

  return { itemCount, ...state };
}

export function CartCountBadge({ count, testId }: { count: number; testId: string }) {
  if (count <= 0) return null;
  return (
    <span className="cart-count-badge" data-testid={testId}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * The round glass cart button in the product page's header (Batch 27
 * Part 1): cart icon + item count; tapping opens the cart. It gives a small
 * pulse each time something is added on the page.
 */
export function HeaderCartButton() {
  const navigate = useAppNavigate();
  const { itemCount, bump, key } = useCartBump();
  return (
    <button
      type="button"
      className="glass-icon-button header-cart"
      onClick={() => navigate('/cart')}
      aria-label={itemCount > 0 ? `Open cart, ${itemCount} ${itemCount === 1 ? 'item' : 'items'}` : 'Open cart'}
      data-testid="header-cart"
    >
      <span key={key} className={`header-cart__icon${bump === 'none' ? '' : ' cart-bump--pulse'}`}>
        <CartIcon className="glass-icon-button__svg" />
      </span>
      <CartCountBadge count={itemCount} testId="header-cart-badge" />
    </button>
  );
}
