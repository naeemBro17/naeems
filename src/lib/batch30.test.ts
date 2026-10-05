import { describe, expect, it } from 'vitest';
import { bdPhoneKey, looksLikePhone, phoneSearchCore } from './phone';
import { paymentStateText, summarizePayments } from './payments';
import { buildOrderChanges, draftFromOrder, draftTotals, steadfastBanner, stockProblems } from './orderEdit';
import { groupThanas, matchDistrict, snapshotThanas, toThanaEntries } from './thanas';
import { parsePoliceStations } from '../../supabase/functions/_shared/policeStations';
import { codAmountFor } from '../../supabase/functions/_shared/cod';
import type { OrderWithDetails } from '../types';

// Batch 30: phone matching (Part 4), payment maths (Part 3), the edit
// sheet's change list and the Steadfast banner (Part 2), thanas (Part 6).

describe('bdPhoneKey — the same person however the number was typed', () => {
  it('+880 / 880 / 0 / no prefix, spaces and dashes', () => {
    for (const raw of ['+880 1712-345678', '8801712345678', '01712345678', '1712345678', '017 1234 5678', '00880 1712345678']) {
      expect(bdPhoneKey(raw)).toBe('01712345678');
    }
  });
  it('empty → null; other numbers keep their digits', () => {
    expect(bdPhoneKey('')).toBeNull();
    expect(bdPhoneKey(null)).toBeNull();
    expect(bdPhoneKey('02-9876543')).toBe('029876543');
  });
  it('search core ignores the prefix; names are not phones', () => {
    expect(phoneSearchCore('+880 17123')).toBe('17123');
    expect(phoneSearchCore('017123')).toBe('17123');
    expect(looksLikePhone('+880 1712')).toBe(true);
    expect(looksLikePhone('Rahim')).toBe(false);
  });
});

describe('summarizePayments', () => {
  it('nothing paid → Unpaid, all due', () => {
    expect(summarizePayments(1000, [])).toMatchObject({ paid: 0, due: 1000, state: 'unpaid' });
  });
  it('part paid → Partly paid with the right due', () => {
    const s = summarizePayments(1000, [{ kind: 'payment', amount: 300 }]);
    expect(s).toMatchObject({ paid: 300, due: 700, state: 'partly_paid' });
    expect(paymentStateText(s, (n) => `৳${n}`)).toBe('Partly paid · ৳700 due');
  });
  it('paid in full → Paid; over-paid is shown', () => {
    expect(summarizePayments(1000, [{ kind: 'payment', amount: 400 }, { kind: 'payment', amount: 600 }])).toMatchObject({ due: 0, state: 'paid', overpaid: 0 });
    const over = summarizePayments(1000, [{ kind: 'payment', amount: 1200 }]);
    expect(over).toMatchObject({ due: 0, state: 'paid', overpaid: 200 });
  });
  it('a refund of everything → Refunded', () => {
    expect(summarizePayments(1000, [{ kind: 'payment', amount: 1000 }, { kind: 'refund', amount: 1000 }])).toMatchObject({ paid: 0, due: 1000, state: 'refunded' });
  });
});

function order(overrides: Partial<OrderWithDetails> = {}): OrderWithDetails {
  return {
    id: 'o1',
    order_number: 'NM-1',
    customer_id: null,
    customer_name: 'Rahim',
    customer_phone: '01712345678',
    division: 'Dhaka',
    district: 'Dhaka',
    thana: 'Gulshan',
    address_line: 'Road 1',
    delivery_zone: 'outside_dhaka',
    delivery_fee: 130,
    subtotal: 500,
    discount: 0,
    discount_reason: null,
    discount_note: null,
    promo_code: null,
    list_value: 500,
    free_value: 0,
    total: 630,
    payment_method: 'cod',
    bkash_trx_id: null,
    bkash_sender: null,
    payment_status: 'unpaid',
    status: 'shipped',
    source: 'web',
    tracking_number: null,
    customer_note: null,
    admin_note: null,
    steadfast_consignment_id: 'C1',
    steadfast_tracking_code: null,
    steadfast_tracking_link: null,
    steadfast_status: 'in_review',
    steadfast_status_updated_at: null,
    alt_phone: null,
    courier_note: null,
    admin_customer_id: null,
    steadfast_cod_amount: 630,
    steadfast_outdated: [],
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    items: [
      { id: 'i1', order_id: 'o1', product_id: 'p1', variant_id: null, product_name: 'Cream', variant_label: null, image_url: null, list_price: 250, unit_price: 250, quantity: 2, line_total: 500, reason: null, reason_note: null },
    ],
    history: [],
    ...overrides,
  };
}

describe('Edit order — only what changed is sent', () => {
  it('no change → nothing', () => {
    const o = order();
    expect(buildOrderChanges(o, draftFromOrder(o, () => 10))).toEqual({});
  });
  it('delivery fee to 0, thana, name, quantity and a new line', () => {
    const o = order();
    const d = draftFromOrder(o, () => 10);
    d.deliveryFee = '0';
    d.thana = 'Banani';
    d.customerName = 'Rahim Uddin';
    d.items[0].quantity = 1;
    d.items.push({ ...d.items[0], key: 'new', id: null, productId: 'p2', productName: 'Wash', quantity: 2, originalQuantity: 0, listPrice: 300, unitPrice: 300, originalUnitPrice: 300 });
    const c = buildOrderChanges(o, d);
    expect(c).toMatchObject({ delivery_fee: 0, thana: 'Banani', customer_name: 'Rahim Uddin' });
    expect(c.items).toEqual([
      { id: 'i1', quantity: 1 },
      { product_id: 'p2', variant_id: null, quantity: 2 },
    ]);
    expect(draftTotals(d)).toMatchObject({ subtotal: 850, deliveryFee: 0, total: 850 });
  });
  it('a removed line is left out of the list', () => {
    const o = order({
      items: [
        ...order().items,
        { id: 'i2', order_id: 'o1', product_id: 'p2', variant_id: null, product_name: 'Wash', variant_label: null, image_url: null, list_price: 300, unit_price: 300, quantity: 1, line_total: 300, reason: null, reason_note: null },
      ],
    });
    const d = draftFromOrder(o, () => 10);
    d.items = d.items.filter((i) => i.id !== 'i2');
    expect(buildOrderChanges(o, d).items).toEqual([{ id: 'i1', quantity: 2 }]);
  });
  it('never more than the shop has; nothing to check on a cancelled order', () => {
    const o = order();
    const d = draftFromOrder(o, () => 1);
    d.items[0].quantity = 5;
    expect(stockProblems(d, true).get('i1')).toBe(3);
    expect(stockProblems(d, false).size).toBe(0);
  });
});

describe('Steadfast banner', () => {
  const pay = (due: number) => summarizePayments(630, due === 630 ? [] : [{ kind: 'payment', amount: 630 - due }]);
  it('nothing to do → no banner', () => {
    expect(steadfastBanner(order(), pay(630))).toBeNull();
  });
  it('changed details are listed', () => {
    expect(steadfastBanner(order({ steadfast_outdated: ['Name', 'Address'] }), pay(630))).toEqual({ fields: ['Name', 'Address'], codShouldBe: null });
  });
  it('a payment after booking → "COD should now be" the due', () => {
    expect(steadfastBanner(order(), pay(130))?.codShouldBe).toBe(130);
  });
  it('not booked, delivered, or COD unknown → no COD banner', () => {
    expect(steadfastBanner(order({ steadfast_consignment_id: null }), pay(130))).toBeNull();
    expect(steadfastBanner(order({ status: 'delivered' }), pay(130))).toBeNull();
    expect(steadfastBanner(order({ steadfast_cod_amount: null }), pay(130))).toBeNull();
  });
});

describe('thanas', () => {
  it('the snapshot is the full bundled list', () => {
    const list = snapshotThanas();
    expect(list.length).toBe(559);
    expect(new Set(list.map((t) => t.district)).size).toBe(64);
  });
  it('Steadfast district spellings match the site’s districts', () => {
    expect(matchDistrict('Chittagong')).toBe('Chattogram');
    expect(matchDistrict('Bogra')).toBe('Bogura');
    expect(matchDistrict('Jessore')).toBe('Jashore');
    expect(matchDistrict('Cumilla')).toBe('Comilla');
    expect(matchDistrict("Cox's Bazar")).toBe('Coxsbazar');
    expect(matchDistrict('Jhalokati')).toBe('Jhalakathi');
    expect(matchDistrict('Barishal')).toBe('Barisal');
    expect(matchDistrict('Narayangonj')).toBe('Narayanganj');
    expect(matchDistrict('Dhaka City')).toBe('Dhaka');
    expect(matchDistrict('Dhaka Sub-Urban')).toBe('Dhaka');
    expect(matchDistrict('Narshindi')).toBe('Narsingdi');
    expect(matchDistrict('Nowhere')).toBeNull();
  });
  it('grouped by district A–Z, the chosen district first, searchable', () => {
    const list = toThanaEntries([
      { name: 'Mirpur', district: 'Dhaka' },
      { name: 'Banani', district: 'Dhaka' },
      { name: 'Kotwali', district: 'Chittagong' },
      { name: 'Kotwali', district: 'Bogra' },
    ]);
    const all = groupThanas(list, '', null);
    expect(all.map((g) => g.district)).toEqual(['Bogura', 'Chattogram', 'Dhaka']);
    expect(all[2].thanas).toEqual(['Banani', 'Mirpur']);
    expect(groupThanas(list, '', 'Dhaka').map((g) => g.district)).toEqual(['Dhaka']);
    const search = groupThanas(list, 'kot', 'Dhaka');
    expect(search.map((g) => g.district)).toEqual(['Bogura', 'Chattogram']);
  });
  it('reads the common /police_stations shapes', () => {
    expect(parsePoliceStations([{ id: 1, name: 'Gulshan', district: 'Dhaka' }])).toEqual([{ name: 'Gulshan', district: 'Dhaka' }]);
    expect(parsePoliceStations({ data: [{ police_station: 'Banani', district: { name: 'Dhaka' } }] })).toEqual([{ name: 'Banani', district: 'Dhaka' }]);
    expect(parsePoliceStations({ status: 200, police_stations: [{ thana_name: 'Kotwali', district_name: 'Feni' }, { thana_name: 'Kotwali', district_name: 'Feni' }] })).toEqual([{ name: 'Kotwali', district: 'Feni' }]);
    expect(parsePoliceStations({ message: 'no' })).toEqual([]);
  });
});

describe('Steadfast COD = what is still due', () => {
  it('with payments recorded: the due, never the full total', () => {
    expect(codAmountFor({ payment_status: 'unpaid', total: 1060 }, 760)).toBe(760);
    expect(codAmountFor({ payment_status: 'unpaid', total: 1060 }, 0)).toBe(0);
    expect(codAmountFor({ payment_status: 'unpaid', total: 1060 }, -50)).toBe(0);
  });
  it('before migration-033 (no payments): the old rule', () => {
    expect(codAmountFor({ payment_status: 'unpaid', total: 1060 }, null)).toBe(1060);
    expect(codAmountFor({ payment_status: 'paid', total: 1060 }, null)).toBe(0);
  });
});

describe('police_stations: one row per district with its thanas nested', () => {
  it('flattens to thana + district', () => {
    expect(
      parsePoliceStations({
        status: 200,
        data: [
          { id: 1, name: 'Bagerhat', police_stations: [{ id: 10, name: 'Mongla' }, { id: 11, name: 'Rampal' }] },
          { id: 2, name: 'Dhaka', thanas: [{ id: 20, name: 'Gulshan' }] },
        ],
      })
    ).toEqual([
      { name: 'Mongla', district: 'Bagerhat' },
      { name: 'Rampal', district: 'Bagerhat' },
      { name: 'Gulshan', district: 'Dhaka' },
    ]);
  });
});
