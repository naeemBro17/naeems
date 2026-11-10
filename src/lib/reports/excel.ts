/* Batch 42: every report downloads as an Excel file — one sheet per table,
   real numbers (never text) with a ৳ number format, so Excel can add them
   up. The Excel library loads only when a download is asked for. */

export type ColumnKind = 'text' | 'money' | 'number' | 'percent' | 'date';

export interface ReportColumn {
  header: string;
  kind: ColumnKind;
  width?: number;
}

export type ReportValue = string | number | null;

export interface ReportSheet {
  name: string;
  columns: readonly ReportColumn[];
  rows: readonly (readonly ReportValue[])[];
  /** A bold last row, e.g. ['Total', null, 1500]. */
  total?: readonly ReportValue[];
  /** Lines above the table (the report name, the dates). */
  title?: readonly string[];
}

export const MONEY_FORMAT = '"৳"#,##0.00';
const NUMBER_FORMAT = '#,##0.##';
const PERCENT_FORMAT = '0.0"%"';

/** Excel allows 31 characters and none of []:*?/\ in a sheet name. */
export function sheetName(name: string, taken: readonly string[] = []): string {
  const base = name.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let out = base;
  let n = 2;
  while (taken.includes(out)) {
    const tag = ` (${n})`;
    out = `${base.slice(0, 31 - tag.length)}${tag}`;
    n += 1;
  }
  return out;
}

/** Money rounded to paisa (so the file adds up exactly like the screen). */
export function excelNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

interface Cell {
  value?: string | number | Date;
  type?: StringConstructor | NumberConstructor | DateConstructor;
  format?: string;
  fontWeight?: 'bold';
}

/** One cell; a date "2026-10-11" becomes a real Excel date. */
export function cellFor(kind: ColumnKind, value: ReportValue, bold = false): Cell | null {
  const weight = bold ? { fontWeight: 'bold' as const } : {};
  if (value === null || value === '') return bold ? { value: '', type: String, ...weight } : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (kind === 'money') return { value: excelNumber(value), type: Number, format: MONEY_FORMAT, ...weight };
    if (kind === 'percent') return { value: Math.round(value * 10) / 10, type: Number, format: PERCENT_FORMAT, ...weight };
    return { value, type: Number, format: NUMBER_FORMAT, ...weight };
  }
  if (kind === 'date' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    return { value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: 'dd mmm yyyy', ...weight };
  }
  return { value, type: String, ...weight };
}

/** The cell grid of one sheet (also used by the unit tests). */
export function sheetData(sheet: ReportSheet): (Cell | null)[][] {
  const rows: (Cell | null)[][] = [];
  for (const line of sheet.title ?? []) rows.push([{ value: line, type: String, fontWeight: 'bold' }]);
  if ((sheet.title ?? []).length > 0) rows.push([null]);
  rows.push(sheet.columns.map((c) => ({ value: c.header, type: String, fontWeight: 'bold' as const })));
  for (const row of sheet.rows) rows.push(sheet.columns.map((c, i) => cellFor(c.kind, row[i] ?? null)));
  if (sheet.total) rows.push(sheet.columns.map((c, i) => cellFor(c.kind, sheet.total?.[i] ?? null, true)));
  return rows;
}

export async function buildWorkbook(sheets: readonly ReportSheet[]): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const names: string[] = [];
  const list = sheets.map((s) => {
    const name = sheetName(s.name, names);
    names.push(name);
    return {
      sheet: name,
      data: sheetData(s),
      columns: s.columns.map((c) => ({ width: c.width ?? (c.kind === 'text' ? 28 : 14) })),
      stickyRowsCount: (s.title ?? []).length > 0 ? 0 : 1,
    };
  });
  return writeXlsxFile(list as unknown as Parameters<typeof writeXlsxFile>[0]).toBlob();
}

/** "naeem-profit-loss-2026-10-01-to-2026-10-31.xlsx". */
export function excelFileName(report: string, from?: string, to?: string): string {
  const slug = report.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dates = from && to ? (from === to ? `-${from}` : `-${from}-to-${to}`) : '';
  return `naeem-${slug}${dates}.xlsx`;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
