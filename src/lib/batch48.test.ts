import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  advanceLineLabel,
  advanceOfferActive,
  advanceOfferBadge,
  advancePreview,
  advanceRuleFromSettings,
  computeAdvanceDiscount,
  orderDiscountParts,
  promoDiscountRounded,
  type AdvanceDiscountRule,
} from './advanceDiscount';
import { computePromoDiscount } from './promoCodes';
import { PAY_ON_DELIVERY_LABEL, placedPaymentLabel, placedTotalLabel } from './checkoutCopy';
import { buildOrderChanges, draftFromOrder, draftTotals } from './orderEdit';
import { legacyPaymentMethod } from './paymentPlan';
import { advanceValueError } from '../components/admin/AdvanceDiscountPanel';
import type { OrderWithDetails } from '../types';

const percent = (value: number): AdvanceDiscountRule => ({ enabled: true, type: 'percent', value });
const fixed = (value: number): AdvanceDiscountRule => ({ enabled: true, type: 'fixed', value });

describe('Batch 48 — the advance-payment discount maths', () => {
  it('percent: round(base × value / 100) to the nearest taka', () => {
    expect(computeAdvanceDiscount(percent(0.5), 950, 'bkash')).toBe(5); // 4.75 -> 5
    expect(computeAdvanceDiscount(percent(0.5), 1000, 'nagad')).toBe(5);
    expect(computeAdvanceDiscount(percent(0.5), 899, 'bkash')).toBe(4); // 4.495 -> 4
    expect(computeAdvanceDiscount(percent(2), 1250, 'nagad')).toBe(25);
  });

  it('fixed: the value, on bKash and Nagad alike', () => {
    expect(computeAdvanceDiscount(fixed(50), 950, 'bkash')).toBe(50);
    expect(computeAdvanceDiscount(fixed(50), 950, 'nagad')).toBe(50);
  });

  it('fixed larger than the base: never more than the base', () => {
    expect(computeAdvanceDiscount(fixed(500), 300, 'bkash')).toBe(300);
    expect(computeAdvanceDiscount(fixed(50), 0, 'bkash')).toBe(0);
  });

  it('promo code first, then the advance discount on what is left (delivery never discounted)', () => {
    const subtotal = 950;
    const promo = promoDiscountRounded(computePromoDiscount({ code: 'WELCOME50', discountType: 'fixed', discountAmount: 50 }, subtotal));
    expect(promo).toBe(50);
    const advance = computeAdvanceDiscount(percent(0.5), subtotal - promo, 'bkash');
    expect(advance).toBe(5); // 0.5% of 900 = 4.5 -> 5
    const delivery = 70;
    expect(subtotal + delivery - promo - advance).toBe(965);

    const pct = promoDiscountRounded(computePromoDiscount({ code: 'TEN', discountType: 'percent', discountAmount: 10 }, 999));
    expect(pct).toBe(99.9);
    expect(computeAdvanceDiscount(percent(0.5), 999 - pct, 'nagad')).toBe(4); // 899.1 × 0.5% = 4.4955 -> 4
  });

  it('Off, or value 0: nothing, and the offer disappears', () => {
    const off: AdvanceDiscountRule = { enabled: false, type: 'percent', value: 0.5 };
    expect(computeAdvanceDiscount(off, 1000, 'bkash')).toBe(0);
    expect(advanceOfferActive(off)).toBe(false);
    expect(computeAdvanceDiscount(percent(0), 1000, 'bkash')).toBe(0);
    expect(advanceOfferActive(percent(0))).toBe(false);
    expect(advanceOfferActive(fixed(0))).toBe(false);
  });

  it('Cash on Delivery gets nothing', () => {
    expect(computeAdvanceDiscount(percent(0.5), 1000, 'cod')).toBe(0);
    expect(computeAdvanceDiscount(fixed(50), 1000, 'cod')).toBe(0);
  });

  it('reads the settings; anything broken counts as Off (like the database)', () => {
    expect(advanceRuleFromSettings({ advance_discount_enabled: 'true', advance_discount_type: 'percent', advance_discount_value: '0.5' })).toEqual(percent(0.5));
    expect(advanceRuleFromSettings({ advance_discount_enabled: 'true', advance_discount_type: 'fixed', advance_discount_value: '50' })).toEqual(fixed(50));
    // Before migration-049: no type row -> Off.
    expect(advanceRuleFromSettings({ advance_discount_enabled: 'false', advance_discount_type: '', advance_discount_value: '0' }).enabled).toBe(false);
    expect(advanceRuleFromSettings({ advance_discount_enabled: 'true', advance_discount_type: 'percent', advance_discount_value: 'abc' }).enabled).toBe(false);
    expect(advanceRuleFromSettings({ advance_discount_enabled: 'true', advance_discount_type: 'percent', advance_discount_value: '150' }).enabled).toBe(false);
  });

  it('badge, line label and the admin preview', () => {
    expect(advanceOfferBadge(percent(0.5))).toBe('0.5% OFF');
    expect(advanceOfferBadge(fixed(50))).toBe('৳50 OFF');
    expect(advanceLineLabel('percent', 0.5)).toBe('Advance payment 0.5%');
    expect(advanceLineLabel('fixed', 50)).toBe('Advance payment discount');
    expect(advancePreview({ type: 'percent', value: 0.5 })).toBe('On a ৳1,000 order the customer saves ৳5.');
    expect(advancePreview({ type: 'fixed', value: 50 })).toBe('The customer saves ৳50 on every bKash or Nagad order.');
  });

  it('the admin value check', () => {
    expect(advanceValueError('percent', '0.5')).toBeNull();
    expect(advanceValueError('percent', '0')).toBeNull();
    expect(advanceValueError('percent', '101')).toBe('A percent can be at most 100.');
    expect(advanceValueError('fixed', '50')).toBeNull();
    expect(advanceValueError('fixed', '50.5')).toBe('Enter whole taka.');
    expect(advanceValueError('fixed', '-5')).toBe('Enter a number (0 or more).');
  });
});

function webOrder(overrides: Partial<OrderWithDetails> = {}): OrderWithDetails {
  return {
    id: 'o1',
    order_number: 'NM-4801',
    customer_id: 'c1',
    customer_name: 'Ashraful',
    customer_phone: '01700000000',
    division: 'Dhaka',
    district: 'Dhaka',
    thana: 'Gulshan',
    address_line: 'Road 1',
    delivery_zone: 'inside_dhaka',
    delivery_fee: 70,
    subtotal: 950,
    discount: 55,
    discount_reason: null,
    discount_note: null,
    promo_code: 'WELCOME50',
    list_value: 950,
    free_value: 0,
    total: 965,
    payment_method: 'bkash',
    bkash_trx_id: 'TRX48',
    bkash_sender: '01800000000',
    advance_discount: 5,
    advance_discount_type: 'percent',
    advance_discount_value: 0.5,
    payment_status: 'pending_verification',
    status: 'pending',
    source: 'web',
    tracking_number: null,
    customer_note: null,
    admin_note: null,
    steadfast_consignment_id: null,
    steadfast_tracking_code: null,
    steadfast_tracking_link: null,
    steadfast_status: null,
    steadfast_status_updated_at: null,
    alt_phone: null,
    courier_note: null,
    admin_customer_id: null,
    steadfast_cod_amount: null,
    steadfast_outdated: [],
    collect_mode: 'cod',
    created_at: '2026-11-18T00:00:00Z',
    updated_at: '2026-11-18T00:00:00Z',
    items: [
      {
        id: 'i1',
        order_id: 'o1',
        product_id: 'p1',
        variant_id: null,
        product_name: 'Centella Ampoule',
        variant_label: null,
        image_url: null,
        list_price: 950,
        unit_price: 950,
        quantity: 1,
        line_total: 950,
        reason: null,
        reason_note: null,
      },
    ],
    history: [],
    ...overrides,
  } as OrderWithDetails;
}

describe('Batch 48 — the stored order (discount = promo + advance)', () => {
  it('splits the whole discount into the promo part and the advance part', () => {
    expect(orderDiscountParts({ discount: 55, advance_discount: 5 })).toEqual({ other: 50, advance: 5 });
    expect(orderDiscountParts({ discount: 50, advance_discount: 0 })).toEqual({ other: 50, advance: 0 });
    // Never more advance than the whole discount.
    expect(orderDiscountParts({ discount: 3, advance_discount: 5 })).toEqual({ other: 0, advance: 3 });
  });

  it('Edit order: the discount box holds only the promo part; nothing changes when nothing is touched', () => {
    const order = webOrder();
    const draft = draftFromOrder(order, () => null);
    expect(draft.discount).toBe('50');
    expect(draft.advanceDiscount).toBe(5);
    expect(buildOrderChanges(order, draft)).toEqual({});
    expect(draftTotals(draft).total).toBe(965);
  });

  it('Edit order: bKash -> Cash on Delivery takes the advance discount off; bKash <-> Nagad keeps it', () => {
    const order = webOrder();
    const draft = draftFromOrder(order, () => null);
    const toCod = { ...draft, paymentMethod: 'cod' as const };
    expect(draftTotals(toCod)).toMatchObject({ discount: 50, advanceDiscount: 0, total: 970 });
    // The payment method is saved first; the discount itself is unchanged.
    expect(buildOrderChanges(order, toCod)).toEqual({});
    const toNagad = { ...draft, paymentMethod: 'nagad' as const };
    expect(draftTotals(toNagad).total).toBe(965);
    expect(buildOrderChanges(order, toNagad)).toEqual({});
  });

  it('Edit order: a new promo / hand discount is sent together with the advance part', () => {
    const order = webOrder();
    const draft = { ...draftFromOrder(order, () => null), discount: '100' };
    expect(buildOrderChanges(order, draft)).toEqual({ discount: 105 });
    expect(buildOrderChanges(order, { ...draft, paymentMethod: 'cod' })).toEqual({ discount: 100 });
  });
});

describe('Batch 48 — wording and Nagad everywhere bKash is', () => {
  it('Pay on delivery (English) replaces the Bengali label', () => {
    expect(PAY_ON_DELIVERY_LABEL).toBe('Pay on delivery');
    expect(placedTotalLabel('cod')).toBe('Pay on delivery');
    expect(placedTotalLabel('bkash')).toBe('Total paid');
    expect(placedTotalLabel('nagad')).toBe('Total paid');
    expect(placedPaymentLabel('bkash')).toBe('bKash (paid in advance)');
    expect(placedPaymentLabel('nagad')).toBe('Nagad (paid in advance)');
    expect(placedPaymentLabel('cod')).toBe('Cash on Delivery');
    for (const file of ['src/features/checkout/OrderSummaryPage.tsx', 'src/features/checkout/OrderSuccessPage.tsx', 'src/pages/OrderDetailPage.tsx', 'src/lib/checkoutCopy.ts']) {
      expect(readFileSync(file, 'utf8')).not.toContain('ডেলিভারিতে');
    }
  });

  it('a fully paid Nagad order is saved as a Nagad order', () => {
    expect(legacyPaymentMethod({ total: 1000, paidNow: 1000, method: 'nagad', mode: 'cod' })).toBe('nagad');
    expect(legacyPaymentMethod({ total: 1000, paidNow: 1000, method: 'bkash', mode: 'cod' })).toBe('bkash');
  });

  it('migration-049: Nagad allowed, the discount worked out in the database, never touching promo counting', () => {
    const sql = readFileSync('supabase/migration-049-batch48.sql', 'utf8');
    expect(sql).toContain("ARRAY['cod'::text, 'bkash'::text, 'nagad'::text, 'cash'::text, 'due'::text]");
    expect(sql).toContain("IF p_payment_method NOT IN ('cod', 'bkash', 'nagad') THEN");
    expect(sql).toContain('FROM advance_discount_amount(p_payment_method, v_subtotal - v_discount) a;');
    // The advance discount never calls the promo counter.
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.advance_discount_amount'), sql.indexOf('REVOKE ALL ON FUNCTION public.advance_discount_amount'));
    expect(fn).not.toContain('times_used');
    expect(fn).not.toContain('increment_promo_usage');
    expect(sql).toContain("SELECT 'Nagad', 'nagad', 'nagad', 4");
    expect(sql).toContain("WHEN 'nagad' THEN 'Nagad advance'");
  });
});
