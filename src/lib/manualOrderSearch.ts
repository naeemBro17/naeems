import { cardImage, coverImage, isSmallCopy } from './productImages';
import { normalizeText } from './format';
import { variantOptionLabel, variantOptionsFor } from './variants';
import type { Product, ProductVariant } from '../types';

/**
 * Batch 45 Part 4: Admin → New order's product search. Each product shows
 * once. A product without options is one option (tap = add). A product with
 * options has its own size first (no option id — the product row, like the
 * shop's first option), then each option with its own price and stock.
 *
 * Batch 47: the sizes come from the shop's own product-page list
 * (variantOptionsFor), so the admin pickers (New order and Edit order) offer
 * exactly what a customer can pick, in the same order and with the same
 * names.
 */
export interface SellableOption {
  productId: string;
  variantId: string | null;
  key: string;
  label: string;
  productName: string;
  variantLabel: string | null;
  imageUrl: string | null;
  /** Batch 63: the small copy of the size's (else the product's) photo, or
   *  null when there is no small copy yet. Never the full-size photo. */
  thumbUrl: string | null;
  listPrice: number;
  /** Batch 63: the option's own retail price (struck through when the
   *  offer price is lower). */
  retailPrice: number;
  stockQuantity: number | null;
}

export interface SellableProduct {
  productId: string;
  name: string;
  options: SellableOption[];
}

function currentPrice(retailPrice: number, offerPrice: number | null): number {
  return offerPrice !== null && offerPrice < retailPrice ? offerPrice : retailPrice;
}

/** Batch 63: a small copy only (thumb/ or card/ folder), else null. */
function smallOnly(full: string | null | undefined, small: string | null | undefined): string | null {
  return isSmallCopy(full, small) ? (small as string) : null;
}

export function productSearchGroups(products: readonly Product[], variantsFor: (productId: string) => ProductVariant[]): SellableProduct[] {
  const groups: SellableProduct[] = [];
  for (const p of products) {
    if (!p.is_active) continue;
    const all = variantOptionsFor(p, variantsFor(p.id));
    const hasChoice = all.length > 1;
    const productThumb = smallOnly(coverImage(p), p.image_urls_thumb?.[0]);
    const options = all.map((o): SellableOption => {
      // A product with no options is just its name (no size label).
      const label = hasChoice ? variantOptionLabel(o, '') : '';
      return {
        productId: p.id,
        variantId: o.isBase ? null : o.id,
        key: o.isBase ? p.id : `${p.id}::${o.id}`,
        label: label ? `${p.name} — ${label}` : p.name,
        productName: p.name,
        variantLabel: label || null,
        imageUrl: o.image_url ?? cardImage(p),
        thumbUrl: o.image_url ? (smallOnly(o.image_url, o.image_url_thumb) ?? productThumb) : productThumb,
        listPrice: currentPrice(o.retail_price, o.offer_price),
        retailPrice: o.retail_price,
        stockQuantity: o.stock_quantity,
      };
    });
    groups.push({ productId: p.id, name: p.name, options });
  }
  return groups;
}

/** Products whose name (or one of whose sizes) matches the search. */
export function searchProductGroups(groups: readonly SellableProduct[], query: string, limit = 20): SellableProduct[] {
  const term = normalizeText(query.trim());
  if (term === '') return [];
  return groups
    .filter((p) => normalizeText(p.name).includes(term) || p.options.some((o) => normalizeText(o.label).includes(term)))
    .slice(0, limit);
}
