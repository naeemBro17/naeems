import type { Brand, Category, Product } from '../types';

/* Brands (Batch 26). The brands table is public to read; products point to
   their brand by id (products.brand_id, migration-032) and the database
   keeps the old products.brand text in step, so a rename reaches every
   card, product page and search at once. */

export const BRANDS_TABLE = 'brands';

export const BRAND_SELECT =
  'id, name, slug, logo_url, logo_dark_url, banner_image_url, banner_video_url, banner_youtube_url, show_on_home, display_order, updated_at, updated_by';

/** A link part like "la-roche-posay" — what the database accepts. */
export const BRAND_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function brandPath(brand: Pick<Brand, 'slug'>): string {
  return `/brand/${brand.slug}`;
}

function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Same as the database's brand_slugify(): "Paula's Choice" -> "paulas-choice". */
export function brandSlugify(name: string): string {
  return foldAccents(name.toLowerCase())
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Same as the database's brand_key(): "CERAVE" and "Cera-Ve" are one brand. */
export function brandKey(name: string): string {
  return foldAccents(name.toLowerCase()).replace(/[^a-z0-9]/g, '');
}

/** The admin's order (display_order), then A–Z. */
export function sortBrands(brands: Brand[]): Brand[] {
  return [...brands].sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
}

/** How many products each brand has. Pass only the products that count
 *  (the shop counts live products; the admin counts all). */
export function productCountsByBrand(products: Product[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of products) {
    if (!p.brand_id) continue;
    counts.set(p.brand_id, (counts.get(p.brand_id) ?? 0) + 1);
  }
  return counts;
}

/** Home's "Shop by Brand" row: "Show on home" on AND at least one live
 *  product, in the admin's order. */
export function homeBrands(brands: Brand[], activeProducts: Product[]): Brand[] {
  const counts = productCountsByBrand(activeProducts);
  return sortBrands(brands).filter((b) => b.show_on_home && (counts.get(b.id) ?? 0) > 0);
}

/** The /brands page: every brand with at least one live product. */
export function brandsWithProducts(brands: Brand[], activeProducts: Product[]): Brand[] {
  const counts = productCountsByBrand(activeProducts);
  return sortBrands(brands).filter((b) => (counts.get(b.id) ?? 0) > 0);
}

export interface BrandLogo {
  /** null = no logo yet: show the name as text. */
  src: string | null;
  /** The card behind it. */
  tone: 'light' | 'dark';
}

/**
 * Which logo, on which card. Light mode: the normal logo on a white card.
 * Dark mode: the white logo on a dark card — or, without a white logo, the
 * normal logo on a light card (a dark logo on a dark card would vanish).
 * No logo at all: the name as text on the theme's own card.
 */
export function brandLogoFor(brand: Pick<Brand, 'logo_url' | 'logo_dark_url'>, theme: 'light' | 'dark'): BrandLogo {
  if (theme === 'dark') {
    if (brand.logo_dark_url) return { src: brand.logo_dark_url, tone: 'dark' };
    if (brand.logo_url) return { src: brand.logo_url, tone: 'light' };
    return { src: null, tone: 'dark' };
  }
  return { src: brand.logo_url, tone: 'light' };
}

/** "12 products" / "1 product". */
export function productCountLabel(count: number): string {
  return `${count} product${count === 1 ? '' : 's'}`;
}

/** The categories a brand has live products in, in the shop's category
 *  order — the brand page's chips. */
export function brandCategories(categories: Category[], brandProducts: Product[]): Category[] {
  const used = new Set(brandProducts.map((p) => p.category_id).filter((id): id is string => id !== null));
  return categories.filter((c) => used.has(c.id));
}
