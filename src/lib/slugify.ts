import type { SupabaseClient } from '@supabase/supabase-js';
import { slugify } from './format';
import type { Product } from '../types';

/**
 * The path a product's detail page lives at. Rows created before migration-008
 * (and any cached copy of them) have no slug, so the SKU stays a valid
 * identifier — ProductDetailPage resolves either.
 */
export function productPath(product: Product): string {
  return `/product/${product.slug ?? product.sku}`;
}

/**
 * A slug that is unique across the products table. Collisions append -2, -3, …
 * The unique index on products.slug is the real guarantee; this just avoids
 * hitting it in the common case.
 */
export async function uniqueProductSlug(
  client: SupabaseClient,
  name: string,
  excludeId?: string
): Promise<string> {
  const base = slugify(name) || 'product';

  const { data, error } = await client
    .from('products')
    .select('id, slug')
    .like('slug', `${base}%`);

  if (error || !data) {
    // Can't check — return the base and let the unique index arbitrate.
    return base;
  }

  const taken = new Set(
    (data as { id: string; slug: string | null }[])
      .filter((row) => row.id !== excludeId && row.slug !== null)
      .map((row) => row.slug as string)
  );

  if (!taken.has(base)) return base;

  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
