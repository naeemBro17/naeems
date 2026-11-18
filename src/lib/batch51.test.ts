import { describe, expect, it } from 'vitest';
import {
  arrivalText,
  cartBuyAfterNote,
  deliveryLine,
  limitReason,
  limitTitle,
  lowStockText,
  maxQuantity,
  moreThanLimitMessage,
  orderLimit,
  parseDays,
  shopStock,
} from './sellRules';
import { clockParts } from './adminClock';
import { greeting } from './adminNav';
import { shoppingRowName, shoppingTotals, toShoppingRows } from './shoppingList';
import { balanceLine, coveredByOpening, payoutPill, type PayoutItem } from './payouts';

const settings = {
  order_limit_per_item: '4',
  delivery_time_dhaka: '1–2 days',
  delivery_time_outside: '2–3 days',
  delivery_time_buy_after: '3–5 days',
};

describe('Batch 51 Part 1: the order limit', () => {
  it('reads the setting (4 when blank or not a number, at least 1)', () => {
    expect(orderLimit(settings)).toBe(4);
    expect(orderLimit({ order_limit_per_item: '6' })).toBe(6);
    expect(orderLimit({ order_limit_per_item: '' })).toBe(4);
    expect(orderLimit({ order_limit_per_item: 'abc' })).toBe(4);
    expect(orderLimit({ order_limit_per_item: '0' })).toBe(4);
  });

  it('switch ON: a customer may have the limit, whatever the stock', () => {
    expect(maxQuantity({ keepSelling: true, stock: null }, 4, 'customer')).toBe(4);
    expect(maxQuantity({ keepSelling: true, stock: 0 }, 4, 'customer')).toBe(4);
    expect(maxQuantity({ keepSelling: true, stock: 20 }, 4, 'customer')).toBe(4);
  });

  it('switch OFF: the smaller of the stock and the limit', () => {
    expect(maxQuantity({ keepSelling: false, stock: 2 }, 4, 'customer')).toBe(2);
    expect(maxQuantity({ keepSelling: false, stock: 10 }, 4, 'customer')).toBe(4);
    expect(maxQuantity({ keepSelling: false, stock: 0 }, 4, 'customer')).toBe(0);
    expect(maxQuantity({ keepSelling: false, stock: null }, 4, 'customer')).toBe(4);
  });

  it('wholesalers have no limit (switch OFF: up to the stock)', () => {
    expect(maxQuantity({ keepSelling: true, stock: null }, 4, 'wholesaler')).toBe(Number.POSITIVE_INFINITY);
    expect(maxQuantity({ keepSelling: false, stock: 7 }, 4, 'wholesaler')).toBe(7);
    expect(maxQuantity({ keepSelling: false, stock: null }, 4, 'wholesaler')).toBe(Number.POSITIVE_INFINITY);
  });

  it('the popup: "Limit 4 per order", or the last of the stock', () => {
    expect(limitTitle(limitReason({ keepSelling: true, stock: null }, 4))).toBe('Limit 4 per order');
    expect(limitTitle(limitReason({ keepSelling: false, stock: 9 }, 4))).toBe('Limit 4 per order');
    expect(limitTitle(limitReason({ keepSelling: false, stock: 4 }, 4))).toBe('Limit 4 per order');
    expect(limitTitle(limitReason({ keepSelling: false, stock: 3 }, 4))).toBe("You've got the last 3!");
    expect(limitTitle(limitReason({ keepSelling: false, stock: 1 }, 4))).toBe("You've got the last one!");
    expect(limitTitle(limitReason({ keepSelling: true, stock: null }, 6))).toBe('Limit 6 per order');
  });

  it('the WhatsApp message names the product and option', () => {
    expect(moreThanLimitMessage(4, 'Avène Thermal Spring Water', '300 ml')).toBe(
      "Hi! I'd like more than 4 of Avène Thermal Spring Water 300 ml."
    );
    expect(moreThanLimitMessage(4, 'Cetaphil Cleanser', null)).toBe("Hi! I'd like more than 4 of Cetaphil Cleanser.");
  });

  it('"Only N left — order soon" only for switch OFF with 1 to the limit left', () => {
    expect(lowStockText({ keepSelling: false, stock: 2 }, 4)).toBe('Only 2 left — order soon');
    expect(lowStockText({ keepSelling: false, stock: 4 }, 4)).toBe('Only 4 left — order soon');
    expect(lowStockText({ keepSelling: false, stock: 5 }, 4)).toBeNull();
    expect(lowStockText({ keepSelling: false, stock: 0 }, 4)).toBeNull();
    expect(lowStockText({ keepSelling: true, stock: 2 }, 4)).toBeNull();
    expect(lowStockText({ keepSelling: false, stock: null }, 4)).toBeNull();
    expect(shopStock({ keepSelling: false, stock: 2 }, true, 4)).toBe('low');
    expect(shopStock({ keepSelling: true, stock: null }, true, 4)).toBe('in');
    expect(shopStock({ keepSelling: false, stock: 0 }, false, 4)).toBe('out');
  });
});

describe('Batch 51 Part 2: delivery times', () => {
  it('the product page line follows the selected option', () => {
    expect(deliveryLine(settings, { available: true, inHand: true })).toBe(
      'Get it in 1–2 days in Dhaka · 2–3 days outside Dhaka'
    );
    expect(deliveryLine(settings, { available: true, inHand: false })).toBe('Get it in 3–5 days');
    expect(deliveryLine(settings, { available: false, inHand: false })).toBeNull();
    expect(deliveryLine({ ...settings, delivery_time_buy_after: '4–6 days' }, { available: true, inHand: false })).toBe(
      'Get it in 4–6 days'
    );
    expect(deliveryLine({}, { available: true, inHand: true })).toBe('Get it in 1–2 days in Dhaka · 2–3 days outside Dhaka');
    expect(cartBuyAfterNote(settings)).toBe('Get it in 3–5 days');
  });

  it('reads the days from the setting', () => {
    expect(parseDays('1–2 days')).toEqual([1, 2]);
    expect(parseDays('2-3 days')).toEqual([2, 3]);
    expect(parseDays('3 days')).toEqual([3, 3]);
    expect(parseDays('soon')).toBeNull();
  });

  // Thursday 19 November 2026, 10:00 in Dhaka.
  const placed = '2026-11-19T04:00:00Z';

  it('"Arriving …": Dhaka in stock, outside Dhaka, and bought after the order', () => {
    expect(arrivalText(placed, 'inside_dhaka', false, settings)).toBe('Arriving Fri, 20 – Sat, 21 Nov');
    expect(arrivalText(placed, 'outside_dhaka', false, settings)).toBe('Arriving Sat, 21 – Sun, 22 Nov');
    expect(arrivalText(placed, 'inside_dhaka', true, settings)).toBe('Arriving Sun, 22 – Tue, 24 Nov');
    expect(arrivalText(placed, 'outside_dhaka', true, settings)).toBe('Arriving Sun, 22 – Tue, 24 Nov');
  });

  it('"Arriving …" across a month, and in Dhaka time', () => {
    // Thursday 26 November 2026 + 3–5 days → Sun 29 Nov – Tue 1 Dec.
    expect(arrivalText('2026-11-26T06:00:00Z', 'inside_dhaka', true, settings)).toBe('Arriving Sun, 29 Nov – Tue, 1 Dec');
    // 01:30 on Friday 20 November in Dhaka (still the 19th in UTC).
    expect(arrivalText('2026-11-19T19:30:00Z', 'inside_dhaka', false, settings)).toBe('Arriving Sat, 21 – Sun, 22 Nov');
    expect(arrivalText(placed, 'inside_dhaka', false, { ...settings, delivery_time_dhaka: '2 days' })).toBe(
      'Arriving Sat, 21 Nov'
    );
  });
});

describe('Batch 51 Part 3: the Shopping list', () => {
  const raw = [
    { product_id: 'b', variant_id: null, product_name: 'Sunscreen', option_label: null, qty: 2, unit: null, orders: [{ id: 'o2', number: 'NM-3920' }, { id: 'o1', number: 'NM-3901' }] },
    { product_id: 'a', variant_id: 'v', product_name: 'Aloe Gel', option_label: 'AU · 240ml', qty: '3', unit: null, orders: [{ id: 'o3', number: 'NM-3911' }] },
    { product_id: 'c', variant_id: null, product_name: 'Covered', option_label: null, qty: 0, unit: null, orders: [] },
  ];

  it('one row per option still to buy, by name, order numbers in order; covered rows drop out', () => {
    const rows = toShoppingRows(raw);
    expect(rows.map((r) => shoppingRowName(r))).toEqual(['Aloe Gel — AU · 240ml', 'Sunscreen']);
    expect(rows[1].orders.map((o) => o.number)).toEqual(['NM-3901', 'NM-3920']);
    expect(shoppingTotals(rows)).toEqual({ items: 2, units: 5 });
    expect(shoppingTotals([])).toEqual({ items: 0, units: 0 });
  });
});

describe('Batch 51 Part 5: greeting and clock', () => {
  it('Good morning 05:00–11:59, afternoon 12:00–16:59, evening 17:00–04:59 (Dhaka)', () => {
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 19, h - 6, m));
    expect(greeting(at(5))).toBe('Good morning');
    expect(greeting(at(11, 59))).toBe('Good morning');
    expect(greeting(at(12))).toBe('Good afternoon');
    expect(greeting(at(16, 59))).toBe('Good afternoon');
    expect(greeting(at(17))).toBe('Good evening');
    expect(greeting(at(23, 30))).toBe('Good evening');
    expect(greeting(at(26))).toBe('Good evening'); // 02:00
    expect(greeting(at(28, 59))).toBe('Good evening'); // 04:59
  });

  it('the clock is 12-hour without AM/PM, minutes and seconds two digits', () => {
    expect(clockParts(new Date('2026-11-19T14:42:37Z'))).toEqual({ hours: '8', minutes: '42', seconds: '37' });
    expect(clockParts(new Date('2026-11-19T18:05:09Z'))).toEqual({ hours: '12', minutes: '05', seconds: '09' });
    expect(clockParts(new Date('2026-11-19T06:00:00Z'))).toEqual({ hours: '12', minutes: '00', seconds: '00' });
    expect(clockParts(new Date('2026-11-19T07:01:00Z'))).toEqual({ hours: '1', minutes: '01', seconds: '00' });
  });
});

describe('Batch 51 Part 6: Steadfast', () => {
  const outside = (id: string): PayoutItem => ({
    id,
    payout_id: 'p',
    consignment_id: null,
    invoice: null,
    order_id: null,
    cod_collected: 500,
    delivery_charge: 60,
    cod_fee: 5,
    other_deduction: 0,
    net_paid: 435,
    expected_cod: null,
    match_status: 'to_check',
    match_reason: 'order_not_found',
    note: null,
    line_kind: 'order',
  });
  const site: PayoutItem = { ...outside('s'), invoice: 'NM-3301', order_id: 'o', match_status: 'matched', match_reason: null };
  const cancelled: PayoutItem = { ...outside('c'), invoice: 'NM-3302', order_id: 'o2', match_reason: 'order_cancelled' };

  it('"Booked on Steadfast" payouts from before the money start date read "Matched"', () => {
    const old = { paid_at: '2026-10-03T08:00:00Z', items: [outside('a'), outside('b')] };
    expect(payoutPill(old, '2026-11-13')).toEqual({ tone: 'green', text: 'Matched' });
    expect(payoutPill(old, null)).toEqual({ tone: 'grey', text: 'Booked on Steadfast' });
    const after = { paid_at: '2026-11-14T08:00:00Z', items: [outside('a')] };
    expect(payoutPill(after, '2026-11-13')).toEqual({ tone: 'grey', text: 'Booked on Steadfast' });
    expect(payoutPill({ paid_at: '2026-11-01T08:00:00Z', items: [site] }, '2026-11-13')).toEqual({ tone: 'green', text: 'Matched' });
  });

  it('a payout with a real problem keeps its tag, even before the start date', () => {
    const old = { paid_at: '2026-10-03T08:00:00Z', items: [outside('a'), cancelled] };
    expect(payoutPill(old, '2026-11-13')).toEqual({ tone: 'amber', text: '1 to check' });
  });

  it('the start date is a Dhaka day', () => {
    expect(coveredByOpening('2026-11-12T19:00:00Z', '2026-11-13')).toBe(false); // 01:00 on the 13th in Dhaka
    expect(coveredByOpening('2026-11-12T17:00:00Z', '2026-11-13')).toBe(true); // 23:00 on the 12th
    expect(coveredByOpening(null, '2026-11-13')).toBe(false);
  });

  it('the balance line never contradicts the amount', () => {
    expect(balanceLine(0, 3)).toBe('Nothing waiting from Steadfast');
    expect(balanceLine(0, 0)).toBe('Nothing waiting from Steadfast');
    expect(balanceLine(4181, 3)).toBe('From 3 delivered orders');
    expect(balanceLine(950, 1)).toBe('From 1 delivered order');
    expect(balanceLine(950, 0)).toBe('Waiting from Steadfast');
  });
});
