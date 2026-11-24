import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { customerInitials, itemsWord, stockLine } from './newOrderLook';
import { AddressFormFields } from '../components/checkout/AddressFormFields';
import { CustomerDetailsFields } from '../components/admin/CustomerDetailsFields';
import { productSearchGroups } from './manualOrderSearch';
import type { Product, ProductVariant } from '../types';

// Batch 63: Admin → New order's new look.

describe('customerInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(customerInitials('Rahima Akter Khan', '01711000631')).toBe('RA');
    expect(customerInitials('  karim  ', '017')).toBe('K');
  });
  it('uses the last two digits of the phone when there is no name', () => {
    expect(customerInitials('', '01811-000642')).toBe('42');
    expect(customerInitials('   ', '+880 1711 000 631')).toBe('31');
  });
});

describe('stockLine', () => {
  it('tracked stock', () => {
    expect(stockLine(12)).toEqual({ text: '12 in stock', tone: 'normal' });
    expect(stockLine(4)).toEqual({ text: '4 in stock', tone: 'normal' });
  });
  it('1 to 3 left is low', () => {
    expect(stockLine(3)).toEqual({ text: 'Only 3 left', tone: 'low' });
    expect(stockLine(1)).toEqual({ text: 'Only 1 left', tone: 'low' });
  });
  it('0 or less is out', () => {
    expect(stockLine(0)).toEqual({ text: 'Out of stock', tone: 'out' });
    expect(stockLine(-2)).toEqual({ text: 'Out of stock', tone: 'out' });
  });
  it('nothing when stock is not counted', () => {
    expect(stockLine(null)).toBeNull();
  });
});

describe('itemsWord', () => {
  it('1 item / 3 items', () => {
    expect(itemsWord(1)).toBe('1 item');
    expect(itemsWord(3)).toBe('3 items');
    expect(itemsWord(0)).toBe('0 items');
  });
});

const form = { fullName: 'A', phone: '017', division: 'Dhaka', district: 'Dhaka', thana: 'Mirpur', fullAddress: 'House 1' };
const noop = () => undefined;

function labelsOf(html: string): string[] {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  return Array.from(doc.querySelectorAll('label.form-label')).map((l) => (l.textContent ?? '').replace(/\s*\*\s*$/, '').trim());
}

describe('AddressFormFields part', () => {
  const render = (part?: 'all' | 'contact' | 'address') =>
    renderToStaticMarkup(<AddressFormFields form={form} errors={{}} onChange={noop} idPrefix="t" part={part} />);

  it("'all' (the default) is the checkout form, unchanged", () => {
    expect(render()).toBe(render('all'));
    expect(labelsOf(render())).toEqual(['Full name', 'Phone number', 'Division', 'District', 'Thana / Upazila', 'House / road / landmark']);
    const doc = new DOMParser().parseFromString(render(), 'text/html');
    expect(doc.querySelector('.form-row #t-district')).not.toBeNull();
    expect(doc.querySelector('.form-row #t-thana')).not.toBeNull();
    expect(doc.querySelector('.nord-pair, .nord-trio')).toBeNull();
  });
  it("'contact' is name and phone side by side", () => {
    expect(labelsOf(render('contact'))).toEqual(['Full name', 'Phone number']);
    expect(render('contact').startsWith('<div class="nord-pair">')).toBe(true);
  });
  it("'address' is division, district, thana and house / road", () => {
    expect(labelsOf(render('address'))).toEqual(['Division', 'District', 'Thana / Upazila', 'House / road / landmark']);
    expect(render('address').startsWith('<div class="nord-trio">')).toBe(true);
  });
});

describe('CustomerDetailsFields part', () => {
  const render = (part?: 'all' | 'contact' | 'address') =>
    renderToStaticMarkup(
      <CustomerDetailsFields idPrefix="t" address={form} onAddressChange={noop} altPhone="" onAltPhoneChange={noop} part={part} afterPhone={<p>fraud</p>} />
    );
  it('each field once across contact + address, the same as all', () => {
    const all = labelsOf(render());
    const split = [...labelsOf(render('contact')), ...labelsOf(render('address'))];
    expect([...split].sort()).toEqual([...all].sort());
    expect(labelsOf(render('contact'))).toEqual(['Full name', 'Phone number', 'Alternative phone (optional)']);
    expect(render('contact')).toContain('<p>fraud</p>');
    expect(render()).not.toContain('fraud');
  });
});

describe('productSearchGroups: small photos and retail price', () => {
  const B = 'https://x.supabase.co/storage/v1/object/public/product-images';
  const product = {
    id: 'p1', name: 'Serum', is_active: true, retail_price: 1500, offer_price: 1250, stock_quantity: 3, stock_status: 'in_stock',
    image_url: `${B}/products/a.webp`, image_urls: [`${B}/products/a.webp`], image_urls_thumb: [`${B}/products/card/a.webp`],
  } as unknown as Product;
  it('uses the small copy, keeps the offer as the price and the retail price beside it', () => {
    const [group] = productSearchGroups([product], () => []);
    expect(group.options[0].thumbUrl).toBe(`${B}/products/card/a.webp`);
    expect(group.options[0].listPrice).toBe(1250);
    expect(group.options[0].retailPrice).toBe(1500);
  });
  it('never the full-size photo: no small copy means no photo', () => {
    const noSmall = { ...product, image_urls_thumb: [`${B}/products/a.webp`] } as Product;
    expect(productSearchGroups([noSmall], () => [])[0].options[0].thumbUrl).toBeNull();
  });
  it("a size with its own photo uses that size's small copy", () => {
    const variant = {
      id: 'v1', product_id: 'p1', region: 'AU', size: '1L', retail_price: 2000, offer_price: null, stock_quantity: 1,
      image_url: `${B}/products/v.webp`, image_url_thumb: `${B}/products/thumb/v.webp`,
    } as unknown as ProductVariant;
    const [group] = productSearchGroups([product], () => [variant]);
    expect(group.options[1].thumbUrl).toBe(`${B}/products/thumb/v.webp`);
    expect(group.options[1].retailPrice).toBe(2000);
  });
});
