import { supabase, STORAGE_BUCKET, storagePathFromUrl, productThumbPath } from './supabase';
import { resizeImageCard } from './imageResize';
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

/**
 * The small ~400px "card" version of the cover image — grid cards, bento
 * tiles, search results and cart thumbnails should use this instead of
 * coverImage() (Batch 19 performance fix). Falls back to the full-size
 * cover image for any product that hasn't been through the thumbnail
 * backfill yet, exactly as the task asked — never a broken image.
 */
export function cardImage(product: Product): string | null {
  return product.image_urls_thumb?.[0] ?? coverImage(product);
}

/**
 * Fetches an existing full-size image and produces its small "card"
 * version, uploading it next to the original (see productThumbPath).
 * Used both by ProductEditorForm (backfilling a kept pre-thumbnail image on
 * save) and the admin "Generate small images" bulk action. Falls back to
 * returning the original URL unchanged if anything about the image can't be
 * turned into a thumb (not our bucket, fetch failure, etc.) — a missing
 * small version must never be worse than what already worked.
 */
export async function generateCardThumb(fullUrl: string): Promise<string> {
  const path = storagePathFromUrl(fullUrl);
  if (!path) return fullUrl;
  try {
    const res = await fetch(fullUrl);
    if (!res.ok) return fullUrl;
    const original = await res.blob();
    const thumbBlob = await resizeImageCard(original);
    const thumbPath = productThumbPath(path);
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(thumbPath, thumbBlob, { contentType: 'image/webp', upsert: true });
    if (error) return fullUrl;
    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(thumbPath);
    return data.publicUrl;
  } catch {
    return fullUrl;
  }
}
