import type { Product, StockStatus } from '../types';

export const CSV_TEMPLATE_COLUMNS = [
  'sku',
  'name',
  'description',
  'category_name',
  'retail_price',
  'offer_price',
  'wholesale_price',
  'stock_status',
  'stock_quantity',
  'note',
  'is_active',
] as const;

export const CSV_EXPORT_COLUMNS = [
  ...CSV_TEMPLATE_COLUMNS,
  'image_url',
  'created_at',
] as const;

/** Escape a single CSV field per RFC 4180. */
function escapeField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildCSV(header: readonly string[], rows: string[][]): string {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeField).join(','));
  }
  return lines.join('\r\n');
}

/** Trigger a client-side file download from a string (no server call). */
export function downloadCSV(filename: string, content: string): void {
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** CSV import template with 2 realistic example rows. */
export function generateTemplate(): string {
  return buildCSV(CSV_TEMPLATE_COLUMNS, [
    ['FC-010', 'Cetaphil Gentle Skin Cleanser 250ml', 'Gentle, soap-free cleanser for all skin types.', 'Face Care', '1250', '1099', '1050', 'in_stock', '20', 'Original Canada stock', 'true'],
    ['BC-010', 'Nivea Creme 150ml', '', 'Body Care', '450', '', '380', 'low_stock', '', '', 'true'],
  ]);
}

/** Export ALL products (active and inactive) as CSV. */
export function productsToCSV(products: Product[]): string {
  const rows = products.map((p) => [
    p.sku,
    p.name,
    p.description ?? '',
    p.category?.name ?? '',
    String(p.retail_price),
    p.offer_price !== null ? String(p.offer_price) : '',
    p.wholesale_price !== null ? String(p.wholesale_price) : '',
    p.stock_status,
    p.stock_quantity !== null ? String(p.stock_quantity) : '',
    p.note ?? '',
    String(p.is_active),
    p.image_url ?? '',
    p.created_at,
  ]);
  return buildCSV(CSV_EXPORT_COLUMNS, rows);
}

export function exportFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `naeem-price-hub-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
}

/** Accepts in_stock / low_stock / out_of_stock case-insensitively; null if invalid. */
export function normalizeStockStatus(value: string): StockStatus | null {
  const v = value.trim().toLowerCase();
  if (v === '' ) return 'in_stock';
  if (v === 'in_stock' || v === 'low_stock' || v === 'out_of_stock') return v;
  return null;
}

/** Accepts true/false, 1/0, yes/no (case-insensitive); defaults to true. */
export function parseBooleanFlag(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === '') return true;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return null;
}
