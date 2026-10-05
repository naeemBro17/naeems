import { describe, expect, it } from 'vitest';
import { computeManualOrderTotals, computeMonthlySummary, lineNeedsReason, parseStockWarning } from './manualOrders';
import type { Order } from '../types';

function makeOrder(overrides: Partial<Order>): Order {
  return {
    id: 'id',
    order_number: 'NM-1',
    customer_id: null,
    customer_name: 'Test',
    customer_phone: '01700000000',
    division: 'Dhaka',
    district: 'Dhaka',
    thana: 'Gulshan',
    address_line: 'Address',
    delivery_zone: 'inside_dhaka',
    delivery_fee: 70,
    subtotal: 1000,
    discount: 0,
    discount_reason: null,
    discount_note: null,
    promo_code: null,
    list_value: 1000,
    free_value: 0,
    total: 1070,
    payment_method: 'cod',
    bkash_trx_id: null,
    bkash_sender: null,
    payment_status: 'unpaid',
    status: 'confirmed',
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('computeManualOrderTotals', () => {
  it('charges full price with no discount when nothing is reduced', () => {
    const totals = computeManualOrderTotals(
      [{ listPrice: 500, soldPrice: 500, quantity: 2 }],
      0,
      70
    );
    expect(totals.subtotal).toBe(1000);
    expect(totals.listValue).toBe(1000);
    expect(totals.freeValue).toBe(0);
    expect(totals.lineDiscount).toBe(0);
    expect(totals.total).toBe(1070);
  });

  it('tracks a reduced-price line (e.g. ৳1500 item sold at ৳700) as a line discount, not free value', () => {
    const totals = computeManualOrderTotals(
      [{ listPrice: 1500, soldPrice: 700, quantity: 1 }],
      0,
      70
    );
    expect(totals.subtotal).toBe(700);
    expect(totals.listValue).toBe(1500);
    expect(totals.freeValue).toBe(0);
    expect(totals.lineDiscount).toBe(800);
    expect(totals.total).toBe(770);
  });

  it('tracks a free line as free value, not as subtotal or line discount', () => {
    const totals = computeManualOrderTotals(
      [{ listPrice: 300, soldPrice: 0, quantity: 1 }],
      0,
      0
    );
    expect(totals.subtotal).toBe(0);
    expect(totals.freeValue).toBe(300);
    expect(totals.lineDiscount).toBe(0);
    expect(totals.total).toBe(0);
  });

  it('combines multiple lines (full price, reduced, and free) correctly', () => {
    const totals = computeManualOrderTotals(
      [
        { listPrice: 500, soldPrice: 500, quantity: 1 }, // full price
        { listPrice: 1000, soldPrice: 600, quantity: 1 }, // reduced by 400
        { listPrice: 200, soldPrice: 0, quantity: 2 }, // free, value 400
      ],
      0,
      70
    );
    expect(totals.subtotal).toBe(1100); // 500 + 600 + 0
    expect(totals.listValue).toBe(1900); // 500 + 1000 + 400
    expect(totals.freeValue).toBe(400);
    expect(totals.lineDiscount).toBe(400); // 1900 - 1100 - 400
    expect(totals.total).toBe(1170);
  });

  it('applies a flat order-level discount on top of line-level pricing', () => {
    const totals = computeManualOrderTotals(
      [{ listPrice: 1000, soldPrice: 1000, quantity: 1 }],
      150,
      70
    );
    expect(totals.orderDiscount).toBe(150);
    expect(totals.total).toBe(920); // 1000 + 70 - 150
  });

  it('never lets the total go below zero', () => {
    const totals = computeManualOrderTotals(
      [{ listPrice: 100, soldPrice: 100, quantity: 1 }],
      1000,
      0
    );
    expect(totals.total).toBe(0);
  });

  it('clamps a negative order discount to zero rather than adding to the total', () => {
    const totals = computeManualOrderTotals(
      [{ listPrice: 100, soldPrice: 100, quantity: 1 }],
      -50,
      0
    );
    expect(totals.orderDiscount).toBe(0);
    expect(totals.total).toBe(100);
  });

  it('ignores a negative quantity or sold price rather than reducing the total', () => {
    const totals = computeManualOrderTotals(
      [{ listPrice: 500, soldPrice: -100, quantity: -3 }],
      0,
      0
    );
    expect(totals.subtotal).toBe(0);
    expect(totals.total).toBe(0);
  });
});

describe('lineNeedsReason', () => {
  it('is true when sold price is below list price', () => {
    expect(lineNeedsReason(1500, 700)).toBe(true);
  });

  it('is true when the line is free', () => {
    expect(lineNeedsReason(300, 0)).toBe(true);
  });

  it('is false at full price', () => {
    expect(lineNeedsReason(500, 500)).toBe(false);
  });
});

describe('parseStockWarning', () => {
  it('parses a well-formed STOCK_WARNING error message', () => {
    const message =
      'STOCK_WARNING:[{"product_name":"Retinol Serum","variant_label":null,"available":2,"requested":5}]';
    const warnings = parseStockWarning(message);
    expect(warnings).toEqual([
      { product_name: 'Retinol Serum', variant_label: null, available: 2, requested: 5 },
    ]);
  });

  it('returns null for an unrelated error message', () => {
    expect(parseStockWarning('Customer name is required.')).toBeNull();
  });

  it('returns null when the prefix matches but the payload is not valid JSON', () => {
    expect(parseStockWarning('STOCK_WARNING:not json')).toBeNull();
  });
});

describe('computeMonthlySummary', () => {
  const now = new Date('2026-09-27T12:00:00Z');

  it('counts an in-month order and tallies its source', () => {
    const summary = computeMonthlySummary(
      [makeOrder({ created_at: '2026-09-10T12:00:00Z', source: 'facebook' })],
      now
    );
    expect(summary.orderCount).toBe(1);
    expect(summary.totalSales).toBe(1070);
    expect(summary.bySource.facebook).toBe(1);
    expect(summary.bySource.web).toBe(0);
  });

  it('excludes orders from a different month', () => {
    const summary = computeMonthlySummary(
      [makeOrder({ created_at: '2026-08-15T12:00:00Z' })],
      now
    );
    expect(summary.orderCount).toBe(0);
    expect(summary.totalSales).toBe(0);
  });

  it('excludes cancelled orders even when placed this month', () => {
    const summary = computeMonthlySummary(
      [makeOrder({ created_at: '2026-09-10T12:00:00Z', status: 'cancelled' })],
      now
    );
    expect(summary.orderCount).toBe(0);
  });

  it('separates line discount from free value and adds the order-level discount', () => {
    const order = makeOrder({
      created_at: '2026-09-05T12:00:00Z',
      subtotal: 600, // one reduced line (700 sold at 600... see list_value below) + one free line
      list_value: 1500, // 1000 (reduced from 1000 to 600, i.e. -400) + 500 (free line)
      free_value: 500,
      discount: 50, // flat order-level discount
      total: 620, // 600 + 70 delivery - 50
    });
    const summary = computeMonthlySummary([order], now);
    // line discount = list_value(1500) - subtotal(600) - free_value(500) = 400
    expect(summary.totalDiscount).toBe(450); // 400 line discount + 50 order discount
    expect(summary.freeValue).toBe(500);
  });

  it('sums across multiple orders', () => {
    const summary = computeMonthlySummary(
      [
        makeOrder({ created_at: '2026-09-01T12:00:00Z', source: 'shop', total: 500 }),
        makeOrder({ created_at: '2026-09-15T12:00:00Z', source: 'shop', total: 300 }),
        makeOrder({ created_at: '2026-09-20T12:00:00Z', source: 'whatsapp', total: 200 }),
      ],
      now
    );
    expect(summary.orderCount).toBe(3);
    expect(summary.totalSales).toBe(1000);
    expect(summary.bySource.shop).toBe(2);
    expect(summary.bySource.whatsapp).toBe(1);
  });
});
