import type { Product } from '../types';
import { displayCampaign, floorPercent, saleFor, type DisplayCampaign } from './campaigns';

/** Resolved display pricing for a product. */
export interface DisplayPrice {
  /** The price shown as the main, prominent figure. */
  mainPrice: number;
  /** Regular price to show struck through, or null when there's no active offer. */
  strikePrice: number | null;
  /** Whole-number discount percentage, or null when there's no active offer. */
  savePercent: number | null;
  /** Batch 66: set when the price comes from a live campaign. */
  campaign?: DisplayCampaign;
}

/**
 * Single source of truth for which price a product displays.
 * When offer_price is set (and below retail, enforced by the DB constraint),
 * the offer becomes the main price, retail is struck through, and a save
 * percentage is derived. Otherwise retail_price is shown plainly.
 *
 * Batch 66: a product in a live campaign shows its sale price (the lower of
 * the sale and the offer), retail struck through, the % rounded down — the
 * same number place_order_core() charges (src/lib/campaigns.ts).
 */
export function getDisplayPrice(product: Product): DisplayPrice {
  const sale = saleFor(product.id, null, product.retail_price, product.offer_price);
  if (sale) return saleDisplayPrice(sale.price, product.retail_price, displayCampaign(sale.campaign));
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

/** A campaign price: sale price main, retail struck, the % rounded down. */
export function saleDisplayPrice(price: number, retail: number, campaign: DisplayCampaign): DisplayPrice {
  if (price >= retail) return { mainPrice: price, strikePrice: null, savePercent: null, campaign };
  return { mainPrice: price, strikePrice: retail, savePercent: floorPercent(retail, price), campaign };
}
