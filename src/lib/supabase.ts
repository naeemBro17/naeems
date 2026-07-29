import { createClient } from '@supabase/supabase-js';

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
 * Storage path for a newly uploaded product image. Random name so paths are
 * stable across SKU renames and multiple images never collide.
 */
export function newProductImagePath(): string {
  const id =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `products/${id}.webp`;
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