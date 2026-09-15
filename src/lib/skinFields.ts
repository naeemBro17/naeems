/**
 * Admin-only product tags stored in products.skin_types and
 * products.skin_conditions (text[]). They power a future smart filter and
 * are deliberately absent from every customer-facing surface.
 */
export const SKIN_TYPES = [
  'Oily',
  'Dry',
  'Combination',
  'Sensitive',
  'Normal',
  'All Skin Types',
] as const;

export const SKIN_CONDITIONS = [
  'Acne',
  'Dark Spots',
  'Hyperpigmentation',
  'Anti-Aging',
  'Brightening',
  'Hydration',
  'Redness',
  'Uneven Texture',
] as const;

/** Keep only values the app recognises, so a hand-edited row can't leak junk. */
export function sanitizeSkinValues(
  values: readonly string[] | null | undefined,
  allowed: readonly string[]
): string[] {
  if (!values) return [];
  return values.filter((v) => allowed.includes(v));
}
