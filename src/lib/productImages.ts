import {
  supabase,
  STORAGE_BUCKET,
  storagePathFromUrl,
  smallCopyPath,
  productCardPath,
  newProductImagePath,
  LONG_CACHE_SECONDS,
} from './supabase';
import { resizeImage, resizeImageCard } from './imageResize';
import type { Product, ProductVariant } from '../types';

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
 * The small 480 px "card" version of the cover image — grid cards, bento
 * tiles, search results and cart thumbnails should use this instead of
 * coverImage() (Batch 19 performance fix). Falls back to the full-size
 * cover image for any product that hasn't been through the thumbnail
 * backfill yet, exactly as the task asked — never a broken image.
 */
export function cardImage(product: Product): string | null {
  return product.image_urls_thumb?.[0] ?? coverImage(product);
}

/** Whether a stored file sits in a `folder`/ folder of our bucket. */
function inFolder(url: string, folder: string): boolean {
  const path = storagePathFromUrl(url);
  return path !== null && (path.startsWith(`${folder}/`) || path.includes(`/${folder}/`));
}

/**
 * Batch 40: the small copy of one of a product's (or its options') large
 * photos, for a small picture (option sheet, cart, order summary); the
 * large photo itself when it has no small copy yet.
 */
export function smallImageFor(url: string, product: Product, variants: ProductVariant[] = []): string {
  const index = productImages(product).indexOf(url);
  const productSmall = index === -1 ? undefined : product.image_urls_thumb?.[index];
  if (isSmallCopy(url, productSmall)) return productSmall as string;
  const variant = variants.find((v) => v.image_url === url);
  if (variant && isSmallCopy(url, variant.image_url_thumb)) return variant.image_url_thumb as string;
  return url;
}

/**
 * Batch 31 Part 8: true only for a real small copy — a file in a thumb/
 * folder (Batch 40: or card/), not the full photo itself. Until Batch 31 a
 * failed copy saved the full photo's address in the "small" slot, so the
 * product looked done and was never retried (91 of 98 products on 6 Oct 2026).
 */
export function isSmallCopy(fullUrl: string | null | undefined, smallUrl: string | null | undefined): boolean {
  if (!fullUrl || !smallUrl || smallUrl === fullUrl) return false;
  return inFolder(smallUrl, 'thumb') || inFolder(smallUrl, 'card');
}

/** Batch 40: the 480 px card copy (card/ folder, kept a year), not an
 *  older 400 px thumb/ copy. */
export function isCardCopy(fullUrl: string | null | undefined, smallUrl: string | null | undefined): boolean {
  return isSmallCopy(fullUrl, smallUrl) && inFolder(smallUrl as string, 'card');
}

/** Whether a product still needs small copies for any of its photos. */
export function productNeedsSmallCopies(product: Product): boolean {
  const full = productImages(product);
  const small = product.image_urls_thumb ?? [];
  return full.some((url, i) => !isSmallCopy(url, small[i]));
}

/** Batch 40: whether any of a product's photos has no 480 px card copy yet. */
export function productNeedsCardCopies(product: Product): boolean {
  const full = productImages(product);
  const small = product.image_urls_thumb ?? [];
  return full.some((url, i) => !isCardCopy(url, small[i]));
}

/** The query mark for a one-off admin download of a stored photo. The
 *  offline helper never keeps these (vite.config.ts). */
export const ADMIN_COPY_MARK = 'small-copy-source';

/**
 * Downloads a stored file for the admin's own processing, never from a
 * cache: the shop's offline helper keeps product photos as "opaque" copies
 * (images load without CORS), and a plain fetch() of the same address was
 * answered with that unreadable copy — the Batch 19–30 reason small copies
 * failed. The one-off mark also keeps it out of the offline helper.
 */
export async function downloadForCopy(url: string): Promise<Blob | null> {
  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}${ADMIN_COPY_MARK}=${Date.now()}`, { cache: 'no-store' });
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

/**
 * Fetches an existing full-size image and uploads a small copy of it next
 * to the original (see smallCopyPath): a 480 px card copy by default, or a
 * Browse-circle copy. Null when it can't (not our bucket, download or
 * upload failed) — the caller keeps the full photo.
 */
export async function makeSmallCopy(
  fullUrl: string,
  resize: (original: Blob) => Promise<Blob> = resizeImageCard,
  folder: 'card' | 'thumb' = 'card'
): Promise<string | null> {
  const path = storagePathFromUrl(fullUrl);
  if (!path) return null;
  try {
    const original = await downloadForCopy(fullUrl);
    if (!original) return null;
    const smallBlob = await resize(original);
    const smallPath = smallCopyPath(path, folder);
    // The copy's name comes from the photo's own (new, unique) name, so it
    // is written once; upsert only matters if an earlier try half-finished.
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(smallPath, smallBlob, { contentType: 'image/webp', upsert: true, cacheControl: LONG_CACHE_SECONDS });
    if (error) return null;
    return supabase.storage.from(STORAGE_BUCKET).getPublicUrl(smallPath).data.publicUrl;
  } catch {
    return null;
  }
}

/**
 * Batch 40: stores a newly chosen product photo as two WebP files with new
 * names, both kept by phones for a year — the large one (1400 px, product
 * page and zoom) at products/{id}.webp and the card one (480 px: grids,
 * bento, lists) at products/card/{id}.webp. Throws if the large one can't
 * be stored; a failed card copy falls back to the large photo.
 */
export async function uploadProductPhoto(file: Blob): Promise<{ url: string; cardUrl: string }> {
  const path = newProductImagePath();
  const cardPath = productCardPath(path);
  const [large, card] = await Promise.all([resizeImage(file), resizeImageCard(file)]);
  const bucket = supabase.storage.from(STORAGE_BUCKET);
  const [largeUpload, cardUpload] = await Promise.all([
    bucket.upload(path, large, { contentType: 'image/webp', cacheControl: LONG_CACHE_SECONDS }),
    bucket.upload(cardPath, card, { contentType: 'image/webp', cacheControl: LONG_CACHE_SECONDS }),
  ]);
  if (largeUpload.error) throw largeUpload.error;
  const url = bucket.getPublicUrl(path).data.publicUrl;
  return { url, cardUrl: cardUpload.error ? url : bucket.getPublicUrl(cardPath).data.publicUrl };
}

/**
 * The small "card" version of a product photo, or the photo itself when a
 * copy can't be made (a missing small version must never be worse than what
 * already worked). Used by ProductEditorForm and "Make images light".
 */
export async function generateCardThumb(fullUrl: string): Promise<string> {
  return (await makeSmallCopy(fullUrl)) ?? fullUrl;
}
