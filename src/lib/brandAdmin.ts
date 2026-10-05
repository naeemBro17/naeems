import { supabase } from './supabase';
import { resizeImage } from './imageResize';
import { trimLogo } from './logoTrim';
import { BRANDS_TABLE, BRAND_SELECT } from './brands';
import { videoPosterUrl } from './brandVideo';
import type { Brand } from '../types';

/* Admin-only brand writes and the Batch 26 admin extras (Restock, 7-day
   sales, customer notes). Every one of these is checked again inside the
   database (migration-032), so hiding a button is only tidiness. */

export const BRAND_MEDIA_BUCKET = 'brand-media';
export const BRAND_VIDEO_MAX_BYTES = 15 * 1024 * 1024;
export const BRAND_VIDEO_TYPES = ['video/mp4', 'video/webm'];
export const BRAND_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const BRAND_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Postgres "foreign key" refusal: the brand still has products. */
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

export async function fetchAllBrands(): Promise<{ brands: Brand[]; error: string | null }> {
  const { data, error } = await supabase.from(BRANDS_TABLE).select(BRAND_SELECT).order('display_order').order('name');
  if (error) {
    console.error('brands failed:', error.message);
    return { brands: [], error: 'Could not load brands.' };
  }
  return { brands: (data ?? []) as Brand[], error: null };
}

function randomId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function uploadMedia(path: string, blob: Blob, contentType: string): Promise<string> {
  const { error } = await supabase.storage
    .from(BRAND_MEDIA_BUCKET)
    .upload(path, blob, { contentType, upsert: true, cacheControl: '31536000' });
  if (error) throw error;
  return supabase.storage.from(BRAND_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
}

export type MediaKind = 'logo' | 'logo-dark' | 'banner' | 'video';

/** Videos above this load slowly on a phone (Batch 29 Part 6). */
export const BRAND_VIDEO_WARN_BYTES = 4 * 1024 * 1024;

/** "5.1 MB" */
export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A gentle note after a video upload: its size, and a warning when it's
 *  big enough to make the brand page slow. */
export function videoSizeNote(bytes: number): { text: string; warn: boolean } {
  if (bytes > BRAND_VIDEO_WARN_BYTES) {
    return {
      text: `This video is ${megabytes(bytes)}. Over 4 MB loads slowly on phones — a shorter clip (5–10 seconds) or 720p, without sound, loads much faster.`,
      warn: true,
    };
  }
  return { text: `Video size: ${megabytes(bytes)} — good for phones.`, warn: false };
}

/* ---------- Video preview pictures (Batch 29 Part 6) ---------- */

/** Widest preview picture saved. */
const POSTER_MAX_WIDTH = 1280;
/** The frame used: just after the start (the very first frame is often black). */
const POSTER_TIME_S = 0.1;
const POSTER_TIMEOUT_MS = 30000;

/**
 * One still frame of a video as a compressed JPEG — the picture the brand
 * page shows while its video loads. `remote` = a video already in Storage
 * (read with CORS so the frame can be copied).
 */
export function captureVideoFrame(src: string, remote: boolean): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let done = false;
    const finish = (error: Error | null, blob?: Blob) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      if (error || !blob) reject(error ?? new Error('No frame.'));
      else resolve(blob);
    };
    const timer = window.setTimeout(() => finish(new Error('The video took too long to read.')), POSTER_TIMEOUT_MS);
    if (remote) video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onerror = () => finish(new Error('Could not read the video.'));
    video.onloadeddata = () => {
      video.currentTime = Math.min(POSTER_TIME_S, Math.max(0, video.duration - 0.05) || 0);
    };
    video.onseeked = () => {
      const scale = Math.min(1, POSTER_MAX_WIDTH / (video.videoWidth || POSTER_MAX_WIDTH));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        finish(new Error('Canvas is not supported in this browser.'));
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        canvas.toBlob((blob) => finish(blob ? null : new Error('Could not save the frame.'), blob ?? undefined), 'image/jpeg', 0.8);
      } catch (err) {
        finish(err instanceof Error ? err : new Error('Could not save the frame.'));
      }
    };
    video.src = src;
  });
}

/** A brand-media public URL's path inside the bucket ("videos/x.mp4"). */
function brandMediaPath(url: string): string | null {
  const marker = `/object/public/${BRAND_MEDIA_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return null;
  const path = decodeURIComponent(url.slice(index + marker.length).split('?')[0]);
  return path === '' ? null : path;
}

async function uploadPoster(videoPath: string, frame: Blob): Promise<void> {
  await uploadMedia(`${videoPath}.poster.jpg`, frame, 'image/jpeg');
}

/** Whether a video already has its preview picture in Storage. */
async function hasPoster(videoUrl: string): Promise<boolean> {
  try {
    const res = await fetch(videoPosterUrl(videoUrl), { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

export interface PosterRunResult {
  made: number;
  alreadyHad: number;
  failed: string[];
}

/**
 * Admin → Brands → "Create missing video previews": for every brand with an
 * uploaded video but no preview picture yet, saves one (Naeem taps it once
 * for the videos uploaded before Batch 29). Never touches the database.
 */
export async function createMissingVideoPosters(
  brands: Pick<Brand, 'name' | 'banner_video_url'>[],
  onProgress: (done: number, total: number) => void
): Promise<PosterRunResult> {
  const withVideo = brands.filter((b): b is typeof b & { banner_video_url: string } => b.banner_video_url !== null);
  const result: PosterRunResult = { made: 0, alreadyHad: 0, failed: [] };
  onProgress(0, withVideo.length);
  for (const [i, brand] of withVideo.entries()) {
    const path = brandMediaPath(brand.banner_video_url);
    if (!path) {
      result.failed.push(brand.name);
    } else if (await hasPoster(brand.banner_video_url)) {
      result.alreadyHad += 1;
    } else {
      try {
        await uploadPoster(path, await captureVideoFrame(brand.banner_video_url, true));
        result.made += 1;
      } catch (err) {
        console.error(`Video preview failed for ${brand.name}:`, err);
        result.failed.push(brand.name);
      }
    }
    onProgress(i + 1, withVideo.length);
  }
  return result;
}

/** Checks a chosen file before any work is done. Null = fine. */
export function checkMediaFile(kind: MediaKind, file: File): string | null {
  if (kind === 'video') {
    if (!BRAND_VIDEO_TYPES.includes(file.type)) return 'Choose an MP4 video (WebM also works).';
    if (file.size > BRAND_VIDEO_MAX_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      return `This video is ${mb} MB. The limit is 15 MB — use a shorter clip (5–20 seconds) or a smaller size.`;
    }
    return null;
  }
  if (!BRAND_IMAGE_TYPES.includes(file.type)) return 'Choose a PNG, JPG or WebP image.';
  if (file.size > BRAND_IMAGE_MAX_BYTES) return 'This image is over 10 MB. Choose a smaller one.';
  return null;
}

/**
 * Prepares and uploads one file; returns its public URL. Logos are trimmed,
 * resized and compressed (transparent WebP); banners are compressed like
 * product photos; videos go up as they are (re-encoding a video reliably on
 * a phone isn't possible without a ~30 MB tool — the admin shows the size
 * and warns above 4 MB instead), plus a preview picture of the first frame. Every upload gets a new file
 * name, so a replaced logo never shows an old cached copy.
 */
export async function uploadBrandMedia(kind: MediaKind, file: File): Promise<string> {
  const id = randomId();
  if (kind === 'video') {
    const ext = file.type === 'video/webm' ? 'webm' : 'mp4';
    const path = `videos/${id}.${ext}`;
    const url = await uploadMedia(path, file, file.type);
    // Its preview picture, saved next to it (Part 6). A video whose frame
    // can't be read still uploads fine — the brand page then shows the
    // banner image or the logo while it loads.
    const local = URL.createObjectURL(file);
    try {
      await uploadPoster(path, await captureVideoFrame(local, false));
    } catch (err) {
      console.error('Video preview picture failed:', err);
    } finally {
      URL.revokeObjectURL(local);
    }
    return url;
  }
  if (kind === 'banner') {
    return uploadMedia(`banners/${id}.webp`, await resizeImage(file), 'image/webp');
  }
  return uploadMedia(`logos/${id}.webp`, await trimLogo(file), 'image/webp');
}

export type BrandInput = Pick<
  Brand,
  'name' | 'slug' | 'logo_url' | 'logo_dark_url' | 'banner_image_url' | 'banner_video_url' | 'banner_youtube_url' | 'show_on_home'
>;

function friendlyBrandError(error: { code?: string; message: string }): string {
  if (error.code === UNIQUE_VIOLATION) {
    return error.message.includes('slug')
      ? 'Another brand already uses this link. Change the link.'
      : 'A brand with this name already exists.';
  }
  if (error.code === '42501' || /row-level security|not authorized/i.test(error.message)) {
    return 'You are not allowed to change brands.';
  }
  return 'Could not save the brand. Please try again.';
}

export async function saveBrand(id: string | null, input: BrandInput, nextOrder: number): Promise<{ brand: Brand | null; error: string | null }> {
  const query = id
    ? supabase.from(BRANDS_TABLE).update(input).eq('id', id).select(BRAND_SELECT).single()
    : supabase.from(BRANDS_TABLE).insert({ ...input, display_order: nextOrder }).select(BRAND_SELECT).single();
  const { data, error } = await query;
  if (error) {
    console.error('brand save failed:', error.message);
    return { brand: null, error: friendlyBrandError(error) };
  }
  return { brand: data as Brand, error: null };
}

export async function setBrandOnHome(id: string, on: boolean): Promise<string | null> {
  const { data, error } = await supabase.from(BRANDS_TABLE).update({ show_on_home: on }).eq('id', id).select('id');
  if (error || !data || data.length === 0) return 'Could not change "Show on home".';
  return null;
}

export const MOVE_PRODUCTS_FIRST = 'Move its products to another brand first.';

export async function deleteBrand(id: string): Promise<string | null> {
  const { data, error } = await supabase.from(BRANDS_TABLE).delete().eq('id', id).select('id');
  if (error) {
    if (error.code === FK_VIOLATION) return MOVE_PRODUCTS_FIRST;
    return friendlyBrandError(error);
  }
  if (!data || data.length === 0) return 'You are not allowed to change brands.';
  return null;
}

export async function reorderBrands(ids: string[]): Promise<string | null> {
  const { error } = await supabase.rpc('admin_brands_reorder', { p_ids: ids });
  return error ? 'Could not save the new order.' : null;
}

/* ---------- Restock ---------- */

export type RestockMode = 'add' | 'set';

export async function restock(
  productId: string,
  variantId: string | null,
  mode: RestockMode,
  amount: number
): Promise<{ before: number | null; after: number } | { error: string }> {
  const { data, error } = await supabase.rpc('admin_restock', {
    p_product_id: productId,
    p_variant_id: variantId,
    p_mode: mode,
    p_amount: amount,
  });
  if (error) {
    if (/not authorized/i.test(error.message)) return { error: 'You are not allowed to change stock.' };
    if (/whole number/i.test(error.message)) return { error: 'Enter a whole number of 0 or more.' };
    return { error: 'Could not save the stock. Please try again.' };
  }
  const result = data as { before: number | null; after: number };
  return { before: result.before, after: Number(result.after) };
}

/* ---------- 7-day sales ---------- */

export interface SalesDay {
  /** YYYY-MM-DD, Bangladesh date. */
  day: string;
  total: number;
  orderCount: number;
}

/** Null when this person may not see sales (the database refuses). */
export async function fetchSales7d(): Promise<SalesDay[] | null> {
  const { data, error } = await supabase.rpc('admin_sales_7d');
  if (error) return null;
  return ((data ?? []) as { day: string; total: number | string; order_count: number | string }[]).map((r) => ({
    day: r.day,
    total: Number(r.total),
    orderCount: Number(r.order_count),
  }));
}

/* ---------- Customer notes and tags ---------- */

export interface CustomerNote {
  note: string;
  tags: string[];
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Every customer's note row this person may read (needs "View customers"). */
export async function fetchCustomerNotes(): Promise<Map<string, CustomerNote>> {
  const map = new Map<string, CustomerNote>();
  const { data, error } = await supabase.from('customer_notes').select('customer_id, note, tags, updated_by, updated_at');
  if (error) return map;
  for (const row of (data ?? []) as { customer_id: string; note: string; tags: string[]; updated_by: string | null; updated_at: string }[]) {
    map.set(row.customer_id, { note: row.note, tags: row.tags ?? [], updatedBy: row.updated_by, updatedAt: row.updated_at });
  }
  return map;
}

export async function saveCustomerNote(
  customerId: string,
  note: string,
  tags: string[]
): Promise<{ note: string; tags: string[] } | { error: string }> {
  const { data, error } = await supabase.rpc('admin_set_customer_note', {
    p_customer_id: customerId,
    p_note: note,
    p_tags: tags,
  });
  if (error) {
    if (/not authorized/i.test(error.message)) return { error: 'You are not allowed to edit customer notes.' };
    if (/too long|at most/i.test(error.message)) return { error: error.message };
    return { error: 'Could not save. Please try again.' };
  }
  const result = data as { note: string; tags: string[] };
  return { note: result.note, tags: result.tags ?? [] };
}

/** Every tag already used, most used first — "pick one already used". */
export function knownTags(notes: Map<string, CustomerNote>): string[] {
  const counts = new Map<string, number>();
  for (const n of notes.values()) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

export interface SalesBar {
  day: string;
  /** "Mon", "Tue", ... */
  weekday: string;
  /** "29 Sep" */
  date: string;
  total: number;
  orderCount: number;
  /** 0–100, relative to the best day (all-zero weeks are all 0). */
  heightPct: number;
  isToday: boolean;
}

/** The chart's bars: the last day is today (the database sends 7 days,
 *  oldest first, in Bangladesh time). */
export function salesBars(days: SalesDay[]): SalesBar[] {
  const max = Math.max(0, ...days.map((d) => d.total));
  return days.map((d, i) => {
    const at = new Date(`${d.day}T00:00:00Z`);
    return {
      day: d.day,
      weekday: at.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      date: at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      total: d.total,
      orderCount: d.orderCount,
      heightPct: max > 0 ? Math.round((d.total / max) * 100) : 0,
      isToday: i === days.length - 1,
    };
  });
}
