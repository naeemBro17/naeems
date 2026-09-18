import type { Product, ProductVariant, VariantFormData, VariantOption } from '../types';
import type { DisplayPrice } from './pricing';

/**
 * The ONLY sanctioned variant read source. Like products_view, the view
 * returns wholesale_price only to approved wholesalers/admins; the base
 * table's column is not readable by any API role.
 */
export const VARIANTS_VIEW = 'product_variants_view';

export const VARIANT_SELECT =
  'id, product_id, region, size, retail_price, offer_price, wholesale_price, has_wholesale, in_stock, stock_quantity, image_url, note, sort_order, created_at';

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
    stock_quantity: '',
    image_url: null,
    note: '',
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
    stock_quantity:
      variant.stock_quantity !== null && variant.stock_quantity !== undefined
        ? String(variant.stock_quantity)
        : '',
    image_url: variant.image_url ?? null,
    note: variant.note ?? '',
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
  if (form.stock_quantity.trim() !== '') {
    const qty = Number(form.stock_quantity);
    if (!Number.isInteger(qty) || qty < 0) return 'Stock count must be a whole number';
  }
  return null;
}

/**
 * Whether a variant is available, same convention as Product's isInStock: a
 * tracked quantity (when set) always wins over the manual In Stock toggle,
 * and only an explicit 0 forces Out of Stock.
 */
export function isVariantInStock(variant: ProductVariant): boolean {
  if (variant.stock_quantity !== null && variant.stock_quantity !== undefined) {
    return variant.stock_quantity > 0;
  }
  return variant.in_stock;
}

/** Display label for one option: "Region · Size", just one half if only one
 *  is set, or the fallback name when the base option has neither. */
export function variantOptionLabel(option: VariantOption, fallbackName: string): string {
  const parts = [option.region, option.size].filter((p) => p.trim() !== '');
  return parts.length > 0 ? parts.join(' · ') : fallbackName;
}

/**
 * The product's own data becomes selectable option zero. Never written back
 * as a database row — purely a read-time projection so the manual Add
 * Variant flow and the "combine products" flow don't have to duplicate the
 * product's price/stock/image/note into a real variant row just to make it
 * choosable alongside the others.
 */
function baseOption(product: Product): VariantOption {
  return {
    id: product.id,
    product_id: product.id,
    region: product.region ?? '',
    size: product.size ?? '',
    retail_price: product.retail_price,
    offer_price: product.offer_price,
    wholesale_price: product.wholesale_price,
    has_wholesale: product.has_wholesale,
    in_stock: product.stock_status !== 'out_of_stock',
    stock_quantity: product.stock_quantity,
    image_url: null,
    note: product.note,
    sort_order: -1,
    created_at: product.created_at,
    isBase: true,
  };
}

/**
 * Every selectable option for a product's detail page: the product's own
 * data first, then its real variant rows in display order. Length 1 (just
 * the base) means "nothing to select between" — callers should not show a
 * selector in that case; see CLAUDE.md / Naeems.txt "PART 5" for the full
 * three-state behaviour this backs.
 */
export function variantOptionsFor(product: Product, variants: ProductVariant[]): VariantOption[] {
  const base = baseOption(product);
  const rest: VariantOption[] = variants.map((v) => ({ ...v, isBase: false }));
  return [base, ...rest];
}
