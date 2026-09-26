import type { Product } from '../types';

/**
 * Exact category filter used by the home grid and the search page's
 * category picks. `null` means "All" — no filtering. Kept as its own pure
 * function (rather than folded into useProductFilters, which is brand/skin
 * type only) so it's trivially unit-testable and reusable from both pages.
 */
export function filterByCategory(products: Product[], categoryId: string | null): Product[] {
  if (categoryId === null) return products;
  return products.filter((p) => p.category_id === categoryId);
}
