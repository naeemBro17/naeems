import { useMemo } from 'react';
import { useProducts } from '../../contexts/ProductContext';
import { relatedProducts } from '../../lib/relatedProducts';
import type { Product } from '../../types';
import { ProductCard } from './ProductCard';

/**
 * "You may also like" at the end of the product page (Batch 27 Part 4): up
 * to 6 small product cards in one sideways row, chosen by lib/relatedProducts
 * from the catalogue already loaded. The row uses the browser's own sideways
 * scrolling (no touch code), so up/down page scrolling with a finger on the
 * row works normally. Hidden when fewer than 2 products qualify.
 */
export function RelatedProducts({ product }: { product: Product }) {
  const { products } = useProducts();
  const list = useMemo(() => relatedProducts(product, products), [product, products]);

  if (list.length === 0) return null;

  return (
    <section className="related" aria-labelledby="related-title" data-testid="related-products">
      <h2 id="related-title" className="related__title">
        You may also like
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
