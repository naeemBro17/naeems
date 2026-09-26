import { describe, expect, it } from 'vitest';
import { filterByCategory } from './categoryFilter';
import type { Product } from '../types';

/** Minimal product stub — only category_id matters for this filter. */
function product(id: string, categoryId: string | null): Product {
  return {
    id,
    sku: `SKU-${id}`,
    slug: id,
    name: `Product ${id}`,
    brand: null,
    description: null,
    category_id: categoryId,
    category: null,
    retail_price: 100,
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe('filterByCategory', () => {
  const face = product('1', 'cat-face');
  const body = product('2', 'cat-body');
  const baby = product('3', 'cat-baby');
  const uncategorised = product('4', null);
  const all = [face, body, baby, uncategorised];

  it('returns every product unchanged when categoryId is null ("All")', () => {
    expect(filterByCategory(all, null)).toEqual(all);
  });

  it('returns only products matching the given category id', () => {
    expect(filterByCategory(all, 'cat-face')).toEqual([face]);
    expect(filterByCategory(all, 'cat-body')).toEqual([body]);
    expect(filterByCategory(all, 'cat-baby')).toEqual([baby]);
  });

  it('returns an empty array for a category with no products', () => {
    expect(filterByCategory(all, 'cat-nonexistent')).toEqual([]);
  });

  it('never matches uncategorised products against a real category id', () => {
    expect(filterByCategory(all, 'cat-face')).not.toContain(uncategorised);
  });
});
