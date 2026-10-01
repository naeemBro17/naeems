import { useEffect, useRef, useState } from 'react';
import { useCart } from '../../contexts/CartContext';

export type CartBump = 'none' | 'enter' | 'pulse';

/**
 * How a cart icon should react to the cart count right now (Batch 27):
 * 'enter' when the cart goes from empty to not empty while on screen (the
 * button jumps in), 'pulse' on every later add, 'none' otherwise. `key`
 * changes on every reaction so the CSS animation restarts each time. While
 * `enabled` is false (the button isn't on this page) adds are only counted,
 * so arriving on a page later never replays an old bounce.
 * `pulseOnRemove` (the product page, Batch 28) also pulses when the count
 * goes down but the cart is not empty yet.
 */
export function useCartBump(
  enabled = true,
  pulseOnRemove = false
): { itemCount: number; bump: CartBump; key: number } {
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
    if (itemCount > before) {
      setState((s) => ({ bump: before === 0 ? 'enter' : 'pulse', key: s.key + 1 }));
      return;
    }
    if (pulseOnRemove && itemCount < before && itemCount > 0) {
      setState((s) => ({ bump: 'pulse', key: s.key + 1 }));
    }
  }, [itemCount, enabled, pulseOnRemove]);

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
