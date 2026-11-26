import { useCallback, useState } from 'react';
import { useCart } from '../contexts/CartContext';
import { useSellLimit } from './useSellLimit';
import { trackAddToCart } from '../lib/analytics';
import type { LimitReason } from '../lib/sellRules';
import type { Product, VariantOption } from '../types';

export interface CartLineControls {
  /** Units of this line in the cart right now (0 = not in the cart). */
  quantity: number;
  /** Which line the controls act on: the product itself (null) or one option. */
  variantId: string | null;
  /** The option's label for the limit popup's WhatsApp message. */
  optionLabel: string | null;
  /** Most units allowed (Batch 51: the order limit, or the stock). */
  limit: number;
  /** One more; true when it was added (false: the limit popup opened). */
  increment: () => boolean;
  decrement: () => void;
  /** Why + stopped, while the limit popup is open. */
  popup: LimitReason | null;
  closePopup: () => void;
}

/**
 * The cart line a product card's stepper shows and changes (Batch 27 Part 3).
 * Always read from the cart itself, so every card of the same product, the
 * product page and the cart page show the same number.
 *
 * A product without options has one line. A product with options shows the
 * option most recently added this session — or, after a reload, its last
 * line in the cart.
 *
 * Batch 51: + stops at the order limit (or the last of the stock for a
 * product that sells only from stock) and opens the limit popup.
 */
export function useCartLine(product: Product, options: VariantOption[]): CartLineControls {
  const { items, updateQuantity, lastVariantFor } = useCart();
  const sell = useSellLimit();
  const [popup, setPopup] = useState<LimitReason | null>(null);
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
  const facts = sell.factsFor(product, hasOptions ? option ?? null : null);
  const limit = hasOptions && !option ? Number.POSITIVE_INFINITY : sell.maxFor(facts);
  const unitPrice = line?.priceAtAdd ?? 0;
  const reason = sell.reasonFor(facts);

  const increment = useCallback(() => {
    if (quantity >= limit) {
      setPopup(reason);
      return false;
    }
    updateQuantity(product.id, quantity + 1, variantId);
    trackAddToCart({ id: product.id, name: product.name, price: unitPrice }, 1);
    return true;
  }, [quantity, limit, reason, updateQuantity, product.id, product.name, variantId, unitPrice]);

  const decrement = useCallback(() => {
    setPopup(null);
    updateQuantity(product.id, quantity - 1, variantId);
  }, [updateQuantity, product.id, quantity, variantId]);

  const closePopup = useCallback(() => setPopup(null), []);

  return {
    quantity,
    variantId,
    optionLabel: line?.variantLabel ?? null,
    limit,
    increment,
    decrement,
    popup,
    closePopup,
  };
}
