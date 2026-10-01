import { describe, expect, it } from 'vitest';
import { brandCategories, brandKey, brandLogoFor, brandSlugify, brandsWithProducts, homeBrands, productCountLabel } from './brands';
import type { Brand, Category, Product } from '../types';

function brand(id: string, over: Partial<Brand> = {}): Brand {
  return {
    id,
    name: id,
    slug: id,
    logo_url: null,
    logo_dark_url: null,
    banner_image_url: null,
    banner_video_url: null,
    banner_youtube_url: null,
    show_on_home: true,
    display_order: 0,
    updated_at: '2026-10-01T00:00:00Z',
    updated_by: null,
    ...over,
  };
}

function product(id: string, brandId: string | null, categoryId: string | null = null): Product {
  return { id, brand_id: brandId, category_id: categoryId, is_active: true } as Product;
}

describe('brand names and links', () => {
  it('matches spellings the way the database does', () => {
    expect(brandKey('CERAVE')).toBe(brandKey('CeraVe'));
    expect(brandKey('La Roche Posay')).toBe(brandKey('La Roche-Posay'));
    expect(brandKey('Avène')).toBe('avene');
  });

  it('makes links like the database', () => {
    expect(brandSlugify('La Roche-Posay')).toBe('la-roche-posay');
    expect(brandSlugify("Paula's Choice")).toBe('paulas-choice');
    expect(brandSlugify("L'Oréal")).toBe('loreal');
    expect(brandSlugify('Geek & Gorgeous')).toBe('geek-gorgeous');
  });

  it('counts products in words', () => {
    expect(productCountLabel(1)).toBe('1 product');
    expect(productCountLabel(12)).toBe('12 products');
  });
});

describe('Home row', () => {
  it('only brands with Show on home AND a live product, in the admin order', () => {
    const brands = [
      brand('b', { display_order: 2 }),
      brand('a', { display_order: 1 }),
      brand('off', { show_on_home: false, display_order: 0 }),
      brand('empty', { display_order: 3 }),
    ];
    const products = [product('1', 'a'), product('2', 'b'), product('3', 'off')];
    expect(homeBrands(brands, products).map((b) => b.id)).toEqual(['a', 'b']);
    expect(brandsWithProducts(brands, products).map((b) => b.id)).toEqual(['off', 'a', 'b']);
  });
});

describe('logo version', () => {
  it('light mode: normal logo on a light card', () => {
    expect(brandLogoFor({ logo_url: 'n.webp', logo_dark_url: 'w.webp' }, 'light')).toEqual({ src: 'n.webp', tone: 'light' });
  });
  it('dark mode: white logo on a dark card', () => {
    expect(brandLogoFor({ logo_url: 'n.webp', logo_dark_url: 'w.webp' }, 'dark')).toEqual({ src: 'w.webp', tone: 'dark' });
  });
  it('dark mode without a white logo: normal logo on a light card', () => {
    expect(brandLogoFor({ logo_url: 'n.webp', logo_dark_url: null }, 'dark')).toEqual({ src: 'n.webp', tone: 'light' });
  });
  it('no logo at all: the name as text', () => {
    expect(brandLogoFor({ logo_url: null, logo_dark_url: null }, 'dark').src).toBeNull();
  });
});

describe('brand page chips', () => {
  it('only the categories the brand has products in, in shop order', () => {
    const cats = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] as Category[];
    expect(brandCategories(cats, [product('1', 'a', 'c3'), product('2', 'a', 'c1')]).map((c) => c.id)).toEqual(['c1', 'c3']);
  });
});
