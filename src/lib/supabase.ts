import { createClient } from '@supabase/supabase-js';
import { resizeImage } from './imageResize';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase configuration. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const STORAGE_BUCKET = 'product-images';

/**
 * Batch 40: how long phones and Supabase's CDN may keep a stored file —
 * one year. Safe because every upload gets a new file name, so a stored
 * file never changes. (Supabase writes this as "public, max-age=31536000";
 * it has no way to add "immutable", which a new name makes unnecessary.)
 */
export const LONG_CACHE_SECONDS = '31536000';

/** A random id for a new file name. */
export function randomFileId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Storage path for a newly uploaded product image. Random name so paths are
 * stable across SKU renames and multiple images never collide.
 */
export function newProductImagePath(): string {
  return `products/${randomFileId()}.webp`;
}

/**
 * Derive the storage path from a public URL in our bucket (query string
 * stripped), or null if the URL doesn't belong to this bucket.
 * Handles both legacy products/{sku}.webp and new random paths.
 */
export function storagePathFromUrl(url: string): string | null {
  const marker = `/object/public/${STORAGE_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return null;
  const path = url.slice(index + marker.length).split('?')[0];
  return path === '' ? null : decodeURIComponent(path);
}

/**
 * A small copy of a stored photo lives one folder deeper, same filename:
 * products/{id}.webp → products/card/{id}.webp (Batch 40: the 480 px card
 * copy; Batch 19–39 copies are in thumb/) or categories/thumb/{id}.webp
 * (Browse circles). The same filename means a photo's copy is always
 * derivable from its own path, and since every photo has its own new name,
 * so does its copy.
 */
export function smallCopyPath(fullPath: string, folder: 'card' | 'thumb'): string {
  const slashIndex = fullPath.lastIndexOf('/');
  return slashIndex === -1
    ? `${folder}/${fullPath}`
    : `${fullPath.slice(0, slashIndex)}/${folder}/${fullPath.slice(slashIndex + 1)}`;
}

/** The card copy of a product photo (see smallCopyPath). */
export function productCardPath(fullPath: string): string {
  return smallCopyPath(fullPath, 'card');
}

/**
 * "banners/{id}.webp" → "banners/{id}-{random}.webp": the same place, a new
 * name for every upload (Batch 40 — a stored file never changes, so it can
 * be kept for a year).
 */
export function uniqueImagePath(path: string): string {
  const dot = path.lastIndexOf('.');
  const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
  return `${stem}-${randomFileId().slice(0, 8)}.webp`;
}

/**
 * Shared single-image upload used by every admin "one photo" field (banner
 * slide image, category image, variant photo, expert photo) — resizes
 * client-side, then uploads under a new name next to `path` (Batch 40:
 * never over an old file, which phones may keep for a year). The old file
 * stays in Storage.
 */
export async function uploadAdminImage(path: string, file: File): Promise<string> {
  const blob = await resizeImage(file);
  const uniquePath = uniqueImagePath(path);
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(uniquePath, blob, { contentType: 'image/webp', cacheControl: LONG_CACHE_SECONDS });
  if (error) throw error;
  return supabase.storage.from(STORAGE_BUCKET).getPublicUrl(uniquePath).data.publicUrl;
}