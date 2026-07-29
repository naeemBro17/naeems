import type { Product } from '../types';

/**
 * Whether ordering should be disabled for a product. Out-of-stock products
 * stay fully visible and searchable — only their ordering-adjacent actions
 * (the Copy Price button) are disabled. Shared by ProductCard and
 * ProductDetailPage so the check lives in exactly one place.
 */
export function isOutOfStock(product: Product): boolean {
  return product.stock_status === 'out_of_stock';
}
