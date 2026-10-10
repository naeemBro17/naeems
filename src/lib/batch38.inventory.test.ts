import { describe, expect, it } from 'vitest';
import { estimateForUnit, estimateWeightGrams } from './inventory/weight';
import { allocateLot, largestRemainder } from './inventory/allocation';
import { roundDiv, scaledText, toScaled } from './inventory/decimal';
import {
  OPENING_COLUMNS,
  confirmPayload,
  mergeDuplicates,
  openingAddedPaisa,
  openingTotals,
  parseExpiry,
  readOpeningSheet,
  templateRows,
  unitKey,
  weightPercentFromHistory,
  MISSING_COLUMNS_ERROR,
  type OpeningRow,
  type SheetCell,
} from './inventory/opening';
import { lotTotals } from './inventory/api';
import type { StockUnit } from './inventory/types';
import { WEIGHT_CASES } from '../test/inventoryCases';
import { canOpenSection, visibleNavItems } from './adminNav';
import { ACTIVITY_TYPES } from './staff';

/* ---------------------------------------------------------------- weight */

describe('Batch 38 weight estimate', () => {
  it.each(WEIGHT_CASES)('"$text" → $grams g', ({ text, grams }) => {
    expect(estimateWeightGrams(text)).toBe(grams);
  });

  it('ml × 1.15 (473 ml ≈ 544 g), l × 1150, g × 1.10, kg × 1100, fl oz × 34.0055, oz × 31.185', () => {
    expect(estimateWeightGrams('473 ml')).toBe(544);
    expect(estimateWeightGrams('2 l')).toBe(2300);
    expect(estimateWeightGrams('200 g')).toBe(220);
    expect(estimateWeightGrams('0.5 kg')).toBe(550);
    expect(estimateWeightGrams('16 fl oz')).toBe(544);
    expect(estimateWeightGrams('1 oz')).toBe(31);
  });

  it('rounds halves up exactly (10 ml = 11.5 g → 12 g, never 11 from floating point)', () => {
    expect(estimateWeightGrams('10ml')).toBe(12);
    expect(estimateWeightGrams('30 ml')).toBe(35); // 34.5
  });

  it('size field first, then the name; nothing found → null (needs weight)', () => {
    expect(estimateForUnit('100 ml', 'Cream 50 ml')).toBe(115);
    expect(estimateForUnit(null, 'Cream 50 ml')).toBe(58);
    expect(estimateForUnit('', 'No size here')).toBeNull();
  });
});

/* ------------------------------------------------------------- decimals */

describe('Batch 38 exact decimals', () => {
  it('reads money text exactly, with thousands commas', () => {
    expect(toScaled('1,234.5', 2)).toBe(123450n);
    expect(toScaled(12.35, 4)).toBe(123500n);
    expect(toScaled('0.125', 2)).toBe(13n);
    expect(toScaled('', 2)).toBeNull();
    expect(toScaled('abc', 2)).toBeNull();
    expect(scaledText(123456789n, 4)).toBe('12345.6789');
    expect(roundDiv(5n, 2n)).toBe(3n);
  });
});

/* ----------------------------------------------------------- allocation */

describe('Batch 38 landed cost allocation', () => {
  it('3 rows, ৳10,000 weight cost, uneven grams, AUD — exact to the paisa (same as the live database)', () => {
    // The same lot was saved on the live database (in a rolled-back
    // transaction) on 2026-10-10; these are the numbers it stored.
    const result = allocateLot(
      [
        { qty: 3, unitPriceForeign: '12.35', weightGrams: 100, label: 'A' },
        { qty: 7, unitPriceForeign: '8.99', weightGrams: 333, label: 'B' },
        { qty: 11, unitPriceForeign: '4.1', weightGrams: 77, label: 'C' },
      ],
      [
        { costType: 'weight', amountBdt: '10000' },
        { costType: 'other', amountBdt: '999.99' },
      ],
      '78.4567'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => scaledText(r.unitPriceBdtE4, 4))).toEqual(['968.9402', '705.3257', '321.6725']);
    expect(result.rows.map((r) => r.weightPaisa)).toEqual([86256n, 670213n, 243531n]);
    expect(result.rows.map((r) => r.otherPaisa)).toEqual([25537n, 43376n, 31086n]);
    expect(result.allocatedWeightPaisa).toBe(1_000_000n);
    expect(result.allocatedOtherPaisa).toBe(99_999n);
    expect(result.rows[0].landedUnitBdt).toBeCloseTo(1341.583533, 5);
  });

  it('weight is shared by grams, other costs by buy value', () => {
    const result = allocateLot(
      [
        { qty: 1, unitPriceForeign: 100, weightGrams: 300, label: 'Heavy cheap' },
        { qty: 1, unitPriceForeign: 300, weightGrams: 100, label: 'Light dear' },
      ],
      [
        { costType: 'weight', amountBdt: 400 },
        { costType: 'other', amountBdt: 400 },
      ],
      1
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.weightPaisa)).toEqual([30000n, 10000n]);
    expect(result.rows.map((r) => r.otherPaisa)).toEqual([10000n, 30000n]);
    expect(result.rows.map((r) => r.landedUnitBdt)).toEqual([500, 700]);
  });

  it('foreign currency: buy price in taka = price × rate', () => {
    const result = allocateLot([{ qty: 2, unitPriceForeign: '10.50', weightGrams: null, label: 'A' }], [], '80.25');
    expect(result.ok && scaledText(result.rows[0].unitPriceBdtE4, 4)).toBe('842.6250');
  });

  it('a late bill re-shares the whole lot, still exact', () => {
    const items = [
      { qty: 3, unitPriceForeign: 10, weightGrams: 50, label: 'A' },
      { qty: 3, unitPriceForeign: 10, weightGrams: 50, label: 'B' },
      { qty: 3, unitPriceForeign: 10, weightGrams: 50, label: 'C' },
    ];
    const first = allocateLot(items, [{ costType: 'weight', amountBdt: 100 }], 1);
    const later = allocateLot(items, [{ costType: 'weight', amountBdt: 100 }, { costType: 'weight', amountBdt: '0.01' }], 1);
    expect(first.ok && first.rows.map((r) => r.weightPaisa)).toEqual([3334n, 3333n, 3333n]);
    expect(later.ok && later.rows.map((r) => r.weightPaisa)).toEqual([3334n, 3334n, 3333n]);
    expect(later.ok && later.allocatedWeightPaisa).toBe(10001n);
  });

  it('missing weight blocks saving when the lot has a weight cost; not when it has none', () => {
    const items = [
      { qty: 1, unitPriceForeign: 10, weightGrams: 50, label: 'Has weight' },
      { qty: 1, unitPriceForeign: 10, weightGrams: null, label: 'Toner' },
      { qty: 1, unitPriceForeign: 10, weightGrams: '', label: 'Serum' },
    ];
    const blocked = allocateLot(items, [{ costType: 'weight', amountBdt: 50 }], 1);
    expect(blocked).toEqual({ ok: false, error: 'Enter weight for: Toner, Serum' });
    expect(allocateLot(items, [{ costType: 'other', amountBdt: 50 }], 1).ok).toBe(true);
  });

  it('all buy prices 0 → other costs shared by pieces', () => {
    const result = allocateLot(
      [
        { qty: 1, unitPriceForeign: 0, weightGrams: null, label: 'A' },
        { qty: 2, unitPriceForeign: 0, weightGrams: null, label: 'B' },
      ],
      [{ costType: 'other', amountBdt: 3 }],
      1
    );
    expect(result.ok && result.rows.map((r) => r.otherPaisa)).toEqual([100n, 200n]);
  });

  it('largest remainder always adds up exactly', () => {
    for (let total = 0n; total < 200n; total += 7n) {
      const shares = largestRemainder(total, [3n, 5n, 11n, 13n]);
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(total);
    }
  });
});

/* ------------------------------------------------------- opening stock */

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const P3 = '33333333-3333-3333-3333-333333333333';
const V3 = '33333333-0000-0000-0000-000000000001';

function unit(product_id: string, name: string, price: number, extra: Partial<StockUnit> = {}): StockUnit {
  return {
    product_id,
    variant_id: null,
    sku: `SKU-${name}`,
    product_name: name,
    option_label: null,
    is_active: true,
    weight_grams: 100,
    weight_source: 'estimated',
    site_stock: 5,
    in_stock: true,
    selling_price: price,
    lot_pieces_left: 0,
    lot_rows: 0,
    ...extra,
  };
}

const UNITS: StockUnit[] = [
  unit(P1, 'Cleanser', 1500),
  unit(P2, 'Cream', 900),
  unit(P3, 'Serum', 2000, { variant_id: V3, option_label: 'AU · 30 ml' }),
];

const HEADER: SheetCell[] = [...OPENING_COLUMNS];

function row(key: string, price: SheetCell, pieces: SheetCell, expiry: SheetCell = '2027-03', source: SheetCell = 'import', weight: SheetCell = 120): SheetCell[] {
  return [key, 'sku', 'name', '', weight, source, price, pieces, expiry];
}

describe('Batch 38 opening stock file', () => {
  const today = '2026-10-10';

  it('template: one row per sellable unit, product_key first, source pre-filled "import", weight pre-filled', () => {
    const rows = templateRows(UNITS);
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe(P1);
    expect(rows[2][0]).toBe(`${P3}:${V3}`);
    expect(rows[2][3]).toBe('AU · 30 ml');
    expect(rows.every((r) => r[5] === 'import' && r[4] === 100)).toBe(true);
  });

  it('every check: missing, unknown key, zero/negative, bad values, warnings, skipped rows', () => {
    const preview = readOpeningSheet(
      [
        HEADER,
        row(P1, 1000, 10),
        row(P2, '', 4),
        row('not-a-key', 100, 1),
        row(P2, 0, 3),
        row(P2, 100, -2),
        row(P2, 100, 2.5),
        row(P2, 100, 2, '2027-13'),
        row(P2, 100, 2, '2027-01', 'abroad'),
        row(P2, 100, 2, '2027-01', 'import', -5),
        row(`${P3}:${V3}`, 2500, 1, '2026-01'),
        row(P2, '', ''),
        [null, null, null, null, null, null, null, null, null],
      ],
      UNITS,
      today
    );
    expect(preview.rows.map((r) => r.label)).toEqual(['Cleanser', 'Serum — AU · 30 ml']);
    expect(preview.problems.missing.map((p) => p.row)).toEqual([3]);
    expect(preview.problems.unknown_key.map((p) => p.row)).toEqual([4]);
    expect(preview.problems.not_positive.map((p) => p.row)).toEqual([5, 6]);
    expect(preview.problems.bad_value.map((p) => p.row)).toEqual([7, 8, 9, 10]);
    expect(preview.problemCount).toBe(8);
    expect(preview.warnings.price_above_selling.map((p) => p.row)).toEqual([11]);
    expect(preview.warnings.expired.map((p) => p.row)).toEqual([11]);
    expect(preview.skipped).toBe(1);
    expect(preview.totalRows).toBe(11);
  });

  it('expiry: YYYY-MM, MM/YYYY, a full date and an Excel date all become the last day of the month', () => {
    expect(parseExpiry('2027-02')).toBe('2027-02-28');
    expect(parseExpiry('02/2028')).toBe('2028-02-29');
    expect(parseExpiry('2027-03-05')).toBe('2027-03-31');
    expect(parseExpiry(new Date(Date.UTC(2027, 5, 1)))).toBe('2027-06-30');
    expect(parseExpiry('')).toBeNull();
    expect(parseExpiry('soon')).toBeUndefined();
  });

  it('duplicate rows (same product + expiry) are merged: pieces added, price averaged by pieces', () => {
    const preview = readOpeningSheet(
      [HEADER, row(P1, 100, 3), row(P2, 50, 1), row(P1, 200, 1), row(P1, 300, 1, '2027-09')],
      UNITS,
      today
    );
    const merged = preview.rows.find((r) => r.productId === P1 && r.expiry === '2027-03-31');
    expect(merged?.pieces).toBe(4);
    expect(merged?.priceE4).toBe(1250000n); // (3×100 + 200) ÷ 4 = 125
    expect(merged?.fromRows).toEqual([2, 4]);
    expect(preview.merged).toEqual([{ label: 'Cleanser', expiry: '2027-03-31', rows: [2, 4] }]);
    expect(preview.rows).toHaveLength(3);
  });

  it('the weight % is added only to import rows; opening_weight_added is exact', () => {
    const rows: OpeningRow[] = [
      { key: P1, productId: P1, variantId: null, label: 'A', source: 'import', priceE4: 1000000n, pieces: 3, expiry: null, weightG: null, fromRows: [2] },
      { key: P2, productId: P2, variantId: null, label: 'B', source: 'wholesale', priceE4: 5000000n, pieces: 2, expiry: null, weightG: null, fromRows: [3] },
      { key: P1, productId: P1, variantId: null, label: 'C', source: 'import', priceE4: 333333n, pieces: 7, expiry: null, weightG: null, fromRows: [4] },
    ];
    const pct = 38000n; // 38%
    expect(openingAddedPaisa(rows[0], pct)).toBe(11400n); // 3 × ৳100 × 38% = ৳114
    expect(openingAddedPaisa(rows[1], pct)).toBe(0n);
    expect(openingAddedPaisa(rows[2], pct)).toBe(8867n); // 7 × ৳33.3333 × 38% = ৳88.6666 → 8867 paisa
    const totals = openingTotals(rows, pct);
    expect(totals.pieces).toBe(12);
    expect(totals.addedPaisa).toBe(20267n);
    expect(totals.buyPaisa).toBe(30000n + 100000n + 23333n);
    expect(totals.valuePaisa).toBe(totals.buyPaisa + totals.addedPaisa);
  });

  it('% helper from past lots: (weight + other) ÷ buy price', () => {
    expect(weightPercentFromHistory('1,000,000', '380,000')).toBe(38);
    expect(weightPercentFromHistory('300', '100')).toBe(33.33);
    expect(weightPercentFromHistory('', '100')).toBeNull();
  });

  it('a 200-row file is read quickly and correctly', () => {
    const units = Array.from({ length: 200 }, (_, i) => unit(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, `P${i}`, 5000));
    const sheet: SheetCell[][] = [HEADER, ...units.map((u, i) => row(unitKey(u), 100 + i, (i % 9) + 1))];
    const started = performance.now();
    const preview = readOpeningSheet(sheet, units, today);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(preview.rows).toHaveLength(200);
    expect(preview.problemCount).toBe(0);
    expect(confirmPayload(preview.rows)[0]).toMatchObject({ product_id: units[0].product_id, buy_price_bdt: '100.0000', pieces: 1, source: 'import' });
  });

  it('a file whose header was changed is refused with a clear message', () => {
    expect(() => readOpeningSheet([['key', 'price'], ['x', 1]], UNITS, today)).toThrow(MISSING_COLUMNS_ERROR);
  });

  it('merging keeps different expiry dates and different sources apart', () => {
    const base: OpeningRow = { key: P1, productId: P1, variantId: null, label: 'A', source: 'import', priceE4: 10000n, pieces: 1, expiry: '2027-01-31', weightG: null, fromRows: [2] };
    const out = mergeDuplicates([base, { ...base, expiry: '2027-02-28' }, { ...base, source: 'wholesale' }]);
    expect(out).toHaveLength(3);
  });
});

/* ---------------------------------------------------------------- lists */

describe('Batch 38 lot totals and access', () => {
  it('a lot\'s totals: pieces, pieces left, landed cost = buy value + shared bills', () => {
    const totals = lotTotals([
      { qty: 3, qty_remaining: 3, unit_price_bdt: 968.9402, alloc_weight_paisa: 86256, alloc_other_paisa: 25537, product_id: P1, variant_id: null },
      { qty: 7, qty_remaining: 5, unit_price_bdt: 705.3257, alloc_weight_paisa: 670213, alloc_other_paisa: 43376, product_id: P2, variant_id: null },
    ]);
    expect(totals).toMatchObject({ products: 2, pieces: 10, left: 8 });
    expect(totals.costsPaisa).toBe(86256 + 25537 + 670213 + 43376);
  });

  it('Inventory is in the menu only with "View profit & costs"', () => {
    const without = { isAdmin: false, can: (p: string) => p === 'view_orders' };
    const withPerm = { isAdmin: false, can: (p: string) => p === 'view_profit_costs' };
    expect(canOpenSection('inventory', without)).toBe(false);
    expect(canOpenSection('inventory', withPerm)).toBe(true);
    expect(visibleNavItems(withPerm).some((i) => i.id === 'inventory')).toBe(true);
    expect(ACTIVITY_TYPES.some((t) => t.value === 'inventory.')).toBe(true);
  });
});
