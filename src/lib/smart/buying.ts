/* Batch 43 Part 2: the next-trip buying list. For each product usually
   bought from the chosen source:
     units = speed × (weeks until the stock arrives + months to keep it)
             − units left − units already on the way,
   rounded UP to whole packs. No sale in 120 days → "Skip — not moving". */
import type { ReportSheet } from '../reports/excel';
import type { BuyingRow, BuyingSupplier } from './types';
import { DAYS_PER_MONTH, amountText, salesSpeed, unitsText } from './speed';

export type BuyingSource = { kind: 'supplier'; id: string } | { kind: 'country'; name: string };

export interface BuyingSettings {
  /** The next stock arrives in about this many weeks. */
  weeks: number;
  /** Keep stock for this many months after it arrives. */
  months: number;
}

export const BUYING_DEFAULTS: BuyingSettings = { weeks: 6, months: 3 };

export interface BuyingLine {
  key: string;
  row: BuyingRow;
  perMonth: number;
  isNew: boolean;
  skip: boolean;
  /** Units the rule asks for before rounding (can be 0 or less). */
  need: number;
  /** The suggestion, in whole packs. */
  packs: number;
  /** Newest landed cost and buy price of one pack. */
  packCost: number;
  packBuy: number;
  note: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function lineKey(productId: string, variantId: string | null): string {
  return `${productId}:${variantId ?? ''}`;
}

/** Months of sales the order must cover. */
export function monthsCovered(settings: BuyingSettings): number {
  return (Math.max(settings.weeks, 0) * 7) / DAYS_PER_MONTH + Math.max(settings.months, 0);
}

export function rowsForSource(rows: readonly BuyingRow[], source: BuyingSource | null): BuyingRow[] {
  if (!source) return [];
  return rows.filter((r) => (source.kind === 'supplier' ? r.supplier_id === source.id : (r.country ?? '').toLowerCase() === source.name.toLowerCase()));
}

export function buyingLine(row: BuyingRow, settings: BuyingSettings): BuyingLine {
  const { perMonth, isNew } = salesSpeed(row.units_90, row.history_days);
  const pack = Math.max(row.pack_size, 1);
  const packCost = round2(row.last_unit_cost * pack);
  const packBuy = round2(row.last_buy_unit * pack);
  const skip = row.sold_120 <= 0;
  const covered = monthsCovered(settings);
  const need = perMonth * covered - row.units_left - row.units_on_way;
  const packs = skip || need <= 0 ? 0 : Math.ceil(need / pack - 1e-9);
  const unit = row.stock_unit;
  const stock = `${unitsText(row.units_left, unit)} left${row.units_on_way > 0 ? `, ${unitsText(row.units_on_way, unit)} on the way` : ''}`;
  let note: string;
  if (skip) note = `Skip — not moving (no sale in 120 days; ${stock})`;
  else if (packs === 0) note = `Enough stock: sells ${unitsText(perMonth, unit)} a month, ${stock}`;
  else
    note = `Sells ${unitsText(perMonth, unit)} a month${isNew ? ' (new)' : ''} × ${amountText(covered)} months = ${unitsText(
      perMonth * covered,
      unit
    )}; ${stock}`;
  return { key: lineKey(row.product_id, row.variant_id), row, perMonth, isNew, skip, need, packs, packCost, packBuy, note };
}

export function buyingLines(rows: readonly BuyingRow[], source: BuyingSource | null, settings: BuyingSettings): BuyingLine[] {
  return rowsForSource(rows, source)
    .map((r) => buyingLine(r, settings))
    .sort((a, b) => Number(a.skip) - Number(b.skip) || b.packs - a.packs || a.row.label.localeCompare(b.row.label));
}

/** The packs to buy: the number typed over the suggestion, when there is one. */
export function packsFor(line: BuyingLine, typed: ReadonlyMap<string, number>): number {
  const n = typed.get(line.key);
  return n === undefined ? line.packs : Math.max(0, Math.floor(n));
}

export function lineMoney(line: BuyingLine, packs: number): number {
  return round2(packs * line.packCost);
}

/** The estimated money needed (newest landed cost × packs). */
export function buyingTotal(lines: readonly BuyingLine[], typed: ReadonlyMap<string, number>): number {
  return round2(lines.reduce((s, l) => s + lineMoney(l, packsFor(l, typed)), 0));
}

export function sourceName(source: BuyingSource | null, suppliers: readonly BuyingSupplier[]): string {
  if (!source) return '';
  if (source.kind === 'country') return source.name;
  return suppliers.find((s) => s.id === source.id)?.name ?? 'Supplier';
}

/** The Excel sheet to carry on the trip (only rows with packs to buy). */
export function buyingSheet(
  lines: readonly BuyingLine[],
  typed: ReadonlyMap<string, number>,
  source: string,
  settings: BuyingSettings,
  today: string
): ReportSheet {
  const rows = lines.filter((l) => packsFor(l, typed) > 0);
  return {
    name: 'Buying list',
    title: [
      `NAEEM'S — buying list: ${source}`,
      `Made ${today}. Stock arrives in about ${settings.weeks} weeks, kept for ${settings.months} months after.`,
    ],
    columns: [
      { header: 'Product', kind: 'text', width: 40 },
      { header: 'Packs', kind: 'number', width: 8 },
      { header: 'Units', kind: 'number', width: 9 },
      { header: 'Last buy price (pack)', kind: 'money', width: 16 },
      { header: 'Landed cost (pack)', kind: 'money', width: 16 },
      { header: 'Money needed', kind: 'money', width: 16 },
      { header: 'Notes', kind: 'text', width: 60 },
    ],
    rows: rows.map((l) => {
      const packs = packsFor(l, typed);
      return [l.row.label, packs, packs * Math.max(l.row.pack_size, 1), l.packBuy, l.packCost, lineMoney(l, packs), packs !== l.packs ? `Changed from ${l.packs}. ${l.note}` : l.note];
    }),
    total: ['Total', rows.reduce((s, l) => s + packsFor(l, typed), 0), null, null, null, buyingTotal(rows, typed), null],
  };
}
