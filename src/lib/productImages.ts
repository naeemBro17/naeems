import type { Product } from '../types';

/**
 * All images for a product, in display order.
 * Falls back to the legacy single image_url for rows/caches that predate
 * the image_urls migration.
 */
export function productImages(product: Product): string[] {
  if (product.image_urls && product.image_urls.length > 0) {
    return product.image_urls;
  }
  return product.image_url ? [product.image_url] : [];
}

/** The cover image (first in display order), or null when there are none. */
export function coverImage(product: Product): string | null {
  return productImages(product)[0] ?? null;
}
