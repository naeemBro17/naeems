import type { CountWhy } from './types';

/* Batch 42 Part 3: plain helpers for the stock count (unit-tested). */

/** What was typed, as units: packs × pack size + loose units. Null when
 *  nothing (or something that is not a whole number ≥ 0) was typed. */
export function countedUnits(packs: string, loose: string, packSize: number): number | null {
  const bangla = '০১২৩৪৫৬৭৮৯';
  const clean = (s: string) =>
    s
      .trim()
      .replace(/[০-৯]/g, (d) => String(bangla.indexOf(d)))
      .replace(/[\s,]/g, '');
  const p = clean(packs);
  const l = clean(loose);
  if (p === '' && l === '') return null;
  if ((p !== '' && !/^\d+$/.test(p)) || (l !== '' && !/^\d+$/.test(l))) return null;
  const size = Math.max(1, Math.floor(packSize));
  return (p === '' ? 0 : Number(p)) * size + (l === '' ? 0 : Number(l));
}

/** "3 fewer → written off" / "2 more → added back" / "the same". */
export function differenceText(diff: number, unit: string): string {
  if (diff === 0) return 'the same as the system';
  if (diff < 0) return `${-diff} ${unit} fewer → written off (Count difference)`;
  return `${diff} ${unit} more → added back to the newest lot`;
}

const WHY: Record<CountWhy, string> = {
  never: 'Never counted',
  oldest: 'Longest since its last count',
  value: 'Expensive stock',
  fast: 'Sells fast',
};

export function countWhyText(why: CountWhy): string {
  return WHY[why] ?? why;
}

/** How many to count this month: every product with stock at least once in
 *  about 6 months — ceil(n ÷ 6), at least 15, at most 20, never more than n.
 *  (The database uses the same rule; this copy is for the screen and tests.) */
export function countTarget(productsWithStock: number): { target: number; rotation: number } {
  const rotation = Math.ceil(productsWithStock / 6);
  const target = Math.min(productsWithStock, Math.min(20, Math.max(15, rotation)));
  return { target, rotation: Math.min(rotation, target) };
}
