import { roundDiv, scaledText, toScaled } from './decimal';
import { MAX_WEIGHT_GRAMS } from './weight';
import type { StockUnit } from './types';

/**
 * Batch 38 Part 4: the opening stock file. The template has one row per
 * sellable product / option; Naeem fills buy price, pieces, expiry and
 * source. Everything here is checked in the browser for the preview —
 * nothing is saved until Confirm, and the database checks it all again
 * (inventory_confirm_opening, migration-040; units in migration-042).
 *
 * Batch 39: stock_unit and pack_size (grey, for reading only) and an
 * optional extra_units column were added at the END, so a template
 * downloaded before still uploads. Units = pieces × pack size +
 * extra_units (loose units from an opened pack). Buy price stays per pack.
 * The pack size used is always the shop's own (from the database).
 */
export const OPENING_COLUMNS = [
  'product_key',
  'sku',
  'product_name',
  'option/size',
  'weight_g',
  'source',
  'buy_price_bdt',
  'pieces',
  'expiry',
  'stock_unit',
  'pack_size',
  'extra_units',
] as const;

export type OpeningColumn = (typeof OPENING_COLUMNS)[number];

export const OPENING_SHEET_NAME = 'Opening stock';
export const HOW_TO_SHEET_NAME = 'How to fill';

export const HOW_TO_FILL: readonly string[] = [
  'How to fill the opening stock file',
  '',
  'Fill the sheet "Opening stock". One row is one product (or one size of a product).',
  '',
  '1. buy_price_bdt: what you paid for ONE piece (one full pack), in taka (the latest buy price).',
  '2. pieces: how many pieces you have now.',
  '3. expiry: the expiry month, written like 2027-03 (year-month). Leave it empty if there is none.',
  '4. source: "import" (you brought it from abroad) or "wholesale" (bought from a shop or wholesaler here). It is filled with "import" — change it where needed.',
  '5. weight_g: the weight of one piece in grams. It is already filled with an estimate from the size. Correct it if it is wrong.',
  '6. stock_unit and pack_size (grey): how the product is counted, e.g. a fish oil bottle of 400 pcs. Do not change them here — change the pack size in the product editor and download the template again.',
  '7. extra_units: only for an OPENED pack — the loose units left in it (e.g. 250 pcs left in an open bottle). Leave it empty otherwise. pieces counts the full packs.',
  '',
  'If one product has two expiry dates: copy the row, paste it below, and split the pieces between the two rows.',
  'Products you do not have: leave buy_price_bdt and pieces empty. Those rows are skipped.',
  '',
  'Do NOT change the product_key column (grey). It tells the shop which product the row is.',
  'Do not change the column names in the first row.',
  '',
  'Save the file as .xlsx and upload it on Admin → Inventory → Opening stock.',
];

/** product_key: the product id, or "<product id>:<option id>". */
export function unitKey(unit: Pick<StockUnit, 'product_id' | 'variant_id'>): string {
  return unit.variant_id ? `${unit.product_id}:${unit.variant_id}` : unit.product_id;
}

export type TemplateCell = string | number | null;

/** The template's data rows (after the header row). */
export function templateRows(units: readonly StockUnit[]): TemplateCell[][] {
  return units.map((u) => [
    unitKey(u),
    u.sku,
    u.product_name,
    u.option_label ?? '',
    u.weight_grams,
    'import',
    null,
    null,
    null,
    u.stock_unit,
    u.pack_size,
    null,
  ]);
}

/* ------------------------------------------------------------ reading */

export type OpeningSource = 'import' | 'wholesale';

/** One row ready to save (after merging duplicates). */
export interface OpeningRow {
  key: string;
  productId: string;
  variantId: string | null;
  label: string;
  source: OpeningSource;
  /** Buy price per piece (one full pack), 4 decimals (scaled). */
  priceE4: bigint;
  /** Full packs. */
  pieces: number;
  /** Loose units from an opened pack (Batch 39; default 0). */
  extraUnits?: number;
  /** Units in one pack (Batch 39; default 1). */
  packSize?: number;
  /** Last day of the expiry month, "YYYY-MM-DD", or null. */
  expiry: string | null;
  weightG: number | null;
  /** Spreadsheet row numbers this row came from. */
  fromRows: number[];
}

export type ProblemKind = 'missing' | 'unknown_key' | 'not_positive' | 'bad_value';
export type WarningKind = 'price_above_selling' | 'expired';

export interface OpeningIssue {
  /** Spreadsheet row number (the header is row 1). */
  row: number;
  label: string;
  message: string;
}

export interface OpeningPreview {
  rows: OpeningRow[];
  problems: Record<ProblemKind, OpeningIssue[]>;
  warnings: Record<WarningKind, OpeningIssue[]>;
  /** Rows that were the same product + expiry, merged into one. */
  merged: { label: string; expiry: string | null; rows: number[] }[];
  /** Rows with neither price nor pieces (products not in stock). */
  skipped: number;
  /** Rows read from the file (not counting the header or empty rows). */
  totalRows: number;
  problemCount: number;
}

export type SheetCell = string | number | boolean | Date | null | undefined;

function cellText(value: SheetCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function isBlank(value: SheetCell): boolean {
  return cellText(value) === '';
}

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "2027-03", "2027-3", "03/2027", "3-2027", "2027-03-15", an Excel date
 *  → last day of that month. undefined = not understood. */
export function parseExpiry(value: SheetCell): string | null | undefined {
  if (value === null || value === undefined || cellText(value) === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return lastDayOfMonth(value.getUTCFullYear(), value.getUTCMonth() + 1);
  }
  const text = cellText(value);
  let match = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(text);
  if (match) {
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? lastDayOfMonth(Number(match[1]), month) : undefined;
  }
  match = /^(\d{1,2})[-/.](\d{4})$/.exec(text);
  if (match) {
    const month = Number(match[1]);
    return month >= 1 && month <= 12 ? lastDayOfMonth(Number(match[2]), month) : undefined;
  }
  return undefined;
}

function unitLabel(unit: StockUnit): string {
  return unit.option_label ? `${unit.product_name} — ${unit.option_label}` : unit.product_name;
}

function emptyPreview(): OpeningPreview {
  return {
    rows: [],
    problems: { missing: [], unknown_key: [], not_positive: [], bad_value: [] },
    warnings: { price_above_selling: [], expired: [] },
    merged: [],
    skipped: 0,
    totalRows: 0,
    problemCount: 0,
  };
}

/** Finds the header row and which column is which. */
function findHeader(sheet: readonly SheetCell[][]): { headerRow: number; columns: Partial<Record<OpeningColumn, number>> } | null {
  for (let r = 0; r < Math.min(sheet.length, 20); r += 1) {
    const names = sheet[r].map((c) => cellText(c).toLowerCase());
    if (!names.includes('product_key')) continue;
    const columns: Partial<Record<OpeningColumn, number>> = {};
    for (const col of OPENING_COLUMNS) {
      const index = names.indexOf(col);
      if (index >= 0) columns[col] = index;
    }
    return { headerRow: r, columns };
  }
  return null;
}

export const MISSING_COLUMNS_ERROR =
  'This file is not the opening stock template (the column names in the first row were changed or are missing). Download the template again.';

/**
 * Checks every row of the uploaded sheet. `today` is "YYYY-MM-DD" (Dhaka).
 * Throws MISSING_COLUMNS_ERROR when the header is not the template's.
 */
export function readOpeningSheet(sheet: readonly SheetCell[][], units: readonly StockUnit[], today: string): OpeningPreview {
  const found = findHeader(sheet);
  const required: OpeningColumn[] = ['product_key', 'source', 'buy_price_bdt', 'pieces', 'expiry', 'weight_g'];
  if (!found || required.some((c) => found.columns[c] === undefined)) throw new Error(MISSING_COLUMNS_ERROR);
  const { headerRow, columns } = found;
  const at = (row: readonly SheetCell[], col: OpeningColumn): SheetCell => {
    const index = columns[col];
    return index === undefined ? null : row[index];
  };
  const byKey = new Map(units.map((u) => [unitKey(u), u]));
  const preview = emptyPreview();
  const accepted: OpeningRow[] = [];

  for (let r = headerRow + 1; r < sheet.length; r += 1) {
    const row = sheet[r];
    const rowNumber = r + 1;
    if (row.every((c) => isBlank(c))) continue;
    preview.totalRows += 1;
    const keyText = cellText(at(row, 'product_key'));
    const unit = byKey.get(keyText);
    const label = unit ? unitLabel(unit) : cellText(at(row, 'product_name')) || keyText || `Row ${rowNumber}`;
    const priceCell = at(row, 'buy_price_bdt');
    const piecesCell = at(row, 'pieces');
    const extraCell = at(row, 'extra_units');

    if (isBlank(priceCell) && isBlank(piecesCell) && isBlank(extraCell)) {
      preview.skipped += 1;
      continue;
    }
    if (!unit) {
      preview.problems.unknown_key.push({ row: rowNumber, label, message: keyText ? `Unknown product_key "${keyText}"` : 'product_key is empty' });
      continue;
    }
    let extra = 0n;
    if (!isBlank(extraCell)) {
      const parsedExtra = toScaled(typeof extraCell === 'number' ? extraCell : cellText(extraCell), 4);
      if (parsedExtra === null || parsedExtra < 0n || parsedExtra % 10000n !== 0n || parsedExtra / 10000n > 100_000_000n) {
        preview.problems.bad_value.push({ row: rowNumber, label, message: 'extra_units must be a whole number (0 or more)' });
        continue;
      }
      extra = parsedExtra / 10000n;
    }
    const filePack = at(row, 'pack_size');
    if (!isBlank(filePack) && Number(cellText(filePack)) !== unit.pack_size) {
      preview.problems.bad_value.push({
        row: rowNumber,
        label,
        message: `pack_size ${cellText(filePack)} is not the shop's pack size ${unit.pack_size} — download the template again`,
      });
      continue;
    }
    if (isBlank(priceCell) || (isBlank(piecesCell) && extra === 0n)) {
      preview.problems.missing.push({
        row: rowNumber,
        label,
        message: isBlank(priceCell) ? 'Buy price is missing' : 'Pieces are missing',
      });
      continue;
    }
    const price = toScaled(typeof priceCell === 'number' ? priceCell : cellText(priceCell), 4);
    const pieces = isBlank(piecesCell) ? 0n : toScaled(typeof piecesCell === 'number' ? piecesCell : cellText(piecesCell), 4);
    if (price === null || pieces === null) {
      preview.problems.bad_value.push({ row: rowNumber, label, message: price === null ? 'Buy price is not a number' : 'Pieces is not a number' });
      continue;
    }
    if (price <= 0n || pieces < 0n || (pieces === 0n && extra === 0n)) {
      preview.problems.not_positive.push({
        row: rowNumber,
        label,
        message: price <= 0n ? 'Buy price must be above 0' : 'Pieces must be above 0',
      });
      continue;
    }
    if (pieces % 10000n !== 0n || pieces / 10000n > 1_000_000n) {
      preview.problems.bad_value.push({ row: rowNumber, label, message: 'Pieces must be a whole number' });
      continue;
    }
    const sourceText = cellText(at(row, 'source')).toLowerCase();
    if (sourceText !== 'import' && sourceText !== 'wholesale') {
      preview.problems.bad_value.push({
        row: rowNumber,
        label,
        message: sourceText === '' ? 'Source is missing (import or wholesale)' : `Source "${sourceText}" must be import or wholesale`,
      });
      continue;
    }
    const expiry = parseExpiry(at(row, 'expiry'));
    if (expiry === undefined) {
      preview.problems.bad_value.push({ row: rowNumber, label, message: `Expiry "${cellText(at(row, 'expiry'))}" is not a month like 2027-03` });
      continue;
    }
    const weightCell = at(row, 'weight_g');
    let weightG: number | null = null;
    if (!isBlank(weightCell)) {
      const grams = toScaled(typeof weightCell === 'number' ? weightCell : cellText(weightCell), 2);
      if (grams === null || grams <= 0n || grams > BigInt(MAX_WEIGHT_GRAMS) * 100n) {
        preview.problems.bad_value.push({ row: rowNumber, label, message: 'weight_g must be grams between 1 and 100000' });
        continue;
      }
      weightG = Number(grams) / 100;
    }

    const piecesWhole = Number(pieces / 10000n);
    if (price > (toScaled(unit.selling_price, 4) ?? 0n)) {
      preview.warnings.price_above_selling.push({
        row: rowNumber,
        label,
        message: `Buy price ৳${Number(price) / 10000} is higher than the selling price ৳${unit.selling_price}`,
      });
    }
    if (expiry !== null && expiry < today) {
      preview.warnings.expired.push({ row: rowNumber, label, message: `Expiry ${expiry.slice(0, 7)} has already passed` });
    }
    accepted.push({
      key: unitKey(unit),
      productId: unit.product_id,
      variantId: unit.variant_id,
      label,
      source: sourceText,
      priceE4: price,
      pieces: piecesWhole,
      extraUnits: Number(extra),
      packSize: unit.pack_size,
      expiry,
      weightG,
      fromRows: [rowNumber],
    });
  }

  preview.rows = mergeDuplicates(accepted, preview.merged);
  preview.problemCount =
    preview.problems.missing.length +
    preview.problems.unknown_key.length +
    preview.problems.not_positive.length +
    preview.problems.bad_value.length;
  return preview;
}

/** Units of a row: full packs × pack size + loose units. */
export function openingUnits(row: Pick<OpeningRow, 'pieces' | 'extraUnits' | 'packSize'>): number {
  return row.pieces * (row.packSize ?? 1) + (row.extraUnits ?? 0);
}

/**
 * Rows with the same product + expiry (+ source) become one: pieces and
 * loose units added, buy price per pack = the average weighted by units
 * (4 decimals), the same as the database's merge in
 * inventory_confirm_opening().
 */
export function mergeDuplicates(rows: readonly OpeningRow[], log: OpeningPreview['merged'] = []): OpeningRow[] {
  const groups = new Map<string, OpeningRow[]>();
  for (const row of rows) {
    const id = `${row.key}|${row.expiry ?? ''}|${row.source}`;
    const list = groups.get(id);
    if (list) list.push(row);
    else groups.set(id, [row]);
  }
  const out: OpeningRow[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    const pieces = list.reduce((a, r) => a + r.pieces, 0);
    const extraUnits = list.reduce((a, r) => a + (r.extraUnits ?? 0), 0);
    const units = list.reduce((a, r) => a + openingUnits(r), 0);
    const value = list.reduce((a, r) => a + BigInt(openingUnits(r)) * r.priceE4, 0n);
    const weights = list.map((r) => r.weightG).filter((w): w is number => w !== null);
    const fromRows = list.flatMap((r) => r.fromRows);
    out.push({
      ...list[0],
      pieces,
      extraUnits,
      priceE4: roundDiv(value, BigInt(units)),
      weightG: weights.length > 0 ? Math.max(...weights) : null,
      fromRows,
    });
    log.push({ label: list[0].label, expiry: list[0].expiry, rows: fromRows });
  }
  return out;
}

/* ------------------------------------------------------- weight % maths */

/** The % to add for weight from past lots: (weight + other costs) ÷ buy
 *  price × 100, to 2 decimals. null until both are filled. */
export function weightPercentFromHistory(buyTotal: string, costsTotal: string): number | null {
  const buy = toScaled(buyTotal, 2);
  const costs = toScaled(costsTotal, 2);
  if (buy === null || costs === null || buy <= 0n || costs < 0n) return null;
  return Number(roundDiv(costs * 10000n, buy)) / 100;
}

type OpeningMoney = Pick<OpeningRow, 'source' | 'pieces' | 'priceE4' | 'extraUnits' | 'packSize'>;

/** The % added to one row, in paisa for the whole row (the database's
 *  round(units × price × % ÷ pack size)). 0 for wholesale. `percentE3` is
 *  the % at 3 decimals (38% → 38000n). */
export function openingAddedPaisa(row: OpeningMoney, percentE3: bigint): bigint {
  if (row.source !== 'import') return 0n;
  return roundDiv(BigInt(openingUnits(row)) * row.priceE4 * percentE3, BigInt(row.packSize ?? 1) * 10_000_000n);
}

/** Buy value of a row at 4 decimals: units × price per pack ÷ pack size. */
export function openingBuyE4(row: OpeningMoney): bigint {
  return roundDiv(BigInt(openingUnits(row)) * row.priceE4, BigInt(row.packSize ?? 1));
}

export interface OpeningTotals {
  /** Units (pieces when the pack size is 1). */
  pieces: number;
  buyPaisa: bigint;
  addedPaisa: bigint;
  /** Opening stock value = buy + weight added. */
  valuePaisa: bigint;
}

export function openingTotals(rows: readonly OpeningRow[], percentE3: bigint): OpeningTotals {
  let pieces = 0;
  let buyE4 = 0n;
  let added = 0n;
  for (const row of rows) {
    pieces += openingUnits(row);
    buyE4 += openingBuyE4(row);
    added += openingAddedPaisa(row, percentE3);
  }
  const buyPaisa = roundDiv(buyE4, 100n);
  return { pieces, buyPaisa, addedPaisa: added, valuePaisa: buyPaisa + added };
}

/** Landed cost per unit of one row, in taka (for showing). */
export function openingLandedUnit(row: OpeningMoney, percentE3: bigint): number {
  const units = openingUnits(row);
  return Number(openingBuyE4(row)) / 10000 / units + Number(openingAddedPaisa(row, percentE3)) / units / 100;
}

/** What Confirm sends (the database re-checks every value). */
export function confirmPayload(rows: readonly OpeningRow[]): Record<string, string | number | null>[] {
  return rows.map((r) => ({
    product_id: r.productId,
    variant_id: r.variantId,
    source: r.source,
    buy_price_bdt: scaledText(r.priceE4, 4),
    pieces: r.pieces,
    extra_units: r.extraUnits ?? 0,
    expiry: r.expiry,
    weight_g: r.weightG,
  }));
}
