import type { Product } from '../types';

/**
 * Stock availability, derived from stock_quantity rather than set
 * independently. A product could previously carry stock_quantity = 0 while
 * stock_status still said 'in_stock'; the count now always wins.
 *
 * stock_quantity is nullable and most of the catalog leaves it blank ("not
 * tracking exact quantity" in the admin form), so a null count is NOT read as
 * zero — those rows fall back to the stock_status flag. Only an explicit 0
 * forces Out of Stock.
 */
export function isInStock(product: Product): boolean {
  if (product.stock_quantity !== null && product.stock_quantity !== undefined) {
    return product.stock_quantity > 0;
  }
  return product.stock_status !== 'out_of_stock';
}

/**
 * Whether ordering should be disabled for a product. Out-of-stock products
 * stay fully visible and searchable — only their ordering-adjacent actions
 * (the Copy Price button) are disabled. Shared by ProductCard, the detail page
 * and the admin list so the check lives in exactly one place.
 */
export function isOutOfStock(product: Product): boolean {
  return !isInStock(product);
}

/**
 * The stock_status value implied by a quantity, so the admin form never lets
 * the two drift apart. Blank quantity leaves the admin's manual choice alone.
 */
export function statusFromQuantity(
  quantity: string,
  fallback: Product['stock_status']
): Product['stock_status'] {
  const trimmed = quantity.trim();
  if (trimmed === '') return fallback;
  const count = Number(trimmed);
  if (!Number.isFinite(count)) return fallback;
  if (count <= 0) return 'out_of_stock';
  return fallback === 'out_of_stock' ? 'in_stock' : fallback;
}
