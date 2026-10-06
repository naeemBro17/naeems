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
 * Batch 31 Part 8: true only for a real small copy — a file in a thumb/
 * folder, not the full photo itself. Until Batch 31 a failed copy saved the
 * full photo's address in the "small" slot, so the product looked done and
 * was never retried (91 of 98 products on 6 Oct 2026).
 */
export function isSmallCopy(fullUrl: string | null | undefined, smallUrl: string | null | undefined): boolean {
  if (!fullUrl || !smallUrl || smallUrl === fullUrl) return false;
  const path = storagePathFromUrl(smallUrl);
  return path !== null && (path.startsWith('thumb/') || path.includes('/thumb/'));
}

/** Whether a product still needs small copies for any of its photos. */
export function productNeedsSmallCopies(product: Product): boolean {
  const full = productImages(product);
  const small = product.image_urls_thumb ?? [];
  return full.some((url, i) => !isSmallCopy(url, small[i]));
}

/**
 * Fetches an existing full-size image and uploads a small copy of it next
 * to the original (see productThumbPath). Null when it can't (not our
 * bucket, download or upload failed) — the caller keeps the full photo.
 *
 * The photo is downloaded with a one-off query string: the shop's offline
 * helper keeps product photos as "opaque" copies (images load without
 * CORS), and a plain fetch() of the same address was answered with that
 * unreadable copy — the Batch 19–30 reason small copies failed.
 */
export async function makeSmallCopy(
  fullUrl: string,
  resize: (original: Blob) => Promise<Blob> = resizeImageCard
): Promise<string | null> {
  const path = storagePathFromUrl(fullUrl);
  if (!path) return null;
  try {
    const sep = fullUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${fullUrl}${sep}small-copy-source=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const original = await res.blob();
    const smallBlob = await resize(original);
    const smallPath = productThumbPath(path);
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(smallPath, smallBlob, { contentType: 'image/webp', upsert: true });
    if (error) return null;
    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(smallPath);
    // Versioned, like uploadAdminImage: a replaced photo (same path) must
    // never show its old small copy from a cache.
    return `${data.publicUrl}?v=${Date.now()}`;
  } catch {
    return null;
  }
}

/**
 * The small "card" version of a product photo, or the photo itself when a
 * copy can't be made (a missing small version must never be worse than what
 * already worked). Used by ProductEditorForm and "Generate small images".
 */
export async function generateCardThumb(fullUrl: string): Promise<string> {
  return (await makeSmallCopy(fullUrl)) ?? fullUrl;
}
