// Shared type definitions for the cart & checkout flow. Read by every screen
// (CartPage, DeliveryDetailsPage, OrderSummaryPage, OrderSuccessPage) and by
// useCheckoutState, which is the single source of truth these types describe.
// PromoCode itself is defined in the global types module (the admin Promo
// Codes panel manages the same rows outside the checkout flow) and is just
// re-exported here so this file stays the one-stop import for the feature.
import type { Product, PromoCode } from '../../types';

export type { PromoCode };

/** One cart line resolved against the product catalog for display. */
export interface CartItem {
  product: Product;
  quantity: number;
  /** Unit price captured when the item was added; immune to later price edits. */
  unitPrice: number;
  variantId: string | null;
  /** e.g. "AU · 340g" — snapshot label, shown in cart/summary/WhatsApp/PDF. */
  variantLabel: string | null;
  /** The selected variant's own photo, if it has one; null falls back to the
   *  product's own cover image (coverImage(product)) wherever a thumbnail is
   *  shown — the variant may have been deleted since, so this is resolved
   *  live from the current variant list, not stored with the cart line. */
  variantImage: string | null;
}

export type DeliveryZoneId = 'inside_dhaka' | 'outside_dhaka';

export interface DeliveryZoneOption {
  id: DeliveryZoneId;
  label: string;
  fee: number;
}

/** The only two delivery zones the shop offers. Order also drives display order. */
export const DELIVERY_ZONES: DeliveryZoneOption[] = [
  { id: 'inside_dhaka', label: 'Inside Dhaka', fee: 80 },
  { id: 'outside_dhaka', label: 'Outside Dhaka', fee: 130 },
];

export interface DeliveryAddress {
  fullName: string;
  phone: string;
  division: string;
  district: string;
  thana: string;
  fullAddress: string;
}

export function emptyDeliveryAddress(): DeliveryAddress {
  return { fullName: '', phone: '', division: '', district: '', thana: '', fullAddress: '' };
}

/** A promo code currently applied to the order, plus its computed discount. */
export interface AppliedPromo {
  code: string;
  discountType: PromoCode['discount_type'];
  discountAmount: number;
  /** Taka discount for the current subtotal, already clamped to it. */
  computedDiscount: number;
}

/**
 * A finalized order, captured the instant "Pay and Order" is tapped. This is
 * what OrderSuccessPage renders and exports — it survives the live cart
 * being cleared once the customer reaches that screen.
 */
export interface OrderSnapshot {
  items: CartItem[];
  zone: DeliveryZoneOption;
  address: DeliveryAddress;
  promo: AppliedPromo | null;
  subtotal: number;
  discount: number;
  total: number;
  placedAt: string;
}
