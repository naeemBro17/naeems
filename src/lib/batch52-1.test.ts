import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canBuy,
  isBuyable,
  maxQuantity,
  optionStockFacts,
  productStockFacts,
  unitsSellable,
  type Buyer,
  type StockFacts,
} from './buyRule';
import { isInStock } from './stockStatus';
import { isVariantInStock } from './variants';
import { checkCartStock, fetchLiveStock, lineKey } from './cartStock';
import type { Product, ProductVariant } from '../types';

// The cart re-check reads the two shop views. Here they answer with the
// rows each test sets (what a customer or the admin would get back).
const views = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));
vi.mock('./supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./supabase')>()),
  supabase: {
    from: (table: string) => ({
      select: () => ({
        in: async () => ({ data: views.rows[table] ?? [], error: null }),
      }),
    }),
  },
}));

const LIMIT = 4;
const BUYERS: Buyer[] = ['customer', 'wholesaler', 'admin'];

describe('Batch 52.1: one rule for "can this be bought?"', () => {
  // keep ON / OFF × stock 0 / some (2) / enough (10) × customer / wholesaler / admin
  const cases: { keep: boolean; stock: number; buyer: Buyer; max: number }[] = [
    { keep: true, stock: 0, buyer: 'customer', max: LIMIT },
    { keep: true, stock: 2, buyer: 'customer', max: LIMIT },
    { keep: true, stock: 10, buyer: 'customer', max: LIMIT },
    { keep: true, stock: 0, buyer: 'wholesaler', max: Infinity },
    { keep: true, stock: 2, buyer: 'wholesaler', max: Infinity },
    { keep: true, stock: 10, buyer: 'wholesaler', max: Infinity },
    { keep: true, stock: 0, buyer: 'admin', max: Infinity },
    { keep: true, stock: 2, buyer: 'admin', max: Infinity },
    { keep: true, stock: 10, buyer: 'admin', max: Infinity },
    { keep: false, stock: 0, buyer: 'customer', max: 0 },
    { keep: false, stock: 2, buyer: 'customer', max: 2 },
    { keep: false, stock: 10, buyer: 'customer', max: LIMIT },
    { keep: false, stock: 0, buyer: 'wholesaler', max: 0 },
    { keep: false, stock: 2, buyer: 'wholesaler', max: 2 },
    { keep: false, stock: 10, buyer: 'wholesaler', max: 10 },
    { keep: false, stock: 0, buyer: 'admin', max: 0 },
    { keep: false, stock: 2, buyer: 'admin', max: 2 },
    { keep: false, stock: 10, buyer: 'admin', max: 10 },
  ];

  for (const c of cases) {
    it(`keep ${c.keep ? 'ON' : 'OFF'}, stock ${c.stock}, ${c.buyer}: at most ${c.max}`, () => {
      const facts: StockFacts = { keepSelling: c.keep, stock: c.stock };
      expect(maxQuantity(facts, LIMIT, c.buyer)).toBe(c.max);
      expect(canBuy(facts, 1, LIMIT, c.buyer)).toBe(c.max >= 1);
      expect(canBuy(facts, 3, LIMIT, c.buyer)).toBe(c.max >= 3);
      expect(canBuy(facts, 5, LIMIT, c.buyer)).toBe(c.max >= 5);
      expect(canBuy(facts, 0, LIMIT, c.buyer)).toBe(false);
    });
  }

  it('a customer never sees the number of a keep-selling product (stock null): still the limit', () => {
    expect(maxQuantity({ keepSelling: true, stock: null }, LIMIT, 'customer')).toBe(LIMIT);
    expect(maxQuantity({ keepSelling: true, stock: null }, 6, 'customer')).toBe(6);
    for (const buyer of BUYERS) expect(canBuy({ keepSelling: true, stock: null }, 1, LIMIT, buyer)).toBe(true);
  });

  it('keep selling has no stock cap; otherwise the stock is the cap', () => {
    expect(unitsSellable({ keepSelling: true, stock: 0 })).toBe(Infinity);
    expect(unitsSellable({ keepSelling: true, stock: -3 })).toBe(Infinity);
    expect(unitsSellable({ keepSelling: false, stock: 0 })).toBe(0);
    expect(unitsSellable({ keepSelling: false, stock: 2.7 })).toBe(2);
    expect(unitsSellable({ keepSelling: false, stock: null })).toBe(Infinity);
    expect(isBuyable({ keepSelling: true, stock: 0 })).toBe(true);
    expect(isBuyable({ keepSelling: false, stock: 0 })).toBe(false);
  });
});

const baseProduct: Product = {
  id: 'p1',
  sku: 'SKU-1',
  slug: 'cicaplast',
  name: 'La Roche-Posay Cicaplast Baume B5+',
  brand: null,
  category_id: null,
  retail_price: 3500,
  offer_price: 3499,
  stock_status: 'out_of_stock',
  stock_quantity: 0,
  note: null,
  description: null,
  how_to_use: null,
  key_ingredients: null,
  youtube_url: null,
  skin_types: [],
  skin_conditions: [],
  region: null,
  size: '40 ml',
  image_url: null,
  image_urls: [],
  image_urls_thumb: [],
  is_active: true,
  is_featured: false,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  combined_from_product_id: null,
  wholesale_price: null,
  has_wholesale: false,
  brand_id: null,
  keep_selling: true,
} as unknown as Product;

const option = (patch: Partial<ProductVariant>): ProductVariant =>
  ({
    id: 'v1',
    product_id: 'p1',
    region: 'AU',
    size: '100 ml',
    retail_price: 3500,
    offer_price: 3499,
    wholesale_price: null,
    has_wholesale: false,
    in_stock: false,
    stock_quantity: 0,
    image_url: null,
    note: null,
    source_product_id: null,
    sort_order: 1,
    created_at: '2026-11-01T00:00:00Z',
    ...patch,
  }) as ProductVariant;

describe('Batch 52.1: products and options follow the product\'s "Keep selling"', () => {
  it('product: what the admin sees (stock 0, out of stock) is buyable only with keep selling ON', () => {
    expect(isInStock(baseProduct)).toBe(true);
    expect(isInStock({ ...baseProduct, keep_selling: false })).toBe(false);
    expect(productStockFacts(baseProduct)).toEqual({ keepSelling: true, stock: 0 });
  });

  it('product: what a customer sees (number hidden, "in stock") is buyable', () => {
    expect(isInStock({ ...baseProduct, stock_quantity: null, stock_status: 'in_stock' })).toBe(true);
  });

  it('product not counted: follows the In / Out of stock flag when keep selling is OFF', () => {
    const off = { ...baseProduct, keep_selling: false, stock_quantity: null };
    expect(isInStock({ ...off, stock_status: 'in_stock' })).toBe(true);
    expect(isInStock({ ...off, stock_status: 'out_of_stock' })).toBe(false);
    expect(productStockFacts({ ...off, stock_status: 'out_of_stock' })).toEqual({ keepSelling: false, stock: 0 });
  });

  it('option at 0 (in_stock false, as Inventory mode sets it) is buyable when its product keeps selling', () => {
    expect(isVariantInStock(option({ keep_selling: true }))).toBe(true);
    expect(isVariantInStock(option({ keep_selling: false }))).toBe(false);
    // An option row without its own copy uses the product's switch.
    expect(optionStockFacts(option({}), true)).toEqual({ keepSelling: true, stock: 0 });
    expect(optionStockFacts(option({}), false)).toEqual({ keepSelling: false, stock: 0 });
    expect(optionStockFacts(option({ stock_quantity: null, in_stock: true }), false)).toEqual({ keepSelling: false, stock: null });
  });
});

describe('Batch 52.1: the cart re-check ("just sold out") follows the rule', () => {
  const lines = [
    { productId: 'p1', variantId: null, quantity: 2 },
    { productId: 'p1', variantId: 'v1', quantity: 3 },
    { productId: 'p2', variantId: null, quantity: 1 },
  ];

  beforeEach(() => {
    views.rows = {};
  });

  it('admin (real stock 0): keep-selling lines stay, a keep-OFF line at 0 is removed', async () => {
    views.rows = {
      products_view: [
        { id: 'p1', name: 'Cicaplast', is_active: true, stock_quantity: 0, stock_status: 'out_of_stock', keep_selling: true },
        { id: 'p2', name: 'Sunscreen', is_active: true, stock_quantity: 0, stock_status: 'out_of_stock', keep_selling: false },
      ],
      product_variants_view: [
        { id: 'v1', product_id: 'p1', region: 'AU', size: '100 ml', in_stock: false, stock_quantity: 0 },
      ],
    };
    const live = await fetchLiveStock(lines);
    expect(live?.get(lineKey('p1', null))?.available).toBeNull();
    expect(live?.get(lineKey('p1', 'v1'))?.available).toBeNull();
    expect(live?.get(lineKey('p2', null))?.available).toBe(0);
    const changes = await checkCartStock(lines);
    expect(changes?.map((c) => c.productId)).toEqual(['p2']);
  });

  it('customer (number hidden): keep-selling lines stay', async () => {
    views.rows = {
      products_view: [
        { id: 'p1', name: 'Cicaplast', is_active: true, stock_quantity: null, stock_status: 'in_stock', keep_selling: true },
        { id: 'p2', name: 'Sunscreen', is_active: true, stock_quantity: 5, stock_status: 'in_stock', keep_selling: false },
      ],
      product_variants_view: [
        { id: 'v1', product_id: 'p1', region: 'AU', size: '100 ml', in_stock: true, stock_quantity: null },
      ],
    };
    expect(await checkCartStock(lines)).toEqual([]);
  });

  it('keep selling OFF with some stock: lowered to what is left; hidden product: removed', async () => {
    views.rows = {
      products_view: [
        { id: 'p1', name: 'Cicaplast', is_active: true, stock_quantity: 1, stock_status: 'in_stock', keep_selling: false },
        { id: 'p2', name: 'Sunscreen', is_active: false, stock_quantity: null, stock_status: 'in_stock', keep_selling: true },
      ],
      product_variants_view: [
        { id: 'v1', product_id: 'p1', region: 'AU', size: '100 ml', in_stock: true, stock_quantity: 2 },
      ],
    };
    const changes = await checkCartStock(lines);
    expect(changes?.map((c) => [c.productId, c.variantId, c.available])).toEqual([
      ['p1', null, 1],
      ['p1', 'v1', 2],
      ['p2', null, 0],
    ]);
  });

  it("the product's own size picked as an option (id = product id) uses the product row", async () => {
    views.rows = {
      products_view: [
        { id: 'p1', name: 'Cicaplast', is_active: true, stock_quantity: 0, stock_status: 'out_of_stock', keep_selling: true },
      ],
    };
    expect(await checkCartStock([{ productId: 'p1', variantId: 'p1', quantity: 4 }])).toEqual([]);
  });
});
