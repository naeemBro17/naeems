import { describe, expect, it } from 'vitest';
import { optionGalleryImages } from './variants';
import type { ProductVariant, VariantOption } from '../types';

function variant(id: string, size: string, image: string | null): ProductVariant {
  return {
    id,
    product_id: 'p1',
    region: 'KOREA',
    size,
    retail_price: 100,
    offer_price: null,
    wholesale_price: null,
    has_wholesale: false,
    in_stock: true,
    stock_quantity: null,
    image_url: image,
    note: null,
    source_product_id: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function option(v: ProductVariant, isBase: boolean): VariantOption {
  return { ...v, isBase };
}

const base = ['bottle.jpg', 'bottle-back.jpg'];
const pouch = variant('v1', '473', 'pouch.jpg');
const noPhoto = variant('v2', '1000', null);
const baseOption = option({ ...variant('p1', '236', null) }, true);

describe('optionGalleryImages — the one image rule (Batch 23 Part 3)', () => {
  it("default option opens on the product's own first photo (what the card shows)", () => {
    expect(optionGalleryImages(base, baseOption, [pouch])).toEqual([
      'bottle.jpg',
      'bottle-back.jpg',
      'pouch.jpg',
    ]);
  });

  it("a variant with its own photo shows that photo first", () => {
    expect(optionGalleryImages(base, option(pouch, false), [pouch])[0]).toBe('pouch.jpg');
  });

  it("a variant without a photo falls back to the product's photos", () => {
    expect(optionGalleryImages(base, option(noPhoto, false), [pouch, noPhoto])[0]).toBe('bottle.jpg');
  });

  it('variants loading later never change the first photo, and nothing repeats', () => {
    const before = optionGalleryImages(base, baseOption, []);
    const after = optionGalleryImages(base, baseOption, [pouch, variant('v3', '50', 'bottle.jpg')]);
    expect(after[0]).toBe(before[0]);
    expect(new Set(after).size).toBe(after.length);
  });
});
