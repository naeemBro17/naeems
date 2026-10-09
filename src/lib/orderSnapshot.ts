import type { OrderWithDetails } from '../types';
import type { AppliedPromo, CartItem, DeliveryZoneOption } from '../features/checkout/types';

/** Reuses the existing PDF builder, which expects a checkout OrderSnapshot —
 *  this reshapes a saved Order into that same shape rather than duplicating
 *  the PDF layout code for admin's "Download invoice". */
export function toOrderSnapshot(order: OrderWithDetails) {
  const items: CartItem[] = order.items.map((item) => ({
    product: {
      id: item.product_id ?? item.id,
      name: item.product_name,
    } as CartItem['product'],
    quantity: item.quantity,
    unitPrice: item.unit_price,
    variantId: item.variant_id,
    variantLabel: item.variant_label,
    variantImage: null,
    listPrice: item.list_price,
    discountReason: item.reason,
  }));
  const zone: DeliveryZoneOption = {
    id: order.delivery_zone,
    label:
      order.delivery_zone === 'inside_dhaka'
        ? 'Inside Dhaka'
        : order.delivery_zone === 'outside_dhaka'
          ? 'Outside Dhaka'
          : 'Hand delivered',
    fee: order.delivery_fee,
  };
  const promo: AppliedPromo | null = order.promo_code
    ? {
        code: order.promo_code,
        discountType: 'fixed',
        discountAmount: order.discount,
        computedDiscount: order.discount,
      }
    : null;
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    items,
    zone,
    address: {
      fullName: order.customer_name,
      phone: order.customer_phone,
      division: order.division,
      district: order.district,
      thana: order.thana,
      fullAddress: order.address_line,
    },
    promo,
    subtotal: order.subtotal,
    discount: order.discount,
    total: order.total,
    paymentMethod: order.payment_method,
    bkashTrxId: order.bkash_trx_id,
    placedAt: order.created_at,
    orderDiscountReason: order.discount_reason,
  };
}
