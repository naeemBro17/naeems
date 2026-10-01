import { describe, expect, it } from 'vitest';
import { relatedProducts } from './relatedProducts';
import { stockLimit } from './stockStatus';
import type { Product } from '../types';

let seq = 0;
function product(over: Partial<Product> & { name: string }): Product {
  seq += 1;
  return {
    id: over.id ?? `p${seq}`,
    sku: `SKU${seq}`,
    slug: over.name.toLowerCase().replace(/\s+/g, '-'),
    brand: null,
    brand_id: null,
    description: null,
    category_id: null,
    category: null,
    retail_price: 1000,
    offer_price: null,
    wholesale_price: null,
    stock_status: 'in_stock',
    stock_quantity: null,
    note: null,
    how_to_use: null,
    key_ingredients: null,
    youtube_url: null,
    skin_types: null,
    skin_conditions: null,
    region: null,
    size: null,
    combined_from_product_id: null,
    is_featured: false,
    has_wholesale: false,
    image_url: null,
    image_urls: null,
    image_urls_thumb: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const current = product({ id: 'cur', name: 'Current', category_id: 'cleanser', brand_id: 'cerave', retail_price: 1000 });

describe('relatedProducts — "You may also like"', () => {
  it('orders: same category + brand, then same category, then same brand; closest price first in each', () => {
    const catBrandFar = product({ name: 'CB far', category_id: 'cleanser', brand_id: 'cerave', retail_price: 1900 });
    const catBrandNear = product({ name: 'CB near', category_id: 'cleanser', brand_id: 'cerave', retail_price: 1100 });
    const catNear = product({ name: 'C near', category_id: 'cleanser', brand_id: 'other', retail_price: 990 });
    const catFar = product({ name: 'C far', category_id: 'cleanser', brand_id: 'other', retail_price: 300 });
    const brandOnly = product({ name: 'B only', category_id: 'serum', brand_id: 'cerave', retail_price: 1000 });
    const unrelated = product({ name: 'Unrelated', category_id: 'serum', brand_id: 'other', retail_price: 1000 });

    const result = relatedProducts(current, [unrelated, brandOnly, catFar, catNear, catBrandFar, catBrandNear, current]);
    expect(result.map((p) => p.name)).toEqual(['CB near', 'CB far', 'C near', 'C far', 'B only']);
  });

  it('never includes the current, hidden or out-of-stock products', () => {
    const hidden = product({ name: 'Hidden', category_id: 'cleanser', brand_id: 'cerave', is_active: false });
    const outByFlag = product({ name: 'Out flag', category_id: 'cleanser', brand_id: 'cerave', stock_status: 'out_of_stock' });
    const outByCount = product({ name: 'Out count', category_id: 'cleanser', stock_quantity: 0 });
    const ok1 = product({ name: 'OK 1', category_id: 'cleanser' });
    const ok2 = product({ name: 'OK 2', category_id: 'cleanser' });
    const ok3 = product({ name: 'OK 3', brand_id: 'cerave' });

    const names = relatedProducts(current, [current, hidden, outByFlag, outByCount, ok1, ok2, ok3]).map((p) => p.name);
    expect(names).toEqual(['OK 1', 'OK 2', 'OK 3']);
  });

  it('stops at 6', () => {
    const many = Array.from({ length: 10 }, (_, i) => product({ name: `Same ${i}`, category_id: 'cleanser', retail_price: 1000 + i }));
    expect(relatedProducts(current, many)).toHaveLength(6);
  });

  it('with fewer than 3 matches, fills up with the newest other in-stock products', () => {
    const match = product({ name: 'Match', category_id: 'cleanser' });
    const old = product({ name: 'Old', created_at: '2025-01-01T00:00:00Z' });
    const newer = product({ name: 'Newer', created_at: '2026-05-01T00:00:00Z' });
    const newest = product({ name: 'Newest', created_at: '2026-09-01T00:00:00Z' });
    const newestOut = product({ name: 'Newest but out', created_at: '2026-09-30T00:00:00Z', stock_quantity: 0 });

    const names = relatedProducts(current, [old, match, newer, newestOut, newest]).map((p) => p.name);
    expect(names).toEqual(['Match', 'Newest', 'Newer', 'Old']);
  });

  it('hides the row (returns nothing) when fewer than 2 products are left', () => {
    expect(relatedProducts(current, [current, product({ name: 'Only one' })])).toEqual([]);
    expect(relatedProducts(current, [current])).toEqual([]);
  });

  it('matches a brand by name when a product has no brand id yet', () => {
    const named = { ...current, brand_id: null, brand: 'CeraVe' };
    const sameName = product({ name: 'Same name', brand: ' cerave ', category_id: 'serum' });
    const other = product({ name: 'Other', brand: 'Nivea', category_id: 'serum', created_at: '2020-01-01T00:00:00Z' });
    const filler = product({ name: 'Filler', created_at: '2019-01-01T00:00:00Z' });
    expect(relatedProducts(named, [other, filler, sameName]).map((p) => p.name)[0]).toBe('Same name');
  });
});

describe('stockLimit', () => {
  it('is the tracked count, or no limit when stock is not tracked', () => {
    expect(stockLimit(3)).toBe(3);
    expect(stockLimit(0)).toBe(0);
    expect(stockLimit(null)).toBe(Number.POSITIVE_INFINITY);
    expect(stockLimit(undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});
