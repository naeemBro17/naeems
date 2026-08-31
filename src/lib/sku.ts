import type { SupabaseClient } from '@supabase/supabase-js';

/** Digits in a generated SKU's sequence part: MO-001, MO-002, … */
const SEQUENCE_DIGITS = 3;

/** Prefix used when a product is saved without a category. */
const FALLBACK_PREFIX = 'XX';

/**
 * Category prefix for a SKU: the first two letters of the category name,
 * uppercased. Non-letters are dropped first so "Sun Block" → SU and
 * "3-Step Care" → ST.
 */
export function skuPrefix(categoryName: string | null): string {
  const letters = (categoryName ?? '').replace(/[^a-zA-Z]/g, '').toUpperCase();
  return letters.length >= 2 ? letters.slice(0, 2) : FALLBACK_PREFIX;
}

/**
 * The next free SKU for a category: prefix + zero-padded sequence, one above
 * the highest number already used with that prefix.
 *
 * Existing SKUs that don't match `PREFIX-digits` (hand-typed legacy values)
 * are ignored rather than blocking the sequence. Longer numbers are kept at
 * their own width, so an existing FC-0366 yields FC-0367 rather than wrapping.
 */
export async function nextSku(
  client: SupabaseClient,
  categoryName: string | null
): Promise<string> {
  const prefix = skuPrefix(categoryName);

  const { data, error } = await client
    .from('products')
    .select('sku')
    .like('sku', `${prefix}-%`);

  let highest = 0;
  let width = SEQUENCE_DIGITS;

  if (!error && data) {
    const pattern = new RegExp(`^${prefix}-(\\d+)$`);
    for (const row of data as { sku: string }[]) {
      const match = pattern.exec(row.sku);
      if (!match) continue;
      const value = Number.parseInt(match[1], 10);
      if (value > highest) {
        highest = value;
        width = Math.max(SEQUENCE_DIGITS, match[1].length);
      }
    }
  }

  return `${prefix}-${String(highest + 1).padStart(width, '0')}`;
}
