import writeXlsxFile from 'write-excel-file/node';
import { OPENING_COLUMNS } from '../../src/lib/inventory/opening';

/**
 * Batch 38 dev-only test data: two lots and a small opening stock file.
 * Used only by e2e/batch-38.spec.ts, only on the throwaway test products
 * that spec creates (hidden from shoppers), and deleted again in its
 * afterAll — never real products, never left in the database.
 */
export const TEST_PREFIX = 'E2E B38';
export const TEST_SKU_PREFIX = 'E2E-B38-';
/** Every test lot's supplier starts with this (how cleanup finds them). */
export const TEST_SUPPLIER = 'E2E B38 supplier';
/** The test opening lot's file name (its notes say "from <this>"). */
export const TEST_OPENING_FILE = 'e2e-batch38-opening.xlsx';

export interface TestUnits {
  cleanser: string;
  toner: string;
  serum: string;
  serumVariant: string;
}

/** Lot 1: an import from Australia in AUD, with a weight bill and an
 *  other bill — awkward numbers, to prove the totals are exact. */
export function importLot(u: TestUnits, tonerWeight: number | null) {
  return {
    source_type: 'import',
    country: 'Australia',
    supplier: `${TEST_SUPPLIER} Sydney`,
    lot_date: '2026-10-01',
    currency: 'AUD',
    exchange_rate: '78.4567',
    costs_pending: true,
    notes: 'e2e',
    items: [
      { product_id: u.cleanser, variant_id: null, qty: 3, unit_price_foreign: '12.35', weight_grams: '271', expiry_date: '2027-03-01' },
      { product_id: u.toner, variant_id: null, qty: 7, unit_price_foreign: '8.99', weight_grams: tonerWeight === null ? null : String(tonerWeight), expiry_date: '2027-06-01' },
      { product_id: u.serum, variant_id: u.serumVariant, qty: 11, unit_price_foreign: '4.1', weight_grams: '35', expiry_date: null },
    ],
    costs: [
      { cost_type: 'weight', amount_bdt: '10000', cost_date: '2026-10-02', note: 'Luggage' },
      { cost_type: 'other', amount_bdt: '999.99', cost_date: '2026-10-02', note: 'Customs' },
    ],
  };
}

/** Lot 2: bought from a wholesaler here in taka; no weight bill, so no
 *  weight is needed (the toner has none). */
export function wholesaleLot(u: TestUnits) {
  return {
    source_type: 'wholesale',
    country: 'Bangladesh',
    supplier: `${TEST_SUPPLIER} Dhaka`,
    lot_date: '2026-10-05',
    currency: 'BDT',
    exchange_rate: '1',
    costs_pending: false,
    notes: '',
    items: [{ product_id: u.toner, variant_id: null, qty: 5, unit_price_foreign: '640', weight_grams: null, expiry_date: '2027-12-01' }],
    costs: [{ cost_type: 'other', amount_bdt: '150', cost_date: null, note: 'Rickshaw' }],
  };
}

export type SheetValue = string | number | null;

/** An opening stock .xlsx (same sheet and columns as the template). */
export async function openingFile(rows: SheetValue[][]): Promise<Buffer> {
  const header = OPENING_COLUMNS.map((name) => ({ value: name, fontWeight: 'bold' as const }));
  const data = rows.map((row) =>
    row.map((cell) => (cell === null ? null : typeof cell === 'number' ? { value: cell, type: Number } : { value: cell, type: String }))
  );
  const blob = await writeXlsxFile(
    [
      { sheet: 'How to fill', data: [[{ value: 'test file' }]] },
      { sheet: 'Opening stock', data: [header, ...data] },
    ]
  ).toBuffer();
  return blob;
}

/** One opening row: key, sku, name, option, weight_g, source, buy price,
 *  pieces, expiry. */
export function openingRow(
  key: string,
  price: SheetValue,
  pieces: SheetValue,
  expiry: SheetValue,
  source: SheetValue = 'import',
  weight: SheetValue = null
): SheetValue[] {
  return [key, '', '', '', weight, source, price, pieces, expiry];
}
