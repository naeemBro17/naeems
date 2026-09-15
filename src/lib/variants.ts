import type { ProductVariant, VariantFormData } from '../types';
import type { DisplayPrice } from './pricing';

/**
 * The ONLY sanctioned variant read source. Like products_view, the view
 * returns wholesale_price only to approved wholesalers/admins; the base
 * table's column is not readable by any API role.
 */
export const VARIANTS_VIEW = 'product_variants_view';

export const VARIANT_SELECT =
  'id, product_id, region, size, retail_price, offer_price, wholesale_price, has_wholesale, in_stock, sort_order, created_at';

/** Variants of one product in display order. */
export function sortVariants(variants: ProductVariant[]): ProductVariant[] {
  return [...variants].sort(
    (a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at)
  );
}

/** Distinct regions in the order they first appear. */
export function regionsOf(variants: ProductVariant[]): string[] {
  const seen = new Set<string>();
  const regions: string[] = [];
  for (const v of variants) {
    if (!seen.has(v.region)) {
      seen.add(v.region);
      regions.push(v.region);
    }
  }
  return regions;
}

/** Display pricing for one variant — same rules as getDisplayPrice(). */
export function variantDisplayPrice(variant: ProductVariant): DisplayPrice {
  if (variant.offer_price !== null && variant.offer_price < variant.retail_price) {
    const savePercent = Math.round(
      ((variant.retail_price - variant.offer_price) / variant.retail_price) * 100
    );
    return { mainPrice: variant.offer_price, strikePrice: variant.retail_price, savePercent };
  }
  return { mainPrice: variant.retail_price, strikePrice: null, savePercent: null };
}

/**
 * The "from" price a card shows for a product with variants: the lowest
 * offer price across them, or the lowest retail price when no variant has
 * an offer. Null when there are no variants.
 */
export function lowestVariantPrice(variants: ProductVariant[]): number | null {
  if (variants.length === 0) return null;
  const offers = variants
    .map((v) => v.offer_price)
    .filter((p): p is number => p !== null);
  if (offers.length > 0) return Math.min(...offers);
  return Math.min(...variants.map((v) => v.retail_price));
}

export function emptyVariantForm(): VariantFormData {
  return {
    region: '',
    size: '',
    retail_price: '',
    offer_price: '',
    wholesale_price: '',
    in_stock: true,
  };
}

export function variantToForm(variant: ProductVariant): VariantFormData {
  return {
    region: variant.region,
    size: variant.size,
    retail_price: String(variant.retail_price),
    offer_price: variant.offer_price !== null ? String(variant.offer_price) : '',
    wholesale_price:
      variant.wholesale_price !== null && variant.wholesale_price !== undefined
        ? String(variant.wholesale_price)
        : '',
    in_stock: variant.in_stock,
  };
}

/** First problem with a variant form, or null when it can be saved. */
export function validateVariantForm(form: VariantFormData): string | null {
  if (form.region.trim() === '') return 'Region is required';
  if (form.size.trim() === '') return 'Size is required';
  const retail = Number(form.retail_price);
  if (form.retail_price.trim() === '' || Number.isNaN(retail) || retail < 0) {
    return 'Enter a retail price of 0 or more';
  }
  if (form.offer_price.trim() !== '') {
    const offer = Number(form.offer_price);
    if (Number.isNaN(offer) || offer < 0) return 'Enter a valid offer price';
    if (offer >= retail) return 'Offer price must be lower than the retail price';
  }
  if (form.wholesale_price.trim() !== '') {
    const wholesale = Number(form.wholesale_price);
    if (Number.isNaN(wholesale) || wholesale < 0) return 'Enter a valid wholesale price';
  }
  return null;
}
