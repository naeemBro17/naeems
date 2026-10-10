import { describe, expect, it } from 'vitest';
import { allocateLot, rowUnits } from './inventory/allocation';
import { packsText, unitsText } from './inventory/api';
import { scaledText } from './inventory/decimal';
import {
  OPENING_COLUMNS,
  confirmPayload,
  mergeDuplicates,
  openingAddedPaisa,
  openingLandedUnit,
  openingTotals,
  openingUnits,
  readOpeningSheet,
  templateRows,
  type OpeningRow,
  type SheetCell,
} from './inventory/opening';
import type { StockUnit } from './inventory/types';
import { lineNameWithUnits, lineQuantityText, orderItemCount, soldInUnits } from './orderLines';
import { parseStockWarning } from './manualOrders';
import { invoiceFromOrder } from './invoice/invoiceData';
import { lotPacks, willSellOut } from '../components/admin/inventory/ModeView';
import { mockOrder } from '../../e2e/helpers/invoiceFixtures';

/* -------------------------------------------------------------- units */

describe('Batch 39 units: packs ↔ units in a lot', () => {
  it('2 packs of 400 pcs = 800 units; 250 loose units = 250', () => {
    expect(rowUnits(2, 'pack', 400)).toBe(800);
    expect(rowUnits(250, 'unit', 400)).toBe(250);
    expect(rowUnits(3)).toBe(3);
  });

  it('a price per pack and a price per unit both become a cost per unit (৳1,200 a 400 pcs pack = ৳3 a pc)', () => {
    const result = allocateLot(
      [
        { qty: 2, entryUnit: 'pack', packSize: 400, unitPriceForeign: '1200', weightGrams: null, label: 'Fish oil' },
        { qty: 250, entryUnit: 'unit', packSize: 400, unitPriceForeign: '3', weightGrams: null, label: 'Fish oil loose' },
      ],
      [],
      1
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.qty)).toEqual([800, 250]);
    expect(result.rows.map((r) => r.landedUnitBdt)).toEqual([3, 3]);
    expect(result.rows.map((r) => scaledText(r.buyValueE4, 4))).toEqual(['2400.0000', '750.0000']);
    expect(result.buyTotalPaisa).toBe(315_000n);
  });

  it('a CeraVe 473 ml refill: ৳1,000 a pack is ৳2.114165 a ml, and the lot still adds up exactly', () => {
    const result = allocateLot(
      [{ qty: 3, entryUnit: 'pack', packSize: 473, unitPriceForeign: '1000', weightGrams: 544, label: 'Refill' }],
      [{ costType: 'other', amountBdt: '99.99' }],
      1
    );
    expect(result.ok && result.rows[0].qty).toBe(1419);
    expect(result.ok && result.allocatedOtherPaisa).toBe(9999n);
    expect(result.ok && result.rows[0].landedUnitBdt).toBeCloseTo(3000 / 1419 + 99.99 / 1419, 9);
  });

  it('pack size 1 behaves exactly like Batch 38 (packs/units choice ignored)', () => {
    const a = allocateLot([{ qty: 3, unitPriceForeign: '12.35', weightGrams: 100, label: 'A' }], [{ costType: 'weight', amountBdt: 50 }], '78.4567');
    const b = allocateLot([{ qty: 3, entryUnit: 'unit', packSize: 1, unitPriceForeign: '12.35', weightGrams: 100, label: 'A' }], [{ costType: 'weight', amountBdt: 50 }], '78.4567');
    expect(a).toEqual(b);
  });

  it('weight is per pack: grams of a row = units × weight ÷ pack size', () => {
    // 800 pcs of a 400 pcs / 500 g bottle = 1,000 g; 2 pieces of 500 g = 1,000 g → equal shares.
    const result = allocateLot(
      [
        { qty: 2, entryUnit: 'pack', packSize: 400, unitPriceForeign: '100', weightGrams: 500, label: 'Bottle' },
        { qty: 2, unitPriceForeign: '100', weightGrams: 500, label: 'Jar' },
      ],
      [{ costType: 'weight', amountBdt: '100' }],
      1
    );
    expect(result.ok && result.rows.map((r) => r.weightPaisa)).toEqual([5000n, 5000n]);
  });
});

/* ----------------------------------------------------- guessed weights */

describe('Batch 39 Part 1: missing weight is guessed from price', () => {
  it('some rows weighted: the others get a weight at the lot’s grams per taka — same as the database (14286 / 85714)', () => {
    const result = allocateLot(
      [
        { qty: 2, unitPriceForeign: '100', weightGrams: '100', label: 'Cleanser' },
        { qty: 1, entryUnit: 'pack', packSize: 400, unitPriceForeign: '1200', weightGrams: null, label: 'Fish oil' },
      ],
      [{ costType: 'weight', amountBdt: '1000' }],
      1
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.weightRule).toBe('guess');
    expect(result.rows.map((r) => r.weightGuessed)).toEqual([false, true]);
    expect(result.rows.map((r) => r.weightPaisa)).toEqual([14286n, 85714n]);
    expect(result.allocatedWeightPaisa).toBe(100_000n);
  });

  it('no row weighted: the whole weight cost is shared by buy value — same as the database (25546 / 24459)', () => {
    const result = allocateLot(
      [
        { qty: 3, unitPriceForeign: '100.33', weightGrams: null, label: 'A' },
        { qty: 7, unitPriceForeign: '41.17', weightGrams: null, label: 'B' },
      ],
      [{ costType: 'weight', amountBdt: '500.05' }],
      1
    );
    expect(result.ok && result.weightRule).toBe('value');
    expect(result.ok && result.rows.map((r) => r.weightPaisa)).toEqual([25546n, 24459n]);
    expect(result.ok && result.rows.every((r) => r.weightGuessed)).toBe(true);
  });

  it('totals stay exact to the paisa for awkward amounts, any mix of weighted rows', () => {
    for (let paisa = 1; paisa < 4000; paisa += 37) {
      const result = allocateLot(
        [
          { qty: 3, unitPriceForeign: '7.77', weightGrams: '33.3', label: 'A' },
          { qty: 5, unitPriceForeign: '0.01', weightGrams: null, label: 'B' },
          { qty: 1, entryUnit: 'unit', packSize: 60, unitPriceForeign: '19.99', weightGrams: null, label: 'C' },
          { qty: 2, entryUnit: 'pack', packSize: 7, unitPriceForeign: '1', weightGrams: '12', label: 'D' },
        ],
        [
          { costType: 'weight', amountBdt: (paisa / 100).toFixed(2) },
          { costType: 'other', amountBdt: ((paisa * 3) / 100).toFixed(2) },
        ],
        1
      );
      expect(result.ok && result.allocatedWeightPaisa).toBe(BigInt(paisa));
      expect(result.ok && result.allocatedOtherPaisa).toBe(BigInt(paisa * 3));
    }
  });

  it('an old lot in another currency still works out the same (AUD at 78.4567)', () => {
    const result = allocateLot([{ qty: 3, unitPriceForeign: '12.35', weightGrams: '271', label: 'A' }], [{ costType: 'weight', amountBdt: '100' }], '78.4567');
    expect(result.ok && scaledText(result.rows[0].unitPriceBdtE4, 4)).toBe('968.9402');
    expect(result.ok && result.rows[0].landedUnitBdt).toBeCloseTo(1002.273533, 5);
  });
});

/* ------------------------------------------------------- opening file */

const FISH = '11111111-1111-1111-1111-111111111111';
const CREAM = '22222222-2222-2222-2222-222222222222';

function unit(product_id: string, name: string, pack: number, word: StockUnit['stock_unit'] = 'pcs'): StockUnit {
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
    selling_price: 5000,
    lot_pieces_left: 0,
    lot_rows: 0,
    stock_unit: word,
    pack_size: pack,
    latest_unit_cost: 0,
  };
}

const UNITS = [unit(FISH, 'Fish Oil 1000mg', 400), unit(CREAM, 'Cream', 1)];
const HEADER: SheetCell[] = [...OPENING_COLUMNS];
function row(key: string, price: SheetCell, pieces: SheetCell, extra: SheetCell = null, pack: SheetCell = null, expiry: SheetCell = '2027-03'): SheetCell[] {
  const cells: SheetCell[] = HEADER.map(() => null);
  const set = (col: (typeof OPENING_COLUMNS)[number], value: SheetCell) => (cells[OPENING_COLUMNS.indexOf(col)] = value);
  set('product_key', key);
  set('source', 'import');
  set('buy_price_bdt', price);
  set('pieces', pieces);
  set('expiry', expiry);
  set('weight_g', 120);
  set('extra_units', extra);
  set('pack_size', pack);
  return cells;
}

describe('Batch 39 opening file: pack size and extra_units', () => {
  const today = '2026-10-11';

  it('the template has stock_unit and pack_size (read-only) and an empty extra_units, at the end', () => {
    expect(OPENING_COLUMNS.slice(-3)).toEqual(['stock_unit', 'pack_size', 'extra_units']);
    const fish = templateRows(UNITS)[0];
    expect(fish[OPENING_COLUMNS.indexOf('stock_unit')]).toBe('pcs');
    expect(fish[OPENING_COLUMNS.indexOf('pack_size')]).toBe(400);
    expect(fish[OPENING_COLUMNS.indexOf('extra_units')]).toBeNull();
  });

  it('units = pieces × pack size + extra_units (2 bottles + 250 loose pcs = 1050)', () => {
    const preview = readOpeningSheet([HEADER, row(FISH, 1200, 2, 250, 400)], UNITS, today);
    expect(preview.problemCount).toBe(0);
    expect(openingUnits(preview.rows[0])).toBe(1050);
    expect(confirmPayload(preview.rows)[0]).toMatchObject({ pieces: 2, extra_units: 250, buy_price_bdt: '1200.0000' });
  });

  it('only an opened bottle: pieces 0 + 250 loose units is fine; nothing at all is not', () => {
    const preview = readOpeningSheet([HEADER, row(FISH, 1200, 0, 250, 400), row(FISH, 1200, 0, 0, 400, '2027-09')], UNITS, today);
    expect(preview.rows.map((r) => openingUnits(r))).toEqual([250]);
    expect(preview.problems.not_positive.map((p) => p.row)).toEqual([3]);
  });

  it('a changed pack_size or a bad extra_units must be fixed', () => {
    const preview = readOpeningSheet([HEADER, row(FISH, 1200, 1, null, 300), row(FISH, 1200, 1, -5, 400), row(FISH, 1200, 1, 2.5, 400)], UNITS, today);
    expect(preview.problems.bad_value.map((p) => p.row)).toEqual([2, 3, 4]);
  });

  it('buy price stays per pack: value = units × price ÷ pack size; the weight % follows (same as the database)', () => {
    const fish: Pick<OpeningRow, 'source' | 'pieces' | 'priceE4' | 'extraUnits' | 'packSize'> = {
      source: 'import',
      pieces: 2,
      extraUnits: 250,
      packSize: 400,
      priceE4: 12_000_000n,
    };
    expect(openingAddedPaisa(fish, 10_000n)).toBe(31_500n); // 1050 × ৳3 × 10% = ৳315
    expect(openingLandedUnit(fish, 10_000n)).toBeCloseTo(3.3, 9);
    const totals = openingTotals([{ ...fish, key: FISH, productId: FISH, variantId: null, label: 'Fish', expiry: null, weightG: null, fromRows: [2] }], 10_000n);
    expect(totals).toEqual({ pieces: 1050, buyPaisa: 315_000n, addedPaisa: 31_500n, valuePaisa: 346_500n });
  });

  it('duplicates merge by units: price per pack averaged by units', () => {
    const base: OpeningRow = { key: FISH, productId: FISH, variantId: null, label: 'Fish', source: 'import', priceE4: 12_000_000n, pieces: 1, extraUnits: 0, packSize: 400, expiry: null, weightG: null, fromRows: [2] };
    const [merged] = mergeDuplicates([base, { ...base, pieces: 0, extraUnits: 200, priceE4: 15_000_000n, fromRows: [3] }]);
    expect(openingUnits(merged)).toBe(600);
    expect(merged.priceE4).toBe(13_000_000n); // (400 × 1200 + 200 × 1500) ÷ 600
  });
});

/* ------------------------------------------------ order lines, warnings */

describe('Batch 39: loose units on orders, invoices and customer pages', () => {
  const loose = { quantity: 150, sold_unit: 'pcs' as const };
  const packs = { quantity: 2, sold_unit: null };

  it('shows "150 pcs" and counts the line as one item', () => {
    expect(soldInUnits(loose)).toBe(true);
    expect(soldInUnits(packs)).toBe(false);
    expect(lineQuantityText(loose)).toBe('150 pcs');
    expect(lineQuantityText(packs)).toBe('2');
    expect(orderItemCount([loose, packs])).toBe(3);
    expect(lineNameWithUnits('Fish Oil 1000mg', loose)).toBe('Fish Oil 1000mg — 150 pcs');
  });

  it('the invoice prints "Fish Oil 1000mg — 150 pcs", 1 × the line total, with no cost or lot anywhere', () => {
    const order = mockOrder({
      items: [
        { ...mockOrder().items[0], product_name: 'Fish Oil 1000mg', variant_label: null, list_price: 5, unit_price: 8, quantity: 150, line_total: 1200, sold_unit: 'pcs' },
      ],
    });
    const inv = invoiceFromOrder(order, []);
    expect(inv.lines[0]).toMatchObject({ name: 'Fish Oil 1000mg — 150 pcs', quantity: 1, amount: 1200 });
    expect(inv.itemCount).toBe(1);
    expect(JSON.stringify(inv)).not.toMatch(/landed|lot|cost/i);
  });

  it('the database stock warning in units is read back with its unit', () => {
    const warnings = parseStockWarning('STOCK_WARNING:[{"product_name":"Fish Oil","variant_label":null,"available":250,"requested":400,"unit":"pcs"}]');
    expect(warnings).toEqual([{ product_name: 'Fish Oil', variant_label: null, available: 250, requested: 400, unit: 'pcs' }]);
  });

  it('units in plain words', () => {
    expect(unitsText(1050, 'pcs', 400)).toBe('1050 pcs');
    expect(unitsText(3, 'pcs', 1)).toBe('3');
    expect(packsText(1050, 'pcs', 400)).toBe('2 packs + 250 pcs');
    expect(packsText(400, 'ml', 400)).toBe('1 pack');
  });
});

/* ---------------------------------------------------- the check screen */

describe('Batch 39 Part 4: the Inventory mode check screen', () => {
  it('shop stock = whole packs = floor(units ÷ pack size)', () => {
    expect(lotPacks({ lot_pieces_left: 1050, pack_size: 400 })).toBe(2);
    expect(lotPacks({ lot_pieces_left: 399, pack_size: 400 })).toBe(0);
    expect(lotPacks({ lot_pieces_left: 7, pack_size: 1 })).toBe(7);
  });

  it('"These will show Sold out": on sale now, no whole pack in lots', () => {
    const base = unit(FISH, 'Fish', 400);
    expect(willSellOut({ ...base, lot_pieces_left: 399 })).toBe(true);
    expect(willSellOut({ ...base, lot_pieces_left: 400 })).toBe(false);
    expect(willSellOut({ ...base, lot_pieces_left: 0, is_active: false })).toBe(false);
    expect(willSellOut({ ...base, lot_pieces_left: 0, site_stock: 0 })).toBe(false);
    expect(willSellOut({ ...base, lot_pieces_left: 0, site_stock: null, in_stock: true })).toBe(true);
  });
});
