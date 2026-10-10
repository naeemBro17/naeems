import {
  HOW_TO_FILL,
  HOW_TO_SHEET_NAME,
  MISSING_COLUMNS_ERROR,
  OPENING_COLUMNS,
  OPENING_SHEET_NAME,
  templateRows,
  type SheetCell,
} from './opening';
import type { StockUnit } from './types';

/**
 * Batch 38 Part 4: the .xlsx template and reading the filled file. The two
 * small Excel libraries load only when this is used (Admin → Inventory →
 * Opening stock), never for shoppers.
 */

const GREY = '#E5E5E5';

/** Builds the template file (two sheets: "How to fill", "Opening stock"). */
export async function buildOpeningTemplate(units: readonly StockUnit[]): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  // Grey = for reading only: the product key, and (Batch 39) the stock unit
  // and pack size, which come from the product editor.
  const readOnly = new Set(['product_key', 'stock_unit', 'pack_size'].map((c) => OPENING_COLUMNS.indexOf(c as (typeof OPENING_COLUMNS)[number])));
  const header = OPENING_COLUMNS.map((name, i) => ({
    value: name,
    fontWeight: 'bold' as const,
    backgroundColor: readOnly.has(i) ? GREY : undefined,
  }));
  const body = templateRows(units).map((row) =>
    row.map((cell, i) => {
      if (i === 0) return { value: String(cell ?? ''), backgroundColor: GREY, textColor: '#555555' };
      if (readOnly.has(i) && cell !== null) {
        return typeof cell === 'number'
          ? { value: cell, type: Number, backgroundColor: GREY, textColor: '#555555' }
          : { value: cell, type: String, backgroundColor: GREY, textColor: '#555555' };
      }
      if (cell === null) return null;
      return typeof cell === 'number' ? { value: cell, type: Number } : { value: cell, type: String };
    })
  );
  return writeXlsxFile([
    {
      sheet: HOW_TO_SHEET_NAME,
      data: HOW_TO_FILL.map((line, i) => [i === 0 ? { value: line, fontWeight: 'bold' as const, fontSize: 14 } : { value: line }]),
      columns: [{ width: 120 }],
    },
    {
      sheet: OPENING_SHEET_NAME,
      data: [header, ...body],
      columns: [{ width: 40 }, { width: 14 }, { width: 50 }, { width: 18 }, { width: 10 }, { width: 11 }, { width: 14 }, { width: 9 }, { width: 10 }, { width: 11 }, { width: 10 }, { width: 12 }],
      stickyRowsCount: 1,
    },
  ]).toBlob();
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The filled "Opening stock" sheet's cells (the sheet with product_key). */
export async function readOpeningFile(file: Blob): Promise<SheetCell[][]> {
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  let sheets: { sheet: string; data: SheetCell[][] }[];
  try {
    sheets = (await readXlsxFile(file)) as unknown as { sheet: string; data: SheetCell[][] }[];
  } catch {
    throw new Error('This is not an .xlsx file Excel can open. Save it as .xlsx (Excel Workbook) and upload again.');
  }
  const named = sheets.find((s) => s.sheet.trim().toLowerCase() === OPENING_SHEET_NAME.toLowerCase());
  const withKey = sheets.find((s) => s.data.slice(0, 20).some((row) => row.some((c) => String(c ?? '').trim().toLowerCase() === 'product_key')));
  const sheet = named ?? withKey;
  if (!sheet) throw new Error(MISSING_COLUMNS_ERROR);
  return sheet.data;
}
