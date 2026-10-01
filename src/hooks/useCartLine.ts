import { useCallback } from 'react';
import { useCart } from '../contexts/CartContext';
import { useToast } from './useToast';
import { stockLimit } from '../lib/stockStatus';
import { trackAddToCart } from '../lib/analytics';
import type { Product, VariantOption } from '../types';

export interface CartLineControls {
  /** Units of this line in the cart right now (0 = not in the cart). */
  quantity: number;
  /** Which line the controls act on: the product itself (null) or one option. */
  variantId: string | null;
  /** Most units allowed (Infinity when stock isn't tracked). */
  limit: number;
  increment: () => void;
  decrement: () => void;
}

/** The gentle note shown when + would go past the stock count. */
export function stockLimitMessage(limit: number): string {
  return limit === 1 ? 'Only 1 in stock' : `Only ${limit} in stock`;
}

/**
 * The cart line a product card's stepper shows and changes (Batch 27 Part 3).
 * Always read from the cart itself, so every card of the same product, the
 * product page and the cart page show the same number.
 *
 * A product without options has one line. A product with options shows the
 * option most recently added this session — or, after a reload, its last
 * line in the cart.
 */
export function useCartLine(product: Product, options: VariantOption[]): CartLineControls {
  const { items, updateQuantity, lastVariantFor } = useCart();
  const { showToast } = useToast();
  const hasOptions = options.length > 1;

  let variantId: string | null = null;
  if (hasOptions) {
    const productLines = items.filter((item) => item.productId === product.id);
    const preferred = lastVariantFor(product.id);
    const preferredLine =
      preferred === undefined ? undefined : productLines.find((item) => item.variantId === preferred);
    variantId = (preferredLine ?? productLines[productLines.length - 1])?.variantId ?? null;
  }

  const line = items.find((item) => item.productId === product.id && item.variantId === variantId);
  const quantity = line?.quantity ?? 0;
  const option = hasOptions ? options.find((o) => o.id === variantId) : undefined;
  const limit = hasOptions
    ? option
      ? stockLimit(option.stock_quantity)
      : Number.POSITIVE_INFINITY
    : stockLimit(product.stock_quantity);
  const unitPrice = line?.priceAtAdd ?? 0;

  const increment = useCallback(() => {
    if (quantity >= limit) {
      showToast(stockLimitMessage(limit), 'info');
      return;
    }
    updateQuantity(product.id, quantity + 1, variantId);
    trackAddToCart({ id: product.id, name: product.name, price: unitPrice }, 1);
  }, [quantity, limit, showToast, updateQuantity, product.id, product.name, variantId, unitPrice]);

  const decrement = useCallback(() => {
    updateQuantity(product.id, quantity - 1, variantId);
  }, [updateQuantity, product.id, quantity, variantId]);

  return { quantity, variantId, limit, increment, decrement };
}
