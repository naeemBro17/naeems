import { supabase } from './supabase';
import { isMissingColumnError, VARIANT_SELECT, VARIANT_SELECT_B51, VARIANTS_VIEW } from './variants';
import type { ProductVariant } from '../types';

/**
 * Option rows from product_variants_view — every option, or one product's.
 * Batch 51: asks for keep_selling / in_hand too, and falls back to the
 * older column list until migration-052 has been run.
 */
export async function fetchVariantRows(productId: string | null): Promise<{ rows: ProductVariant[]; error: string | null }> {
  const run = async (columns: string) => {
    const query = supabase.from(VARIANTS_VIEW).select(columns);
    return productId === null ? query : query.eq('product_id', productId);
  };
  let { data, error } = await run(VARIANT_SELECT_B51);
  if (isMissingColumnError(error)) ({ data, error } = await run(VARIANT_SELECT));
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as unknown as ProductVariant[], error: null };
}
