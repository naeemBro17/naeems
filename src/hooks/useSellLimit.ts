import { useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useProducts } from '../contexts/ProductContext';
import { limitReason, orderLimit, type LimitReason } from '../lib/sellRules';
import { maxQuantity, optionStockFacts, productStockFacts, type Buyer, type StockFacts } from '../lib/buyRule';
import type { Product, ProductVariant } from '../types';

export interface SellLimit {
  /** "Most of one item per order" (Admin → Settings). */
  limit: number;
  buyer: Buyer;
  /** Stock facts for the product itself (option null) or one option. */
  factsFor: (product: Product, option: ProductVariant | null) => StockFacts;
  /** The most of that option that may be in the cart. */
  maxFor: (facts: StockFacts) => number;
  /** Why + stopped (the limit popup's words). */
  reasonFor: (facts: StockFacts) => LimitReason;
}

/**
 * Batch 51: the order limit for whoever is shopping. Wholesalers (and the
 * admin, the same is_wholesaler_or_admin() the database uses) have none.
 */
export function useSellLimit(): SellLimit {
  const { settings } = useProducts();
  const { isAdmin, isWholesalerOrAdmin } = useAuth();
  const limit = orderLimit(settings);
  const buyer: Buyer = isAdmin ? 'admin' : isWholesalerOrAdmin ? 'wholesaler' : 'customer';

  const factsFor = useCallback((product: Product, option: ProductVariant | null): StockFacts => {
    // Batch 52.1: the shared rule (an option follows its product).
    return option ? optionStockFacts(option, product.keep_selling) : productStockFacts(product);
  }, []);

  return useMemo(
    () => ({
      limit,
      buyer,
      factsFor,
      maxFor: (facts: StockFacts) => maxQuantity(facts, limit, buyer),
      reasonFor: (facts: StockFacts) => limitReason(facts, limit),
    }),
    [limit, buyer, factsFor]
  );
}
