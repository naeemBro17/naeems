import type { Product } from '../types';

/** Batch 72: the main category first, then the extra ones (no repeats). */
export function productCategoryIds(product: Product): string[] {
  const ids = product.category_id ? [product.category_id] : [];
  for (const id of product.extra_category_ids ?? []) if (!ids.includes(id)) ids.push(id);
  return ids;
}

export function inCategory(product: Product, categoryId: string): boolean {
  return productCategoryIds(product).includes(categoryId);
}

/**
 * Exact category filter used by the home grid and the search page's
 * category picks. `null` means "All" — no filtering. Kept as its own pure
 * function (rather than folded into useProductFilters, which is brand/skin
 * type only) so it's trivially unit-testable and reusable from both pages.
 * Batch 72: a product is in its main category and in every extra one.
 */
export function filterByCategory(products: Product[], categoryId: string | null): Product[] {
  if (categoryId === null) return products;
  return products.filter((p) => inCategory(p, categoryId));
}

/** Batch 71: the Shop grid filtered by one category (null = all). */
export function categoryPath(slug: string | null): string {
  return slug ? `/shop?cat=${encodeURIComponent(slug)}` : '/shop';
}

/** Batch 72: the Shop grid filtered by one concern. */
export function concernPath(name: string): string {
  return `/shop?concern=${encodeURIComponent(name)}`;
}
