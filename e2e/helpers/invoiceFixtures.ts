import type { OrderItem, OrderWithDetails } from '../../src/types';
import type { OrderPayment } from '../../src/lib/payments';

// Batch 37: made-up orders for the invoice tests (unit and e2e). Nothing
// here is a real customer or order.

let seq = 0;

function item(name: string, price: number, quantity = 1, listPrice = price): OrderItem {
  seq += 1;
  return {
    id: `item-${seq}`,
    order_id: 'o',
    product_id: `p-${seq}`,
    variant_id: null,
    product_name: name,
    variant_label: null,
    image_url: null,
    list_price: listPrice,
    unit_price: price,
    quantity,
    line_total: price * quantity,
    reason: listPrice > price ? 'promotion' : null,
    reason_note: null,
  };
}

export function payment(amount: number, method: OrderPayment['method'], kind: OrderPayment['kind'] = 'payment'): OrderPayment {
  seq += 1;
  return {
    id: `pay-${seq}`,
    order_id: 'o',
    kind,
    amount,
    method,
    trx_id: null,
    paid_at: '2026-10-06T08:00:00Z',
    note: null,
    source: method === 'cod_steadfast' ? 'steadfast_cod' : 'manual',
    created_by_username: 'naeem',
    updated_by_username: null,
  };
}

export function mockOrder(overrides: Partial<OrderWithDetails> & { items?: OrderItem[] } = {}): OrderWithDetails {
  const items = overrides.items ?? [
    item('Aveeno Baby Daily Moisture Fragrance Free Lotion 227g', 1999),
    item('Aveeno Baby Daily Moisture Lightly Scented Wash & Shampoo 236ml', 1950),
  ];
  const subtotal = items.reduce((n, i) => n + i.line_total, 0);
  const deliveryFee = overrides.delivery_fee ?? 130;
  const discount = overrides.discount ?? 0;
  return {
    id: 'order-1721',
    order_number: 'NM-1721',
    customer_id: null,
    customer_name: 'Masum',
    customer_phone: '01850078600',
    division: 'Dhaka',
    district: 'Narsingdi',
    thana: 'Palash',
    address_line: 'Village Paisaka, Ghorashal',
    delivery_zone: 'outside_dhaka',
    delivery_fee: deliveryFee,
    subtotal,
    discount,
    discount_reason: null,
    discount_note: null,
    promo_code: null,
    list_value: subtotal,
    free_value: 0,
    total: subtotal + deliveryFee - discount,
    payment_method: 'cod',
    bkash_trx_id: null,
    bkash_sender: null,
    payment_status: 'unpaid',
    status: 'shipped',
    source: 'facebook',
    tracking_number: 'SFR261006ST41291B0BD',
    customer_note: null,
    admin_note: null,
    steadfast_consignment_id: '305263110',
    steadfast_tracking_code: 'SFR261006ST41291B0BD',
    steadfast_tracking_link: null,
    steadfast_status: 'in_review',
    steadfast_status_updated_at: null,
    alt_phone: null,
    courier_note: null,
    admin_customer_id: null,
    steadfast_cod_amount: null,
    steadfast_outdated: [],
    collect_mode: 'cod',
    created_at: '2026-10-06T06:00:00Z',
    updated_at: '2026-10-06T06:00:00Z',
    history: [],
    ...overrides,
    items,
  } as OrderWithDetails;
}

/** The seven cases the batch asks for, with their payments. */
export function invoiceCases(): Record<string, { order: OrderWithDetails; payments: OrderPayment[] }> {
  const normal = mockOrder();
  const payLater = mockOrder({ order_number: 'NM-1722', collect_mode: 'pay_later', customer_name: 'Rafiq Hasan' });
  const paid = mockOrder({ order_number: 'NM-1723', payment_status: 'paid', customer_name: 'Sadia Rahman' });
  const advance = mockOrder({ order_number: 'NM-1724', customer_name: 'Tanvir Ahmed' });
  const longItems = Array.from({ length: 16 }, (_, i) =>
    item(
      i % 3 === 0
        ? `CeraVe Hydrating Facial Cleanser for Normal to Dry Skin with Hyaluronic Acid ${i + 1} — 473ml family size`
        : `QV Skin Lotion ${i + 1} 250g`,
      850 + i * 25,
      1 + (i % 2)
    )
  );
  const long = mockOrder({ order_number: 'NM-1725', items: longItems, customer_name: 'Nusrat Jahan', discount: 200 });
  const bengali = mockOrder({
    order_number: 'NM-1726',
    customer_name: 'মোছাঃ শ্রাবন্তী আক্তার',
    customer_phone: '+8801712345678',
    address_line: 'বাড়ি ১২, রোড ৫, ক্ষেতলাল বাজার, কৃষ্ণপুর',
    thana: 'ক্ষেতলাল',
    district: 'জয়পুরহাট',
    items: [item('Bioderma Sensibio H2O মাইসেলার ওয়াটার 250ml', 1650, 2)],
  });
  const notBooked = mockOrder({
    order_number: 'NM-1727',
    status: 'confirmed',
    steadfast_consignment_id: null,
    steadfast_tracking_code: null,
    tracking_number: null,
    customer_name: 'Imran Hossain',
  });
  return {
    normal: { order: normal, payments: [] },
    payLater: { order: payLater, payments: [] },
    paid: { order: paid, payments: [payment(paid.total, 'bkash')] },
    advance: { order: advance, payments: [payment(1000, 'bkash'), payment(500, 'nagad')] },
    long: { order: long, payments: [] },
    bengali: { order: bengali, payments: [] },
    notBooked: { order: notBooked, payments: [] },
  };
}
