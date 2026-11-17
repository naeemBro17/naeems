// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { invoiceFromOrder } from './invoice/invoiceData';
import { invoiceShop } from './invoice/invoiceShop';
import { buildInvoicePdf } from './invoice/renderInvoice';
import { isHandOverSource, sendsByCourier } from './manualOrders';
import { productSearchGroups, searchProductGroups } from './manualOrderSearch';
import { variantOptionLabel, variantOptionsFor } from './variants';
import { loginReturnPath, safeReturnPath } from './loginReturn';
import type { OrderItem, Product, ProductVariant } from '../types';
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

/* ------------------------------------------ Task 5: sizes in admin search */

const cerave = { id: 'C', name: 'CeraVe Foaming Cleanser USA', is_active: true, retail_price: 1850, offer_price: 1750, stock_quantity: 4, region: 'USA', size: '237 ml', image_url: null, image_urls: [], image_urls_thumb: [] } as unknown as Product;
const ceraveSizes = [
  { id: 'C1', product_id: 'C', region: 'USA', size: '87 ml', retail_price: 950, offer_price: null, stock_quantity: 3, in_stock: true, image_url: null },
  { id: 'C2', product_id: 'C', region: 'USA', size: '355 ml', retail_price: 2400, offer_price: 2300, stock_quantity: 0, in_stock: false, image_url: null },
] as unknown as ProductVariant[];

describe('Batch 47 Task 5: a product with sizes shows once in the admin search, with the shop size list', () => {
  const groups = productSearchGroups([cerave], () => ceraveSizes);

  it('one result for the mother product, whatever size is typed', () => {
    for (const term of ['cerave foaming', '87 ml', '355', 'USA']) {
      expect(searchProductGroups(groups, term).map((g) => g.productId)).toEqual(['C']);
    }
  });

  it('the picker offers exactly what the customer product page offers, in the same order (own size first, so it is addable)', () => {
    const shop = variantOptionsFor(cerave, ceraveSizes).map((o) => variantOptionLabel(o, ''));
    expect(groups[0].options.map((o) => o.variantLabel)).toEqual(shop);
    expect(groups[0].options.map((o) => [o.variantId, o.listPrice, o.stockQuantity])).toEqual([
      [null, 1750, 4],
      ['C1', 950, 3],
      ['C2', 2300, 0],
    ]);
  });
});

/* -------------------------------------------- Task 7: back after logging in */

describe('Batch 47 Task 7: where the customer goes after logging in', () => {
  it('only a page of this shop is a place to return to', () => {
    expect(safeReturnPath('/cart')).toBe('/cart');
    expect(safeReturnPath('/checkout/delivery')).toBe('/checkout/delivery');
    expect(safeReturnPath('/search?q=cerave')).toBe('/search?q=cerave');
    for (const bad of ['/account', '/account/', '//evil.com', 'https://evil.com/x', '/admin/orders', '', null, undefined]) {
      expect(safeReturnPath(bad)).toBeNull();
    }
  });

  it('the page it came from wins; nothing known → the shop home', () => {
    expect(loginReturnPath({ from: '/cart' })).toBe('/cart');
    expect(loginReturnPath({ from: '//evil.com' })).toBe('/');
    expect(loginReturnPath(null)).toBe('/');
  });
});

/* ------------------------------------------- Task 11: invoice page breaks */

const NM3893 = [
  ["L'Oreal Elvive Hyaluron Pure Conditioner 340mL", 1450, 1950],
  ["L'Oreal Paris Elvive Extraordinary Oil Hair Serum Treatment 100ml", 1599, 2099],
  ['ILLIYOON Ceramide Ato Soothing Gel 30ml', 749, 749],
  ['CeraVe Foaming Cleanser Eco-Recharge Refill 473mL', 3100, 3699],
] as const;

function invoiceItem(i: number, name: string, price: number, listPrice: number): OrderItem {
  return {
    id: `b47-${i}`, order_id: 'o', product_id: `p-${i}`, variant_id: null, product_name: name, variant_label: null,
    image_url: null, list_price: listPrice, unit_price: price, quantity: 1, line_total: price,
    reason: listPrice > price ? 'promotion' : null, reason_note: null,
  } as OrderItem;
}

function itemsOf(count: number): OrderItem[] {
  return Array.from({ length: count }, (_, i) => {
    const [name, price, list] = NM3893[i % NM3893.length];
    return invoiceItem(i, `${name} (${i + 1})`, price, list);
  });
}

describe('Batch 47 Task 11: the invoice breaks pages where the content runs out', () => {
  /** The lowest a row may end on a page before the next row moves over
   *  (the page's row limit minus the tallest row). */
  const FULL_PAGE_FROM = 790 - 40;

  async function layoutOf(items: OrderItem[]) {
    // NM-3893's shape: a 70-character address in Tejgaon, booked, COD.
    const order = mockOrder({
      items,
      delivery_fee: 102,
      steadfast_consignment_id: '321957858',
      thana: 'Tejgaon',
      district: 'Dhaka',
      address_line: '82, Ideal International School & College, Green Road, Farmgate, Dhaka.',
    });
    const pdf = await buildInvoicePdf([invoiceFromOrder(order, [])], shop, fonts);
    return { pdf, pages: pdf.layout[0] };
  }

  it('NM-3893 (4 items, one name a line longer — the old layout had only 6.5 pt to spare): one page, all 4 items and the totals on it', async () => {
    const items = NM3893.map(([name, price, list], i) => invoiceItem(i, i === 2 ? `${name} Twin Pack Value Bundle Edition` : name, price, list));
    const { pdf, pages } = await layoutOf(items);
    expect(pdf.pageCount).toBe(1);
    expect(pages).toEqual([expect.objectContaining({ rows: 4, tail: true })]);
    const text = (await pdfPageText(pdf.bytes, 1)).join(' ');
    for (const [name] of NM3893) expect(text).toContain(name.slice(0, 20));
  });

  for (const count of [1, 3, 4, 8, 25]) {
    it(`${count} item${count === 1 ? '' : 's'}: every item once, no early break, totals never alone`, async () => {
      const { pdf, pages } = await layoutOf(itemsOf(count));
      expect(pages.reduce((n, p) => n + p.rows, 0)).toBe(count);
      expect(pages.filter((p) => p.tail)).toHaveLength(1);
      const last = pages[pages.length - 1];
      expect(last.tail).toBe(true);
      expect(last.rows).toBeGreaterThanOrEqual(1);
      for (const p of pages.slice(0, -1)) {
        expect(p.rows).toBeGreaterThan(0);
        expect(p.rowsBottom, 'a page before the last is filled to the bottom').toBeGreaterThanOrEqual(FULL_PAGE_FROM);
      }
      if (count <= 8) expect(pdf.pageCount).toBe(1);
      else expect(pdf.pageCount).toBeGreaterThan(1);
      expect(pdf.pageCount).toBe(pages.length);
    });
  }
});
