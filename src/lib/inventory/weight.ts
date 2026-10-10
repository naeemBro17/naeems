import { pow10, roundDiv } from './decimal';

/**
 * Batch 38: estimated packed weight from a size written in text — the same
 * rule as the database's inventory_estimate_weight() (migration-040; the
 * e2e test checks both agree):
 *   ml × 1.15 · l × 1000 × 1.15 · g × 1.10 · kg × 1000 × 1.10
 *   fl oz × 29.57 × 1.15 · oz × 28.35 × 1.10
 * Whole grams. null when there is no size ("needs weight").
 */
const SIZE_PATTERN =
  /(?:^|[^0-9a-z.])([0-9]+(?:\.[0-9]+)?)\s*(fl\.?\s*oz|millilitres?|milliliters?|ml|litres?|liters?|ltrs?|l|kgs?|grams?|gms?|g|oz)(?![a-z])/;

/** Each unit's factor as numerator / denominator (exact). */
const FACTORS: { units: readonly string[]; num: bigint; den: bigint }[] = [
  { units: ['floz'], num: 340055n, den: 10000n }, // 29.57 × 1.15
  { units: ['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters'], num: 115n, den: 100n },
  { units: ['l', 'litre', 'litres', 'liter', 'liters', 'ltr', 'ltrs'], num: 1150n, den: 1n },
  { units: ['g', 'gm', 'gms', 'gram', 'grams'], num: 110n, den: 100n },
  { units: ['kg', 'kgs'], num: 1100n, den: 1n },
  { units: ['oz'], num: 31185n, den: 1000n }, // 28.35 × 1.10
];

export const MAX_WEIGHT_GRAMS = 100000;

export function estimateWeightGrams(text: string | null | undefined): number | null {
  if (!text || text.trim() === '') return null;
  const match = SIZE_PATTERN.exec(text.toLowerCase());
  if (!match) return null;
  const [, amountText, unitText] = match;
  const unit = unitText.replace(/[\s.]/g, '');
  const factor = FACTORS.find((f) => f.units.includes(unit));
  if (!factor) return null;
  const [whole, fraction = ''] = amountText.split('.');
  const amount = BigInt(whole + fraction);
  const grams = Number(roundDiv(amount * factor.num, pow10(fraction.length) * factor.den));
  if (grams <= 0 || grams > MAX_WEIGHT_GRAMS) return null;
  return grams;
}

/** A product's estimate: its size field first, then its name. An option:
 *  its size, then its product's name. */
export function estimateForUnit(size: string | null | undefined, fallbackName: string | null | undefined): number | null {
  return estimateWeightGrams(size) ?? estimateWeightGrams(fallbackName);
}
