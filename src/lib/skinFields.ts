/**
 * Product tags stored in products.skin_types (text[]). Batch 72: exactly
 * the four skin types; "Sensitive" is now a concern and "All Skin Types"
 * means all four (migration-064 moves old data). Concerns live in
 * lib/concerns.ts.
 */
export const SKIN_TYPES = ['Normal', 'Oily', 'Combination', 'Dry'] as const;

/** Keep only values the app recognises, so a hand-edited row can't leak junk. */
export function sanitizeSkinValues(
  values: readonly string[] | null | undefined,
  allowed: readonly string[]
): string[] {
  if (!values) return [];
  return values.filter((v) => allowed.includes(v));
}
