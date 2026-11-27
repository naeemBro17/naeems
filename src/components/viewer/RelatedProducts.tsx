import { useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useCart } from '../../contexts/CartContext';
import { useProducts } from '../../contexts/ProductContext';
import { useRoutineSettings } from '../../hooks/useRoutineSettings';
import { relatedProducts } from '../../lib/relatedProducts';
import { routineSuggestions, skinProfileOf } from '../../lib/routine';
import type { Product } from '../../types';
import { ProductCard } from './ProductCard';

/** Batch 72: at least this many routine picks replace "You may also like". */
const ROUTINE_ROW_MIN = 2;

/**
 * "You may also like" at the end of the product page (Batch 27 Part 4): up
 * to 6 small product cards in one sideways row, chosen by lib/relatedProducts
 * from the catalogue already loaded. The row uses the browser's own sideways
 * scrolling (no touch code), so up/down page scrolling with a finger on the
 * row works normally. Hidden when fewer than 2 products qualify.
 *
 * Batch 72: when Naeem's routine rules (or "same concern or brand") give 2
 * or more products not in the cart, the row is "Complete your routine"
 * instead, with the same cards.
 */
export function RelatedProducts({ product }: { product: Product }) {
  const { products, categories } = useProducts();
  const { items } = useCart();
  const { profile, isCustomer } = useAuth();
  const { rules, fallback } = useRoutineSettings();
  const cartIds = useMemo(() => new Set(items.map((i) => i.productId)), [items]);
  const skin = useMemo(() => (isCustomer ? skinProfileOf(profile) : null), [isCustomer, profile]);

  const routine = useMemo(
    () =>
      routineSuggestions({ anchor: product, catalogue: products, categories, rules, fallback, exclude: cartIds, profile: skin }).picks.map(
        (p) => p.product
      ),
    [product, products, categories, rules, fallback, cartIds, skin]
  );
  const related = useMemo(() => relatedProducts(product, products), [product, products]);
  const isRoutine = routine.length >= ROUTINE_ROW_MIN;
  const list = isRoutine ? routine : related;

  if (list.length === 0) return null;

  return (
    <section
      className="related"
      aria-labelledby="related-title"
      data-testid="related-products"
      data-kind={isRoutine ? 'routine' : 'related'}
    >
      <h2 id="related-title" className="related__title">
        {isRoutine ? 'Complete your routine' : 'You may also like'}
      </h2>
      <div className="related__row">
        {list.map((item) => (
          <div key={item.id} className="related__item">
            <ProductCard product={item} variant="related" />
          </div>
        ))}
      </div>
    </section>
  );
}
