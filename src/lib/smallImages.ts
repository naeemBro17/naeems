import { supabase, STORAGE_BUCKET, LONG_CACHE_SECONDS } from './supabase';
import { resizeImageCircle } from './imageResize';
import { downloadForCopy, isCardCopy, isSmallCopy, makeSmallCopy, productImages, productNeedsCardCopies } from './productImages';
import type { Category, Product } from '../types';

/**
 * Batch 31 Part 8: small copies of every photo the shop shows small —
 * product cards, variant photos and the Browse circles (160 px). Cards and
 * circles use the small copy when there is one and the full photo
 * otherwise, so an image is never broken.
 *
 * Batch 40 — "Make images light" (Admin → Products): every product and
 * variant photo gets a 480 px card copy (card/ folder; the 400 px thumb/
 * copies of Batch 19–39 are replaced but stay in Storage until Naeem
 * confirms), then every stored photo is told to stay on phones for a year
 * (refreshStoredFiles).
 */

/** The photo for a Browse circle: its small copy, or the full photo. */
export function categoryCircleImage(category: Pick<Category, 'image_url' | 'image_url_thumb'>): string | null {
  if (!category.image_url) return null;
  return isSmallCopy(category.image_url, category.image_url_thumb) ? (category.image_url_thumb as string) : category.image_url;
}

/** PostgREST / Postgres "that column doesn't exist" (migration-034 not run). */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42703' || error.code === 'PGRST204' || /image_url_thumb/.test(error.message ?? '');
}

export type SaveSmallResult = 'saved' | 'failed' | 'not-ready';

/** Makes and saves a category photo's circle copy. */
export async function saveCategorySmallCopy(categoryId: string, imageUrl: string | null): Promise<SaveSmallResult> {
  const small = imageUrl ? await makeSmallCopy(imageUrl, resizeImageCircle, 'thumb') : null;
  const { error } = await supabase.from('categories').update({ image_url_thumb: small }).eq('id', categoryId);
  if (isMissingColumn(error)) return 'not-ready';
  if (error) return 'failed';
  return imageUrl && !small ? 'failed' : 'saved';
}

/** Makes and saves a variant photo's card copy. */
export async function saveVariantSmallCopy(variantId: string, imageUrl: string | null): Promise<SaveSmallResult> {
  const small = imageUrl ? await makeSmallCopy(imageUrl) : null;
  const { error } = await supabase.from('product_variants').update({ image_url_thumb: small }).eq('id', variantId);
  if (isMissingColumn(error)) return 'not-ready';
  if (error) return 'failed';
  return imageUrl && !small ? 'failed' : 'saved';
}

export interface SmallImagesWork {
  products: Product[];
  variants: { id: string; image_url: string }[];
  categories: { id: string; image_url: string }[];
  /** False before migration-034: variant and category copies can't be saved yet. */
  columnsReady: boolean;
}

/** Everything that still needs a small copy (photos already done are
 *  skipped): products and variants without a 480 px card copy, Browse
 *  circles without their small copy. */
export async function findSmallImagesWork(products: Product[], categories: Category[]): Promise<SmallImagesWork> {
  const needProducts = products.filter(productNeedsCardCopies);
  const { data, error } = await supabase
    .from('product_variants_view')
    .select('id, image_url, image_url_thumb')
    .not('image_url', 'is', null);
  const columnsReady = !isMissingColumn(error);
  const variants = columnsReady
    ? ((data ?? []) as { id: string; image_url: string; image_url_thumb: string | null }[])
        .filter((v) => !isCardCopy(v.image_url, v.image_url_thumb))
        .map((v) => ({ id: v.id, image_url: v.image_url }))
    : [];
  const needCategories = columnsReady
    ? categories
        .filter((c) => c.image_url && !isSmallCopy(c.image_url, c.image_url_thumb))
        .map((c) => ({ id: c.id, image_url: c.image_url as string }))
    : [];
  return { products: needProducts, variants, categories: needCategories, columnsReady };
}

export function workCount(work: SmallImagesWork): number {
  return work.products.length + work.variants.length + work.categories.length;
}

export interface SmallImagesSummary {
  made: number;
  failed: number;
}

/**
 * Makes every missing small copy, one item at a time (a phone on a slow
 * connection stays usable), reporting progress after each.
 */
export async function runSmallImages(
  work: SmallImagesWork,
  onProgress: (done: number, total: number) => void,
  onProductSaved: (productId: string, thumbs: string[]) => void
): Promise<SmallImagesSummary> {
  const total = workCount(work);
  let done = 0;
  let made = 0;
  let failed = 0;
  const step = () => onProgress(++done, total);
  onProgress(0, total);

  for (const product of work.products) {
    const full = productImages(product);
    const existing = product.image_urls_thumb ?? [];
    const thumbs: string[] = [];
    let ok = true;
    for (let i = 0; i < full.length; i += 1) {
      if (isCardCopy(full[i], existing[i])) {
        thumbs.push(existing[i]);
        continue;
      }
      const small = await makeSmallCopy(full[i]);
      if (!small) ok = false;
      // A failed copy keeps the older small copy (or the full photo).
      thumbs.push(small ?? (isSmallCopy(full[i], existing[i]) ? existing[i] : full[i]));
    }
    const { error } = await supabase.from('products').update({ image_urls_thumb: thumbs }).eq('id', product.id);
    if (error || !ok) failed += 1;
    else made += 1;
    if (!error) onProductSaved(product.id, thumbs);
    step();
  }
  for (const variant of work.variants) {
    if ((await saveVariantSmallCopy(variant.id, variant.image_url)) === 'saved') made += 1;
    else failed += 1;
    step();
  }
  for (const category of work.categories) {
    if ((await saveCategorySmallCopy(category.id, category.image_url)) === 'saved') made += 1;
    else failed += 1;
    step();
  }
  return { made, failed };
}

/* ---------- Long cache for the photos already stored (Batch 40) ---------- */

interface StoredFile {
  path: string;
  cacheControl: string | null;
  mimetype: string | null;
}

/** Every file in the photo bucket, with its cache setting. */
async function listStoredFiles(prefix = ''): Promise<StoredFile[]> {
  const files: StoredFile[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(prefix, { limit: 1000, offset });
    if (error || !data) break;
    for (const item of data) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) {
        files.push(...(await listStoredFiles(path)));
      } else {
        const meta = (item.metadata ?? {}) as { cacheControl?: string; mimetype?: string };
        files.push({ path, cacheControl: meta.cacheControl ?? null, mimetype: meta.mimetype ?? null });
      }
    }
    if (data.length < 1000) break;
  }
  return files;
}

const LONG_CACHE_HEADER = `max-age=${LONG_CACHE_SECONDS}`;

/** Stored photos still on the old one-hour cache setting. */
export async function findShortCacheFiles(): Promise<StoredFile[]> {
  return (await listStoredFiles()).filter((f) => f.cacheControl !== LONG_CACHE_HEADER);
}

/**
 * Stores each file again under the same name, with the same bytes, but with
 * the one-year cache setting — so phones and Supabase's CDN keep it instead
 * of asking again every hour. Nothing changes for the shop: same address,
 * same picture. One at a time; reports progress.
 */
export async function refreshStoredFiles(
  files: StoredFile[],
  onProgress: (done: number, total: number) => void
): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  onProgress(0, files.length);
  for (const [i, file] of files.entries()) {
    const publicUrl = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(file.path).data.publicUrl;
    const blob = await downloadForCopy(publicUrl);
    if (blob && blob.size > 0) {
      const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(file.path, blob, {
        upsert: true,
        contentType: file.mimetype ?? (blob.type || 'image/webp'),
        cacheControl: LONG_CACHE_SECONDS,
      });
      if (error) failed += 1;
      else done += 1;
    } else {
      failed += 1;
    }
    onProgress(i + 1, files.length);
  }
  return { done, failed };
}
