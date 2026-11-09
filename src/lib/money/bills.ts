import { supabase, LONG_CACHE_SECONDS, randomFileId } from '../supabase';
import { resizeBillPhoto } from '../imageResize';

/**
 * Batch 41 Part 2.3: a small bill photo for an expense. Made small in the
 * browser (WebP, under 150 KB), a new name every time and a one-year cache
 * (Batch 40 rules), in the private bucket money-bills (only "View profit &
 * costs" can look at it, through a short-lived link).
 */
export const BILLS_BUCKET = 'money-bills';

/** bills/2026-10/<random>.webp */
export function billPhotoPath(date: string): string {
  return `bills/${date.slice(0, 7)}/${randomFileId()}.webp`;
}

export async function uploadBillPhoto(file: Blob, date: string): Promise<{ path: string | null; error: string | null }> {
  let small: Blob;
  try {
    small = await resizeBillPhoto(file);
  } catch (err) {
    return { path: null, error: err instanceof Error ? err.message : 'Could not read the photo.' };
  }
  const path = billPhotoPath(date);
  const { error } = await supabase.storage
    .from(BILLS_BUCKET)
    .upload(path, small, { contentType: 'image/webp', cacheControl: LONG_CACHE_SECONDS, upsert: false });
  if (error) return { path: null, error: error.message || 'Could not upload the photo.' };
  return { path, error: null };
}
