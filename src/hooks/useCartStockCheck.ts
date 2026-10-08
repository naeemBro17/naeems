import { useCallback, useEffect, useRef } from 'react';
import { useCart } from '../contexts/CartContext';
import { checkCartStock } from '../lib/cartStock';

/**
 * Batch 33 Part 3: re-reads the live stock for the cart when the page opens
 * (the cart page, and the order summary before the final step), and on
 * demand after an order is refused for stock. Any line that asks for more
 * than is left is lowered or removed, and the "just sold out" message shows.
 * `recheck` resolves true when the cart had to change.
 */
export function useCartStockCheck(): { recheck: () => Promise<boolean> } {
  const { items, applyStockChanges } = useCart();
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const recheck = useCallback(async () => {
    const lines = itemsRef.current.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
    }));
    if (lines.length === 0) return false;
    const changes = await checkCartStock(lines);
    if (!changes || changes.length === 0) return false;
    applyStockChanges(changes);
    return true;
  }, [applyStockChanges]);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  return { recheck };
}
