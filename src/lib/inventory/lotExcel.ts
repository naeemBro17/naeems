import { parseExpiry, type SheetCell } from './opening';
import type { StockUnit } from './types';

/**
 * Batch 45 Part 12: add lot rows from Excel. The template has one row per
 * product / option (SKU and name filled in) and empty Qty, Buying price and
 * Expiry columns. Rows with an empty Qty are skipped. Matched rows go into
 * the lot form as normal rows (nothing is saved until Save lot); rows that
 * can't be used are listed with the reason — never dropped silently.
 * Matching: SKU first (an SKU shared by a product's options also needs the
 * name), then the exact name.
 */
export const LOT_COLUMNS = ['SKU', 'Product', 'Qty', 'Buying price', 'Expiry (MM/YYYY)'] as const;
export const LOT_SHEET_NAME = 'Lot';

export interface LotImportRow {
  unit: StockUnit;
  qty: number;
  /** As written ("" = not filled in). */
  price: string;
  /** "YYYY-MM" or "". */
  expiry: string;
}

export interface LotImportProblem {
  /** Row number in the sheet (1 = the first row). */
  row: number;
  name: string;
  reason: string;
}

export interface LotImportResult {
  rows: LotImportRow[];
  problems: LotImportProblem[];
}

function text(value: SheetCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function lotUnitName(unit: Pick<StockUnit, 'product_name' | 'option_label'>): string {
  return unit.option_label ? `${unit.product_name} — ${unit.option_label}` : unit.product_name;
}

/** The template's rows: one per active product / option. */
export function lotTemplateRows(units: readonly StockUnit[]): string[][] {
  return units.filter((u) => u.is_active).map((u) => [u.sku ?? '', lotUnitName(u), '', '', '']);
}

function findColumns(sheet: readonly SheetCell[][]): { header: number; col: Record<'sku' | 'name' | 'qty' | 'price' | 'expiry', number> } | null {
  for (let r = 0; r < Math.min(sheet.length, 20); r += 1) {
    const names = (sheet[r] ?? []).map((c) => norm(text(c)));
    const qty = names.findIndex((n) => n === 'qty' || n === 'quantity');
    if (qty < 0) continue;
    const find = (test: (n: string) => boolean) => names.findIndex(test);
    return {
      header: r,
      col: {
        sku: find((n) => n === 'sku'),
        name: find((n) => n === 'product' || n === 'name' || n === 'product name'),
        qty,
        price: find((n) => n.startsWith('buying price') || n.startsWith('buy price') || n === 'price'),
        expiry: find((n) => n.startsWith('expiry')),
      },
    };
  }
  return null;
}

export const LOT_FILE_ERROR =
  'This file has no "Qty" column. Download the template, fill in Qty, Buying price and Expiry, and upload it again.';

/** Reads the sheet's cells against the shop's products. */
export function parseLotSheet(sheet: readonly SheetCell[][], units: readonly StockUnit[]): LotImportResult {
  const found = findColumns(sheet);
  if (!found) throw new Error(LOT_FILE_ERROR);
  const { header, col } = found;
  const bySku = new Map<string, StockUnit[]>();
  const byName = new Map<string, StockUnit[]>();
  for (const u of units) {
    const sku = norm(u.sku ?? '');
    if (sku) bySku.set(sku, [...(bySku.get(sku) ?? []), u]);
    const name = norm(lotUnitName(u));
    byName.set(name, [...(byName.get(name) ?? []), u]);
  }

  const rows: LotImportRow[] = [];
  const problems: LotImportProblem[] = [];
  for (let r = header + 1; r < sheet.length; r += 1) {
    const cells = sheet[r] ?? [];
    const cell = (i: number) => (i >= 0 ? cells[i] : undefined);
    const qtyText = text(cell(col.qty));
    if (qtyText === '') continue;
    const sku = norm(text(cell(col.sku)));
    const nameText = text(cell(col.name));
    const name = norm(nameText);
    const label = nameText || text(cell(col.sku)) || `Row ${r + 1}`;
    const problem = (reason: string) => problems.push({ row: r + 1, name: label, reason });

    let unit: StockUnit | undefined;
    const skuMatches = sku ? bySku.get(sku) ?? [] : [];
    if (skuMatches.length === 1) unit = skuMatches[0];
    else if (skuMatches.length > 1) unit = skuMatches.find((u) => norm(lotUnitName(u)) === name);
    if (!unit) {
      const nameMatches = name ? byName.get(name) ?? [] : [];
      if (nameMatches.length === 1) unit = nameMatches[0];
    }
    if (!unit) {
      problem('Product not found (check the SKU and the name)');
      continue;
    }

    const qty = Number(qtyText.replace(/,/g, ''));
    if (!Number.isInteger(qty) || qty <= 0) {
      problem(`Qty "${qtyText}" must be a whole number above 0`);
      continue;
    }
    const priceText = text(cell(col.price)).replace(/,/g, '').replace(/^৳\s*/, '');
    if (priceText !== '' && (!Number.isFinite(Number(priceText)) || Number(priceText) < 0)) {
      problem(`Buying price "${text(cell(col.price))}" is not a number`);
      continue;
    }
    const expiryCell = cell(col.expiry);
    const expiry = parseExpiry(expiryCell ?? null);
    if (expiry === undefined) {
      problem(`Expiry "${text(expiryCell)}" is not a month (write MM/YYYY, e.g. 03/2027)`);
      continue;
    }
    rows.push({ unit, qty, price: priceText, expiry: expiry ? expiry.slice(0, 7) : '' });
  }
  return { rows, problems };
}

/** Reads an uploaded .xlsx or .csv into cells. The libraries load only here. */
export async function readLotFile(file: File): Promise<SheetCell[][]> {
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
    const { default: Papa } = await import('papaparse');
    const textBody = await file.text();
    const parsed = Papa.parse<string[]>(textBody, { skipEmptyLines: true });
    return parsed.data as SheetCell[][];
  }
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  try {
    const sheets = (await readXlsxFile(file)) as unknown as { sheet: string; data: SheetCell[][] }[];
    const named = sheets.find((s) => s.sheet.trim().toLowerCase() === LOT_SHEET_NAME.toLowerCase());
    return (named ?? sheets[0])?.data ?? [];
  } catch {
    throw new Error('This is not an .xlsx or .csv file. Save it as .xlsx (Excel Workbook) and upload again.');
  }
}

export async function buildLotTemplate(units: readonly StockUnit[]): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const header = LOT_COLUMNS.map((value) => ({ value, fontWeight: 'bold' as const }));
  const body = lotTemplateRows(units).map((row) =>
    row.map((value, i) => (i < 2 ? { value, type: String, backgroundColor: '#E5E5E5', textColor: '#555555' } : null))
  );
  return writeXlsxFile([
    {
      sheet: LOT_SHEET_NAME,
      data: [header, ...body],
      columns: [{ width: 18 }, { width: 56 }, { width: 8 }, { width: 14 }, { width: 16 }],
      stickyRowsCount: 1,
    },
  ]).toBlob();
}
