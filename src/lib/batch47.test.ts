// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { invoiceFromOrder } from './invoice/invoiceData';
import { invoiceShop } from './invoice/invoiceShop';
import { buildInvoicePdf } from './invoice/renderInvoice';
import { isHandOverSource, sendsByCourier } from './manualOrders';
import { mockOrder } from '../../e2e/helpers/invoiceFixtures';
import { fontFilesFromDisk, pdfPageText } from '../../e2e/helpers/invoicePdf';

// Batch 47: admin and customer bug fixes. Nothing here talks to the
// database.

const fonts = fontFilesFromDisk();
const shop = invoiceShop({ shop_whatsapp_number: '8801560040012' });

describe('Batch 47 Task 4: Shop/in person orders go by hand', () => {
  it('only the shop\'s own in-person source counts as handed over', () => {
    expect(isHandOverSource('shop')).toBe(true);
    for (const s of ['web', 'facebook', 'whatsapp', 'phone', 'family', 'other'] as const) expect(isHandOverSource(s)).toBe(false);
    expect(isHandOverSource(null)).toBe(false);
  });

  it('no courier for Shop/in person or hand delivered — unless it was booked anyway', () => {
    expect(sendsByCourier({ source: 'shop', delivery_zone: 'inside_dhaka', steadfast_consignment_id: null })).toBe(false);
    expect(sendsByCourier({ source: 'family', delivery_zone: 'hand_delivered', steadfast_consignment_id: null })).toBe(false);
    expect(sendsByCourier({ source: 'facebook', delivery_zone: 'outside_dhaka', steadfast_consignment_id: null })).toBe(true);
    expect(sendsByCourier({ source: 'shop', delivery_zone: 'inside_dhaka', steadfast_consignment_id: '321957858' })).toBe(true);
  });

  it('the invoice of a Shop/in person order shows the order number and ৳0 delivery, never "Book with Steadfast"', async () => {
    const order = mockOrder({ source: 'shop', delivery_zone: 'hand_delivered', delivery_fee: 0, steadfast_consignment_id: null });
    const inv = invoiceFromOrder(order, []);
    expect(inv.byHand).toBe(true);
    expect(inv.deliveryFee).toBe(0);
    const pdf = await buildInvoicePdf([inv], shop, fonts);
    const text = (await pdfPageText(pdf.bytes, 1)).join(' ');
    expect(text).toContain(order.order_number);
    expect(text).toContain('Handed over in person');
    expect(text).not.toContain('Book with Steadfast');
  });

  it('a courier order\'s invoice is unchanged (still asks to book)', () => {
    const inv = invoiceFromOrder(mockOrder({ source: 'facebook', steadfast_consignment_id: null }), []);
    expect(inv.byHand).toBe(false);
  });
});
