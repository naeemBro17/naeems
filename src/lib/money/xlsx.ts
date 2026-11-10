import type { SheetCell } from '../inventory/opening';
import { DUES_COLUMNS, DUES_SHEET_NAME } from './format';

/**
 * Batch 41 Part 6.2: the customer dues template (phone, name, due_amount)
 * and reading the filled file. The Excel libraries load only on the
 * Opening balances screen.
 */
export async function buildDuesTemplate(): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const header = DUES_COLUMNS.map((name) => ({ value: name, fontWeight: 'bold' as const }));
  const example = [
    { value: '01712345678', type: String },
    { value: 'Example name (delete this row)', type: String },
    { value: 1500, type: Number },
  ];
  return writeXlsxFile([
    {
      sheet: DUES_SHEET_NAME,
      data: [header, example],
      columns: [{ width: 18 }, { width: 34 }, { width: 14 }],
      stickyRowsCount: 1,
    },
  ]).toBlob();
}

/** The cells of the "Customer dues" sheet (or the first sheet). */
export async function readDuesFile(file: Blob): Promise<SheetCell[][]> {
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  let sheets: { sheet: string; data: SheetCell[][] }[];
  try {
    sheets = (await readXlsxFile(file)) as unknown as { sheet: string; data: SheetCell[][] }[];
  } catch {
    throw new Error('This is not an .xlsx file Excel can open. Save it as .xlsx (Excel Workbook) and upload again.');
  }
  const named = sheets.find((s) => s.sheet.trim().toLowerCase() === DUES_SHEET_NAME.toLowerCase());
  return (named ?? sheets[0])?.data ?? [];
}
