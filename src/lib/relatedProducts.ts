import type { Product } from '../types';
import { getDisplayPrice } from './pricing';
import { isInStock } from './stockStatus';

/** Most cards in the "You may also like" row. */
export const RELATED_MAX = 6;
/** Below this many matches, the row is topped up with newest products. */
export const RELATED_TOP_UP_BELOW = 3;
/** Below this many cards in total, the row is not shown at all. */
export const RELATED_MIN_SHOWN = 2;

/** The brand a product belongs to: its brand id, else its brand name. */
function brandKey(product: Product): string | null {
  if (product.brand_id) return `id:${product.brand_id}`;
  const name = product.brand?.trim().toLowerCase() ?? '';
  return name === '' ? null : `name:${name}`;
}

function priceOf(product: Product): number {
  return getDisplayPrice(product).mainPrice;
}

/**
 * "You may also like" on the product page (Batch 27 Part 4), from the
 * catalogue the site already loaded — no extra request.
 *
 * Never the current product, a hidden product or an out-of-stock one. Then,
 * in this order: same category AND same brand, then same category, then
 * same brand — inside each group the closest price first (ties by name).
 * Up to 6. With fewer than 3, the row is filled up (to 6) with the newest
 * other in-stock products. With fewer than 2 in the end, it returns nothing (the row hides).
 */
export function relatedProducts(current: Product, catalogue: Product[]): Product[] {
  const pool = catalogue.filter((p) => p.id !== current.id && p.is_active && isInStock(p));
  const category = current.category_id;
  const brand = brandKey(current);
  const price = priceOf(current);

  const rank = (p: Product): number => {
    const sameCategory = category !== null && p.category_id === category;
    const sameBrand = brand !== null && brandKey(p) === brand;
    if (sameCategory && sameBrand) return 0;
    if (sameCategory) return 1;
    if (sameBrand) return 2;
    return 3;
  };

  const matches = pool
    .map((p) => ({ p, group: rank(p), distance: Math.abs(priceOf(p) - price) }))
    .filter((entry) => entry.group < 3)
    .sort((a, b) => a.group - b.group || a.distance - b.distance || a.p.name.localeCompare(b.p.name))
    .slice(0, RELATED_MAX)
    .map((entry) => entry.p);

  let result = matches;
  if (result.length < RELATED_TOP_UP_BELOW) {
    const taken = new Set(result.map((p) => p.id));
    const newest = pool
      .filter((p) => !taken.has(p.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.name.localeCompare(b.name));
    result = [...result, ...newest].slice(0, RELATED_MAX);
  }

  return result.length < RELATED_MIN_SHOWN ? [] : result;
}
