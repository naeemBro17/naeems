import { useMemo } from 'react';
import { useProducts } from '../contexts/ProductContext';
import { useSellLimit } from './useSellLimit';
import { getDisplayPrice } from '../lib/pricing';
import { cardImage, coverImage, smallImageFor } from '../lib/productImages';
import { lowStockText, type StockFacts } from '../lib/sellRules';
import { isOutOfStock } from '../lib/stockStatus';
import { isVariantInStock, variantDisplayPrice, variantOptionLabel } from '../lib/variants';
import type { ComboItem, PricedComboLine } from '../lib/combos';
import type { Product, ProductVariant } from '../types';

/** One combo line with today's price and stock (Batch 52). */
export interface LiveComboLine extends PricedComboLine {
  key: string;
  product: Product;
  /** The cart line's option id as saved (null = no option). */
  variantId: string | null;
  /** The chosen option's row (null = the product itself). */
  variant: ProductVariant | null;
  /** "AU · 340g" when an option was chosen. */
  optionLabel: string | null;
  /** Small photo for lists. */
  thumb: string | null;
  /** Full photo for the collage. */
  photo: string | null;
  /** "Only 2 left — order soon" (Batch 51 wording), else null. */
  lowText: string | null;
  facts: StockFacts;
}

/**
 * Saved combo lines → live lines, in the combo's order. Lines whose product
 * is gone or hidden from the shop are left out. Prices are the shop's
 * normal ones (the offer, else retail) — the same the cart adds at.
 */
export function useComboLines(items: readonly ComboItem[]): LiveComboLine[] {
  const { products, variantsFor } = useProducts();
  const sell = useSellLimit();

  return useMemo(() => {
    const byId = new Map(products.filter((p) => p.is_active).map((p) => [p.id, p]));
    return items.flatMap((item, index): LiveComboLine[] => {
      const product = byId.get(item.product_id);
      if (!product) return [];
      const ownOption = item.variant_id === null || item.variant_id === product.id;
      const variant = ownOption ? null : variantsFor(product.id).find((v) => v.id === item.variant_id) ?? null;
      // A chosen option that was deleted since: leave the line out rather
      // than sell a different option by mistake.
      if (!ownOption && variant === null) return [];
      const shown = variant ? variantDisplayPrice(variant) : getDisplayPrice(product);
      const retail = variant ? variant.retail_price : product.retail_price;
      const available = variant ? isVariantInStock(variant) : !isOutOfStock(product);
      const facts = sell.factsFor(product, variant);
      const photo = variant?.image_url ?? coverImage(product);
      const thumb = variant?.image_url ? smallImageFor(variant.image_url, product, [variant]) : cardImage(product);
      const optionLabel =
        variant !== null
          ? variantOptionLabel({ ...variant, isBase: false }, product.name)
          : item.variant_id === product.id && (product.region || product.size)
            ? [product.region, product.size].filter((p) => p && p.trim() !== '').join(' · ')
            : null;
      return [
        {
          key: `${index}-${product.id}-${item.variant_id ?? ''}`,
          product,
          variantId: item.variant_id,
          variant,
          optionLabel,
          thumb,
          photo,
          price: shown.mainPrice,
          retail,
          quantity: item.quantity,
          available,
          lowText: available ? lowStockText(facts, sell.limit) : null,
          facts,
        },
      ];
    });
  }, [items, products, variantsFor, sell]);
}
