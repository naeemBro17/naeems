import { supabase } from './supabase';
import { resizeImageCircle } from './imageResize';
import { isSmallCopy, makeSmallCopy, productImages, productNeedsSmallCopies } from './productImages';
import type { Category, Product } from '../types';

/**
 * Batch 31 Part 8: small copies of every photo the shop shows small —
 * product cards (400 px), variant photos (400 px) and the Browse circles
 * (160 px). Cards and circles use the small copy when there is one and the
 * full photo otherwise, so an image is never broken.
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
  const small = imageUrl ? await makeSmallCopy(imageUrl, resizeImageCircle) : null;
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

/** Everything that still needs a small copy (photos already done are skipped). */
export async function findSmallImagesWork(products: Product[], categories: Category[]): Promise<SmallImagesWork> {
  const needProducts = products.filter(productNeedsSmallCopies);
  const { data, error } = await supabase
    .from('product_variants_view')
    .select('id, image_url, image_url_thumb')
    .not('image_url', 'is', null);
  const columnsReady = !isMissingColumn(error);
  const variants = columnsReady
    ? ((data ?? []) as { id: string; image_url: string; image_url_thumb: string | null }[])
        .filter((v) => !isSmallCopy(v.image_url, v.image_url_thumb))
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
      if (isSmallCopy(full[i], existing[i])) {
        thumbs.push(existing[i]);
        continue;
      }
      const small = await makeSmallCopy(full[i]);
      if (!small) ok = false;
      thumbs.push(small ?? full[i]);
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
