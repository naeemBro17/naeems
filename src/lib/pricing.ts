import type { Product } from '../types';

/** Resolved display pricing for a product. */
export interface DisplayPrice {
  /** The price shown as the main, prominent figure. */
  mainPrice: number;
  /** Regular price to show struck through, or null when there's no active offer. */
  strikePrice: number | null;
  /** Whole-number discount percentage, or null when there's no active offer. */
  savePercent: number | null;
}

/**
 * Single source of truth for which price a product displays.
 * When offer_price is set (and below retail, enforced by the DB constraint),
 * the offer becomes the main price, retail is struck through, and a save
 * percentage is derived. Otherwise retail_price is shown plainly.
 */
export function getDisplayPrice(product: Product): DisplayPrice {
  if (product.offer_price !== null && product.offer_price < product.retail_price) {
    const savePercent = Math.round(
      ((product.retail_price - product.offer_price) / product.retail_price) * 100
    );
    return {
      mainPrice: product.offer_price,
      strikePrice: product.retail_price,
      savePercent,
    };
  }
  return { mainPrice: product.retail_price, strikePrice: null, savePercent: null };
}
