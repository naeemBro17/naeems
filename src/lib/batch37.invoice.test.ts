// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fontkit from '@pdf-lib/fontkit';
import { amountInWords } from './invoice/amountInWords';
import { CODE128_PATTERNS, code128Values, code128Widths } from './invoice/code128';
import { fullAddress, invoiceFromOrder, invoiceFromSnapshot, invoiceMoney } from './invoice/invoiceData';
import { INVOICE_DEFAULTS, formatInvoicePhone, invoiceShop } from './invoice/invoiceShop';
import { buildInvoicePdf } from './invoice/renderInvoice';
import { pickBookedToday } from './invoice/invoicePrints';
import { invoiceCases, mockOrder } from '../../e2e/helpers/invoiceFixtures';
import {
  BARCODE_REGION,
  QR_REGION,
  decodeRegion,
  fontFilesFromDisk,
  pdfPageCount,
  pdfPageText,
  renderPdfPage,
} from '../../e2e/helpers/invoicePdf';

const fonts = fontFilesFromDisk();
const shop = invoiceShop({ shop_whatsapp_number: '8801560040012' });
const SAMPLES = join(process.cwd(), 'reports', 'batch-37-samples');

describe('Batch 37: amount in words', () => {
  it('reads 0, 79, 4,079 and 1,20,450 the Bangladeshi way', () => {
    expect(amountInWords(0)).toBe('Zero taka only');
    expect(amountInWords(79)).toBe('Seventy-nine taka only');
    expect(amountInWords(4079)).toBe('Four thousand seventy-nine taka only');
    expect(amountInWords(120450)).toBe('One lakh twenty thousand four hundred fifty taka only');
  });
  it('handles crore, hundreds and paisa', () => {
    expect(amountInWords(12345678)).toBe('One crore twenty-three lakh forty-five thousand six hundred seventy-eight taka only');
    expect(amountInWords(100)).toBe('One hundred taka only');
    expect(amountInWords(10.5)).toBe('Ten taka and fifty paisa only');
  });
});

describe('Batch 37: Code 128', () => {
  it('every symbol is 11 modules and no two are alike', () => {
    expect(CODE128_PATTERNS).toHaveLength(106);
    for (const p of CODE128_PATTERNS) expect(p.split('').map(Number).reduce((a, b) => a + b, 0)).toBe(11);
    expect(new Set(CODE128_PATTERNS).size).toBe(106);
  });
  it('digits use code set C (with a B tail for an odd count) and a correct checksum', () => {
    // Start C, 30 52 63 11, Code B, "0", checksum.
    const values = code128Values('305263110');
    expect(values.slice(0, 7)).toEqual([105, 30, 52, 63, 11, 100, 16]);
    let sum = values[0];
    for (let i = 1; i < values.length - 1; i += 1) sum += values[i] * i;
    expect(values[values.length - 1]).toBe(sum % 103);
    expect(code128Widths('AB-12').length % 2).toBe(1);
  });
});

describe('Batch 37: invoice numbers', () => {
  it('money and phone formats', () => {
    expect(invoiceMoney(4079)).toBe('৳4,079');
    expect(invoiceMoney(120450)).toBe('৳1,20,450');
    expect(invoiceMoney(10.5)).toBe('৳10.50');
    expect(formatInvoicePhone('+8801850078600')).toBe('01850-078600');
    expect(formatInvoicePhone('https://wa.me/8801560040012')).toBe('01560-040012');
  });

  it('normal COD order: totals are the stored amounts and the courier collects the total', () => {
    const { order, payments } = invoiceCases().normal;
    const inv = invoiceFromOrder(order, payments);
    expect(inv.subtotal).toBe(order.subtotal);
    expect(inv.deliveryFee).toBe(order.delivery_fee);
    expect(inv.total).toBe(order.total);
    expect(inv.total).toBe(4079);
    expect(inv.cod).toEqual({ amount: 4079, note: 'Cash on delivery' });
    expect(inv.finalRow).toEqual({ label: 'Amount to collect', amount: 4079 });
    expect(inv.paymentLabel).toBe('Cash on delivery');
    expect(inv.amountInWords).toBe('Four thousand seventy-nine taka only');
    expect(inv.lines.reduce((n, l) => n + l.amount, 0)).toBe(order.subtotal);
  });

  it('pay later: COD ৳0 "Customer pays later" and "Balance due (pay later)"', () => {
    const { order, payments } = invoiceCases().payLater;
    const inv = invoiceFromOrder(order, payments);
    expect(inv.cod).toEqual({ amount: 0, note: 'Customer pays later' });
    expect(inv.finalRow).toEqual({ label: 'Balance due (pay later)', amount: order.total });
  });

  it('fully paid: COD ৳0 "Paid — do not collect"', () => {
    const { order, payments } = invoiceCases().paid;
    const inv = invoiceFromOrder(order, payments);
    expect(inv.cod).toEqual({ amount: 0, note: 'Paid — do not collect' });
    expect(inv.finalRow.amount).toBe(0);
    expect(inv.paymentLabel).toBe('Paid (bKash)');
  });

  it('advance + COD: one paid row per method, collect = total − advance', () => {
    const { order, payments } = invoiceCases().advance;
    const inv = invoiceFromOrder(order, payments);
    expect(inv.paidRows).toEqual([
      { label: 'Paid in advance (bKash)', amount: 1000, minus: true },
      { label: 'Paid in advance (Nagad)', amount: 500, minus: true },
    ]);
    expect(inv.cod.amount).toBe(order.total - 1500);
    expect(inv.finalRow).toEqual({ label: 'Amount to collect', amount: order.total - 1500 });
    expect(inv.paymentLabel).toBe('bKash, Nagad advance + COD');
  });

  it('a discounted line shows list price and the discount; line amounts still add to the subtotal', () => {
    const order = mockOrder({
      items: [
        { ...mockOrder().items[0], list_price: 2000, unit_price: 1800, quantity: 2, line_total: 3600 },
      ],
    });
    const inv = invoiceFromOrder(order, []);
    expect(inv.lines[0]).toMatchObject({ unitPrice: 2000, discount: 400, amount: 3600 });
  });

  it('before the payments table exists the old paid flag decides', () => {
    const inv = invoiceFromOrder(mockOrder({ payment_status: 'paid', payment_method: 'bkash' }), null);
    expect(inv.cod.note).toBe('Paid — do not collect');
  });

  it('customer copy from the checkout: no consignment, bKash counts as paid', () => {
    const snap = {
      orderId: 'x',
      orderNumber: 'NM-1800',
      items: [],
      zone: { id: 'inside_dhaka' as const, label: 'Inside Dhaka', fee: 70 },
      address: { fullName: 'A', phone: '01712345678', division: 'Dhaka', district: 'Dhaka', thana: 'Mirpur', fullAddress: 'Road 1' },
      promo: null,
      subtotal: 1000,
      discount: 0,
      total: 1070,
      paymentMethod: 'bkash' as const,
      bkashTrxId: 'X',
      placedAt: '2026-10-06T06:00:00Z',
    };
    const inv = invoiceFromSnapshot(snap);
    expect(inv.audience).toBe('customer');
    expect(inv.consignmentId).toBeNull();
    expect(inv.cod).toEqual({ amount: 0, note: 'Paid — do not collect' });
  });

  it('settings: defaults, then QR link / switch / phone from settings', () => {
    const d = invoiceShop({});
    expect(d.city).toBe('Dhaka, Bangladesh');
    expect(d.community.show).toBe(true);
    expect(d.community.link).toBe(INVOICE_DEFAULTS.communityLink);
    const s = invoiceShop({
      shop_whatsapp_number: '01560040012',
      invoice_shop_phone: '01999888777',
      invoice_community_link: 'https://example.com/join',
      invoice_show_community: 'false',
    });
    expect(s.phone).toBe('01999-888777');
    expect(s.community.link).toBe('https://example.com/join');
    expect(s.community.show).toBe(false);
  });
});

describe('Batch 37: "booked today, not printed yet"', () => {
  it('picks booked orders with a shipped line today and no print, in order-number order', () => {
    const today = new Date('2026-10-09T10:00:00+06:00');
    const orders = [
      { id: 'a', order_number: 'NM-1731', steadfast_consignment_id: '1' },
      { id: 'b', order_number: 'NM-1729', steadfast_consignment_id: '2' },
      { id: 'c', order_number: 'NM-1730', steadfast_consignment_id: '3' },
      { id: 'd', order_number: 'NM-1728', steadfast_consignment_id: null },
      { id: 'e', order_number: 'NM-1700', steadfast_consignment_id: '5' },
    ];
    const shippedAt = new Map([
      ['a', '2026-10-09T01:00:00Z'],
      ['b', '2026-10-09T03:00:00Z'],
      ['c', '2026-10-09T04:00:00Z'],
      ['d', '2026-10-09T04:00:00Z'],
      // Booked yesterday (Dhaka time): 23:30 on the 8th.
      ['e', '2026-10-08T17:30:00Z'],
    ]);
    const printed = new Map([['c', '2026-10-09T05:00:00Z']]);
    expect(pickBookedToday(orders, shippedAt, printed, today).map((o) => o.id)).toEqual(['b', 'a']);
  });
});

describe('Batch 37: the PDF', () => {
  const cases = invoiceCases();
  const render = (key: keyof ReturnType<typeof invoiceCases>, s = shop) =>
    buildInvoicePdf([invoiceFromOrder(cases[key].order, cases[key].payments)], s, fonts);

  it('normal order: one A4 page, barcode reads the consignment ID, QR reads the group link', async () => {
    const pdf = await render('normal');
    expect(pdf.pageCount).toBe(1);
    expect(pdf.missingCharacters).toEqual([]);
    const image = await renderPdfPage(pdf.bytes, 1, 3);
    expect(image.width).toBe(Math.ceil(595.28 * 3));
    expect(decodeRegion(image, BARCODE_REGION, 'code128')).toBe('305263110');
    expect(decodeRegion(image, QR_REGION, 'qr')).toBe(INVOICE_DEFAULTS.communityLink);
    const text = (await pdfPageText(pdf.bytes)).join(' ');
    for (const piece of ['4,079', '3,949', '130', 'INV-NM-1721', 'Amount to collect', 'Four thousand seventy-nine taka only']) {
      expect(text).toContain(piece);
    }
    expect(text).not.toMatch(/SKU/i);
  }, 30_000);

  it('the label "Deliver to" and "Billed to" print the same address', () => {
    for (const { order, payments } of Object.values(cases)) {
      const inv = invoiceFromOrder(order, payments);
      expect(fullAddress(inv.customer)).toBe(`${order.address_line}, ${order.thana}, ${order.district}`);
    }
  });

  it('a long order (16 lines) runs onto page 2', async () => {
    const pdf = await render('long');
    expect(pdf.pageCount).toBe(2);
    expect(await pdfPageCount(pdf.bytes)).toBe(2);
    const page2 = (await pdfPageText(pdf.bytes, 2)).join(' ');
    expect(page2).toContain('page 2 of 2');
    expect(page2).toContain('Amount to collect');
  }, 30_000);

  it('Bengali name and address: every character has a glyph in an embedded font', async () => {
    const pdf = await render('bengali');
    expect(pdf.missingCharacters).toEqual([]);
    const hind = fontkit.create(Buffer.from(fonts.bengali.regular));
    const { order } = cases.bengali;
    for (const ch of `${order.customer_name}${order.address_line}${order.thana}${order.district}৳`) {
      if (/\s|,/.test(ch)) continue;
      expect(hind.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0), `glyph for ${ch}`).toBe(true);
    }
  }, 30_000);

  it('not booked: no barcode, the note is shown', async () => {
    const pdf = await render('notBooked');
    const text = (await pdfPageText(pdf.bytes)).join(' ');
    expect(text).toContain('Not booked yet');
    expect(text).toContain('Book with Steadfast to print the label');
    const image = await renderPdfPage(pdf.bytes, 1, 3);
    expect(decodeRegion(image, BARCODE_REGION, 'code128')).toBeNull();
  }, 30_000);

  it('settings change: a new QR link is in the code; switched off, no community box', async () => {
    const custom = invoiceShop({ shop_whatsapp_number: '01560040012', invoice_community_link: 'https://example.com/naeems-club' });
    const pdf = await render('normal', custom);
    const image = await renderPdfPage(pdf.bytes, 1, 3);
    expect(decodeRegion(image, QR_REGION, 'qr')).toBe('https://example.com/naeems-club');

    const off = invoiceShop({ shop_whatsapp_number: '01560040012', invoice_show_community: 'false' });
    const pdfOff = await render('normal', off);
    expect((await pdfPageText(pdfOff.bytes)).join(' ')).not.toContain(INVOICE_DEFAULTS.communityTitle);
    expect(decodeRegion(await renderPdfPage(pdfOff.bytes, 1, 3), QR_REGION, 'qr')).toBeNull();
  }, 30_000);

  it('bulk: three orders make one PDF of three pages, in the order given', async () => {
    const list = (['normal', 'payLater', 'advance'] as const).map((k) => invoiceFromOrder(cases[k].order, cases[k].payments));
    const pdf = await buildInvoicePdf(list, shop, fonts);
    expect(pdf.pageCount).toBe(3);
    for (const [i, inv] of list.entries()) {
      expect((await pdfPageText(pdf.bytes, i + 1)).join(' ')).toContain(inv.invoiceNumber);
    }
  }, 30_000);

  it('saves the sample PDFs and page images', async () => {
    mkdirSync(SAMPLES, { recursive: true });
    const samples: [string, keyof typeof cases][] = [
      ['normal', 'normal'],
      ['pay-later', 'payLater'],
      ['fully-paid', 'paid'],
      ['advance-cod', 'advance'],
      ['long-order', 'long'],
      ['bengali-name', 'bengali'],
      ['not-booked', 'notBooked'],
    ];
    for (const [file, key] of samples) {
      const pdf = await render(key);
      writeFileSync(join(SAMPLES, `${file}.pdf`), pdf.bytes);
      for (let p = 1; p <= pdf.pageCount; p += 1) {
        const image = await renderPdfPage(pdf.bytes, p, 2);
        writeFileSync(join(SAMPLES, pdf.pageCount === 1 ? `${file}.png` : `${file}-page${p}.png`), image.png);
      }
    }
  }, 120_000);
});
