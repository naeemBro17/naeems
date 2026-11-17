import { supabase, LONG_CACHE_SECONDS, randomFileId } from '../supabase';
import { resizeReceiptPhoto } from '../imageResize';
import type { LotReceipt } from './types';

/**
 * Batch 45 Part 12: receipt photos / PDFs of a lot, in the private bucket
 * lot-receipts (only "View profit & costs" can read them). A photo is made
 * small in the browser first; a PDF may be up to 5 MB. The lot screen lists
 * only names and dates; a file is downloaded only when it is tapped,
 * through a short-lived link.
 */
export const RECEIPTS_BUCKET = 'lot-receipts';
export const RECEIPT_PDF_MAX_BYTES = 5 * 1024 * 1024;

const RECEIPT_COLUMNS = 'id, lot_id, path, file_name, mime, size_bytes, created_at';

export async function fetchReceipts(lotId: string): Promise<LotReceipt[] | null> {
  const { data, error } = await supabase.from('lot_receipts').select(RECEIPT_COLUMNS).eq('lot_id', lotId).order('created_at');
  if (error) return null;
  return (data ?? []) as LotReceipt[];
}

/** "receipt.jpg" → "receipt.webp" (a photo is stored as WebP). */
export function receiptFileName(name: string, mime: LotReceipt['mime']): string {
  const base = (name.trim() || 'receipt').replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 180);
  return `${base}.${mime === 'application/pdf' ? 'pdf' : 'webp'}`;
}

export async function uploadReceipt(lotId: string, file: File): Promise<{ receipt: LotReceipt | null; error: string | null }> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  let body: Blob;
  let mime: LotReceipt['mime'];
  if (isPdf) {
    if (file.size > RECEIPT_PDF_MAX_BYTES) return { receipt: null, error: 'A PDF can be up to 5 MB.' };
    body = file;
    mime = 'application/pdf';
  } else if (file.type.startsWith('image/')) {
    try {
      body = await resizeReceiptPhoto(file);
    } catch (err) {
      return { receipt: null, error: err instanceof Error ? err.message : 'Could not read the photo.' };
    }
    mime = 'image/webp';
  } else {
    return { receipt: null, error: 'Pick a photo or a PDF.' };
  }
  const path = `${lotId}/${randomFileId()}.${mime === 'application/pdf' ? 'pdf' : 'webp'}`;
  const uploaded = await supabase.storage
    .from(RECEIPTS_BUCKET)
    .upload(path, body, { contentType: mime, cacheControl: LONG_CACHE_SECONDS, upsert: false });
  if (uploaded.error) return { receipt: null, error: uploaded.error.message || 'Could not upload the file.' };
  const { data, error } = await supabase
    .from('lot_receipts')
    .insert({ lot_id: lotId, path, file_name: receiptFileName(file.name, mime), mime, size_bytes: body.size })
    .select(RECEIPT_COLUMNS)
    .single();
  if (error || !data) {
    await supabase.storage.from(RECEIPTS_BUCKET).remove([path]);
    return { receipt: null, error: error?.message || 'Could not save the receipt.' };
  }
  return { receipt: data as LotReceipt, error: null };
}

export async function deleteReceipt(receipt: Pick<LotReceipt, 'id' | 'path'>): Promise<string | null> {
  const removed = await supabase.storage.from(RECEIPTS_BUCKET).remove([receipt.path]);
  if (removed.error) return removed.error.message || 'Could not delete the file.';
  const { error } = await supabase.from('lot_receipts').delete().eq('id', receipt.id);
  return error ? error.message || 'Could not delete the receipt.' : null;
}

/** A link that works for 10 minutes; nothing is downloaded until it is opened. */
export async function receiptUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from(RECEIPTS_BUCKET).createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}
