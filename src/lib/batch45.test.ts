import { describe, expect, it, vi } from 'vitest';

/* A tiny stand-in for the database: the cart's stock check reads products
   and options by id. Product P has its own size (stock 4) and two options:
   V1 sold out, V2 with 3 left. */
const rows: Record<string, Record<string, unknown>[]> = {
  products_view: [{ id: 'P', name: 'CeraVe Foaming Cleanser', is_active: true, stock_quantity: 4, stock_status: 'in_stock' }],
  product_variants_view: [
    { id: 'V1', product_id: 'P', region: 'USA', size: '355 ml', in_stock: false, stock_quantity: 0 },
    { id: 'V2', product_id: 'P', region: 'USA', size: '473 ml', in_stock: true, stock_quantity: 3 },
  ],
};
vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        in: (_col: string, ids: string[]) =>
          Promise.resolve({ data: (rows[table] ?? rows.products_view).filter((r) => ids.includes(String(r.id))), error: null }),
      }),
    }),
  },
}));
vi.mock('../contexts/ProductContext', () => ({ PRODUCTS_VIEW: 'products_view' }));

import { checkCartStock, optionVariantId } from './cartStock';
import { allocateLot } from './inventory/allocation';
import { parseLotSheet, lotTemplateRows, LOT_COLUMNS } from './inventory/lotExcel';
import type { StockUnit } from './inventory/types';
import { productSearchGroups } from './manualOrderSearch';
import { expiryFromText, expiryToText } from '../components/admin/inventory/LotForm';
import { buyingPriceUnit } from '../components/admin/inventory/BuyingPricesView';
import type { Product, ProductVariant } from '../types';

/* --------------------------------------------- Part 3: stock per size */

describe('Batch 45 Part 3: the cart checks the stock of the exact size', () => {
  it("the product's own size (option id = product id) is the product row", () => {
    expect(optionVariantId('P', 'P')).toBeNull();
    expect(optionVariantId('P', 'V2')).toBe('V2');
    expect(optionVariantId('P', null)).toBeNull();
  });

  it('an out-of-stock size never blocks an in-stock size, and is itself refused', async () => {
    const changes = await checkCartStock([
      { productId: 'P', variantId: 'P', quantity: 2 }, // own size, 4 left
      { productId: 'P', variantId: 'V2', quantity: 3 }, // 3 left
      { productId: 'P', variantId: 'V1', quantity: 1 }, // sold out
    ]);
    expect(changes).toEqual([{ productId: 'P', variantId: 'V1', name: 'CeraVe Foaming Cleanser', label: 'USA · 355 ml', available: 0 }]);
  });

  it('asking for more than a size has is lowered to what that size has', async () => {
    const changes = await checkCartStock([{ productId: 'P', variantId: 'V2', quantity: 5 }]);
    expect(changes?.map((c) => c.available)).toEqual([3]);
  });
});

/* ---------------------------------------- Part 4: New order search */

const product = (over: Partial<Product>): Product =>
  ({ id: 'P', name: 'Plunketts Aloe Vera Gel', is_active: true, retail_price: 900, offer_price: 850, stock_quantity: 2, region: 'AU', size: '75 g', image_url: null, image_urls: [], image_urls_thumb: [], ...over }) as Product;
const variant = (over: Partial<ProductVariant>): ProductVariant =>
  ({ id: 'V', product_id: 'P', region: 'AU', size: '240 ml', retail_price: 1400, offer_price: null, stock_quantity: 0, in_stock: false, image_url: null, ...over }) as ProductVariant;

describe('Batch 45 Part 4: each product once in New order search', () => {
  it('a product with options is one result: its own size first, then each option with its own price and stock', () => {
    const groups = productSearchGroups([product({})], () => [variant({}), variant({ id: 'W', size: '400 ml', retail_price: 2000, stock_quantity: 5 })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].options.map((o) => [o.variantId, o.variantLabel, o.listPrice, o.stockQuantity])).toEqual([
      [null, 'AU · 75 g', 850, 2],
      ['V', 'AU · 240 ml', 1400, 0],
      ['W', 'AU · 400 ml', 2000, 5],
    ]);
  });

  it('a product without options is one option (tap = add, as before) and inactive products are left out', () => {
    const groups = productSearchGroups([product({ size: null, region: null }), product({ id: 'X', is_active: false })], () => []);
    expect(groups.map((g) => g.options.length)).toEqual([1]);
    expect(groups[0].options[0]).toMatchObject({ variantId: null, key: 'P', label: 'Plunketts Aloe Vera Gel', variantLabel: null });
  });
});

/* ----------------------------------------------- Part 5: no weight */

describe('Batch 45 Part 5: landed cost has no weight in it', () => {
  it('Niacinamide 10% + Zinc 30ml: ৳795 buy price is ৳795 landed (not ৳1,152.75)', () => {
    const result = allocateLot([{ qty: 9, unitPriceForeign: '795', label: 'Niacinamide' }], [{ costType: 'weight', amountBdt: '3220.65' }], 1);
    expect(result.ok && result.rows[0].landedUnitBdt).toBe(795);
  });

  it('landed = buy price + share of other costs, nothing else', () => {
    const result = allocateLot(
      [
        { qty: 1, unitPriceForeign: '300', label: 'A' },
        { qty: 1, unitPriceForeign: '100', label: 'B' },
      ],
      [
        { costType: 'other', amountBdt: '40' },
        { costType: 'weight', amountBdt: '1000' },
      ],
      1
    );
    expect(result.ok && result.rows.map((r) => r.landedUnitBdt)).toEqual([330, 110]);
  });
});

/* ------------------------------------------------ Part 12: Excel */

const unit = (over: Partial<StockUnit>): StockUnit => ({
  product_id: 'P1',
  variant_id: null,
  sku: 'SKU-1',
  product_name: 'CeraVe Cleanser 236ml',
  option_label: null,
  is_active: true,
  weight_grams: null,
  weight_source: null,
  site_stock: 0,
  in_stock: false,
  selling_price: 1000,
  lot_pieces_left: 0,
  lot_rows: 0,
  stock_unit: 'pcs',
  pack_size: 1,
  latest_unit_cost: 0,
  ...over,
});

describe('Batch 45 Part 12: lot rows from Excel', () => {
  const units = [
    unit({}),
    unit({ product_id: 'P2', sku: 'SKU-2', product_name: 'Fish Oil', option_label: null }),
    unit({ product_id: 'P3', variant_id: 'V3a', sku: 'SKU-3', product_name: 'Serum', option_label: 'AU · 30 ml' }),
    unit({ product_id: 'P3', variant_id: 'V3b', sku: 'SKU-3', product_name: 'Serum', option_label: 'AU · 60 ml' }),
  ];

  it('the template has one row per product / option with SKU and name', () => {
    expect(lotTemplateRows(units).map((r) => r[1])).toEqual(['CeraVe Cleanser 236ml', 'Fish Oil', 'Serum — AU · 30 ml', 'Serum — AU · 60 ml']);
    expect(LOT_COLUMNS).toEqual(['SKU', 'Product', 'Qty', 'Buying price', 'Expiry (MM/YYYY)']);
  });

  it('good rows become form rows; empty Qty is skipped; unknown product and bad date are listed, never dropped', () => {
    const sheet = [
      [...LOT_COLUMNS],
      ['SKU-1', 'CeraVe Cleanser 236ml', 3, 950, '03/2027'],
      ['SKU-2', 'Fish Oil', '', '', ''],
      ['', 'Serum — AU · 60 ml', '2', '1,200', new Date(Date.UTC(2027, 5, 15))],
      ['SKU-9', 'Not a product', 1, 10, ''],
      ['SKU-3', 'Serum — AU · 30 ml', 4, 700, '13/2027'],
      ['SKU-2', 'Fish Oil', 1.5, 10, ''],
      ['SKU-2', 'Fish Oil', 1, 'abc', ''],
    ];
    const result = parseLotSheet(sheet, units);
    expect(result.rows.map((r) => [r.unit.product_id, r.unit.variant_id, r.qty, r.price, r.expiry])).toEqual([
      ['P1', null, 3, '950', '2027-03'],
      ['P3', 'V3b', 2, '1200', '2027-06'],
    ]);
    expect(result.problems.map((p) => [p.row, p.reason.split(' ')[0]])).toEqual([
      [5, 'Product'],
      [6, 'Expiry'],
      [7, 'Qty'],
      [8, 'Buying'],
    ]);
  });

  it('a file without a Qty column is refused with a plain message', () => {
    expect(() => parseLotSheet([['a', 'b']], units)).toThrow(/Qty/);
  });

  it('the form reads and writes expiry as MM/YYYY', () => {
    expect(expiryFromText('3/2027')).toBe('2027-03');
    expect(expiryFromText('03-2027')).toBe('2027-03');
    expect(expiryFromText('2027-11')).toBe('2027-11');
    expect(expiryFromText('')).toBe('');
    expect(expiryFromText('13/2027')).toBeNull();
    expect(expiryToText('2027-03')).toBe('03/2027');
  });
});

/* ----------------------------------------- Part 8: buying price unit */

describe('Batch 45 Part 8: buying price labels', () => {
  it('per piece, or per unit of a pack product (the lots’ unit)', () => {
    expect(buyingPriceUnit({ stock_unit: 'pcs', pack_size: 1 })).toBe('per piece');
    expect(buyingPriceUnit({ stock_unit: 'pcs', pack_size: 400 })).toBe('per pcs (1 pack = 400 pcs)');
  });
});
