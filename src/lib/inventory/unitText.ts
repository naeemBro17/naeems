import type { StockUnitWord } from './types';

// Batch 62: how loose units are written on the admin screens.

const count = (n: number) => n.toLocaleString('en-US');

/** "bottle" / "bottles" (Naeem's packs are bottles). */
export function packWord(n: number): string {
  return n === 1 ? 'bottle' : 'bottles';
}

/**
 * New lot's total line: the units of every row, per stock unit word, in
 * the order the words first appear: "100 ml", "2 pcs, 300 ml". Nothing
 * entered yet: "0 pcs".
 */
export function lotTotalText(rows: readonly { units: number; unit: StockUnitWord }[]): string {
  const totals = new Map<StockUnitWord, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.units) || row.units <= 0) continue;
    totals.set(row.unit, (totals.get(row.unit) ?? 0) + row.units);
  }
  if (totals.size === 0) return '0 pcs';
  return [...totals].map(([unit, n]) => `${count(n)} ${unit}`).join(', ');
}

/**
 * Admin New order / Edit order: the stock of a product sold in packs of
 * more than one unit. Whole packs, then every unit in brackets:
 * "Stock: 1 bottle (473 ml)", "Stock: 4 bottles (1,600 tab)"; part of a
 * pack: "Stock: 0 bottles + 300 ml" (and "1 bottle + 300 ml (773 ml)").
 * Null for a pack of one unit (the screens show stock as before).
 */
export function packStockText(units: number, packSize: number, unit: StockUnitWord): string | null {
  if (!Number.isFinite(packSize) || packSize <= 1) return null;
  const all = Math.max(0, Math.floor(units));
  const packs = Math.floor(all / packSize);
  const rest = all - packs * packSize;
  if (rest === 0) return `Stock: ${count(packs)} ${packWord(packs)} (${count(all)} ${unit})`;
  const base = `Stock: ${count(packs)} ${packWord(packs)} + ${count(rest)} ${unit}`;
  return packs > 0 ? `${base} (${count(all)} ${unit})` : base;
}

/** The Edit product Stock card in Inventory mode On: "2 bottles in lots
 *  (946 ml)"; a pack of one: "5 bottles in lots". */
export function lotsStockText(units: number, packSize: number, unit: StockUnitWord): { packs: number; text: string } {
  const pack = Math.max(1, Math.floor(packSize) || 1);
  const all = Math.max(0, Math.floor(units));
  const packs = Math.floor(all / pack);
  const tail = pack > 1 ? ` (${count(all)} ${unit})` : '';
  return { packs, text: `${packWord(packs)} in lots${tail}` };
}
