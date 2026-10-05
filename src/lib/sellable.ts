import { useMemo } from 'react';
import { useProducts } from '../contexts/ProductContext';
import { cardImage } from './productImages';

/** One thing that can go on an order: a product, or one of its options. */
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

function currentPrice(retailPrice: number, offerPrice: number | null): number {
  return offerPrice !== null && offerPrice < retailPrice ? offerPrice : retailPrice;
}

/**
 * Every active product / option with its price and tracked stock — the
 * Batch 30 Edit order sheet's "Add a product" list (the same rule the New
 * order form uses: the offer price when lower than retail).
 */
export function useSellableOptions(): {
  options: SellableOption[];
  stockFor: (productId: string | null, variantId: string | null) => number | null;
} {
  const { products, variantsFor } = useProducts();
  return useMemo(() => {
    const options: SellableOption[] = [];
    const stock = new Map<string, number | null>();
    for (const p of products) {
      const variants = variantsFor(p.id);
      stock.set(p.id, p.stock_quantity);
      for (const v of variants) stock.set(`${p.id}::${v.id}`, v.stock_quantity);
      if (!p.is_active) continue;
      if (variants.length === 0) {
        options.push({
          productId: p.id,
          variantId: null,
          key: p.id,
          label: p.name,
          productName: p.name,
          variantLabel: null,
          imageUrl: cardImage(p),
          listPrice: currentPrice(p.retail_price, p.offer_price),
          stockQuantity: p.stock_quantity,
        });
      } else {
        for (const v of variants) {
          const variantLabel = [v.region, v.size].filter(Boolean).join(' · ');
          options.push({
            productId: p.id,
            variantId: v.id,
            key: `${p.id}::${v.id}`,
            label: variantLabel ? `${p.name} — ${variantLabel}` : p.name,
            productName: p.name,
            variantLabel: variantLabel || null,
            imageUrl: v.image_url ?? cardImage(p),
            listPrice: currentPrice(v.retail_price, v.offer_price),
            stockQuantity: v.stock_quantity,
          });
        }
      }
    }
    const stockFor = (productId: string | null, variantId: string | null): number | null => {
      if (!productId) return null;
      const value = stock.get(variantId ? `${productId}::${variantId}` : productId);
      return value === undefined ? null : value;
    };
    return { options, stockFor };
  }, [products, variantsFor]);
}
