import { cardImage } from './productImages';
import type { Product, ProductVariant } from '../types';

/**
 * Batch 45 Part 4: Admin → New order's product search. Each product shows
 * once. A product without options is one option (tap = add). A product with
 * options has its own size first (no option id — the product row, like the
 * shop's first option), then each option with its own price and stock.
 */
export interface SellableOption {
  productId: string;
  variantId: string | null;
  key: string;
  label: string;
  productName: string;
  variantLabel: string | null;
  imageUrl: string | null;
  listPrice: number;
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

function sizeLabel(region: string | null | undefined, size: string | null | undefined): string {
  return [region, size].map((s) => (s ?? '').trim()).filter(Boolean).join(' · ');
}

export function productSearchGroups(products: readonly Product[], variantsFor: (productId: string) => ProductVariant[]): SellableProduct[] {
  const groups: SellableProduct[] = [];
  for (const p of products) {
    if (!p.is_active) continue;
    const variants = variantsFor(p.id);
    const ownLabel = variants.length > 0 ? sizeLabel(p.region, p.size) : '';
    const own: SellableOption = {
      productId: p.id,
      variantId: null,
      key: p.id,
      label: ownLabel ? `${p.name} — ${ownLabel}` : p.name,
      productName: p.name,
      variantLabel: ownLabel || null,
      imageUrl: cardImage(p),
      listPrice: currentPrice(p.retail_price, p.offer_price),
      stockQuantity: p.stock_quantity,
    };
    const options = [
      own,
      ...variants.map((v): SellableOption => {
        const label = sizeLabel(v.region, v.size);
        return {
          productId: p.id,
          variantId: v.id,
          key: `${p.id}::${v.id}`,
          label: label ? `${p.name} — ${label}` : p.name,
          productName: p.name,
          variantLabel: label || null,
          imageUrl: v.image_url ?? cardImage(p),
          listPrice: currentPrice(v.retail_price, v.offer_price),
          stockQuantity: v.stock_quantity,
        };
      }),
    ];
    groups.push({ productId: p.id, name: p.name, options });
  }
  return groups;
}
