import { useCallback } from 'react';
import { useProducts } from '../contexts/ProductContext';
import { useSellLimit } from './useSellLimit';
import type { LimitReason } from '../lib/sellRules';
import type { CartItem } from '../features/checkout/types';

export interface CartLineLimits {
  /** Most units this line may have (Batch 51: the order limit, or the stock). */
  limitOf: (item: CartItem) => number;
  /** Why + stops at the limit, for the limit popup. */
  reasonOf: (item: CartItem) => LimitReason;
}

/**
 * The + rule for a cart line (Batch 51), shared by the cart page and the
 * side cart (Batch 70) so both stop at the same number: the option's own
 * stock for a line with an option that sells only from stock, the
 * product's otherwise.
 */
export function useCartLineLimits(): CartLineLimits {
  const { variantsFor } = useProducts();
  const sell = useSellLimit();

  const factsOf = useCallback(
    (item: CartItem) => {
      const variant =
        item.variantId !== null ? variantsFor(item.product.id).find((v) => v.id === item.variantId) ?? null : null;
      return sell.factsFor(item.product, variant);
    },
    [variantsFor, sell]
  );

  const limitOf = useCallback((item: CartItem) => sell.maxFor(factsOf(item)), [sell, factsOf]);
  const reasonOf = useCallback((item: CartItem) => sell.reasonFor(factsOf(item)), [sell, factsOf]);

  return { limitOf, reasonOf };
}
