import { describe, expect, it } from 'vitest';
import { isPlaceholderPlaceName, parsePoliceStations } from '../../supabase/functions/_shared/policeStations';
import { groupThanas } from './thanas';
import { isTestCustomer, isTestViewer } from './testData';
import { telHref, whatsAppChatUrl, whatsAppNumber } from './phone';
import { whatsAppUrl } from './expertLinks';
import { cardImage, isSmallCopy, productNeedsSmallCopies } from './productImages';
import { categoryCircleImage } from './smallImages';
import type { Product } from '../types';

describe('Batch 31 Part 3: test data never reaches customers or staff lists', () => {
  it("drops Steadfast's own \"test thana\" from their list", () => {
    const live = [{ name: 'Bagerhat', police_stations: [{ name: 'Bagerhat Sadar' }, { name: 'test thana' }, { name: 'Mongla' }] }];
    expect(parsePoliceStations(live).map((s) => s.name)).toEqual(['Bagerhat Sadar', 'Mongla']);
  });

  it('a list already cached on a phone is cleaned when shown', () => {
    const cached = [
      { name: 'Bagerhat Sadar', district: 'Bagerhat' },
      { name: 'test thana', district: 'Bagerhat' },
    ];
    expect(groupThanas(cached, '', 'Bagerhat')).toEqual([{ district: 'Bagerhat', thanas: ['Bagerhat Sadar'] }]);
    expect(groupThanas(cached, 'te', null)).toEqual([]);
  });

  it('never drops a real place name', () => {
    for (const real of ['Kotwali', 'Demra', 'Sadar', 'Contai', 'Latest', 'Tejgaon', 'Teknaf', 'Samplatoli']) {
      expect(isPlaceholderPlaceName(real)).toBe(false);
    }
    expect(isPlaceholderPlaceName('Demo Area')).toBe(true);
    expect(isPlaceholderPlaceName('Test Para')).toBe(true);
  });

  it('test customers are hidden from real staff, not from the test logins', () => {
    expect(isTestCustomer({ name: 'E2E Test Customer' })).toBe(true);
    expect(isTestCustomer({ name: 'e2e B30 Phone Customer' })).toBe(true);
    expect(isTestCustomer({ name: 'Real Person', email: 'e2e.customer@example.com' })).toBe(true);
    expect(isTestCustomer({ name: 'Ehsan', email: 'ehsan@example.com' })).toBe(false);
    expect(isTestViewer({ username: 'e2e.admin' })).toBe(true);
    expect(isTestViewer({ username: 'naeem' })).toBe(false);
    expect(isTestViewer(null)).toBe(false);
  });
});

describe('Batch 31 Part 5: WhatsApp and phone links always carry the country code', () => {
  const formats = ['01610981117', '+8801610981117', '+880 1610-981117', '8801610981117', '880 1610 981117', '1610981117', '0161-0981-117', '00880 1610981117'];

  it('every way of typing a Bangladeshi number gives 8801…', () => {
    for (const raw of formats) {
      expect(whatsAppNumber(raw)).toBe('8801610981117');
      expect(whatsAppChatUrl(raw)).toBe('https://wa.me/8801610981117');
      expect(telHref(raw)).toBe('tel:+8801610981117');
    }
  });

  it('a number from abroad keeps its own country code', () => {
    expect(whatsAppNumber('+61 412 345 678')).toBe('61412345678');
    expect(whatsAppNumber('0061412345678')).toBe('61412345678');
  });

  it('no digits → no link', () => {
    expect(whatsAppChatUrl('')).toBeNull();
    expect(telHref(null)).toBeNull();
  });

  it("the shop's WhatsApp setting: a bare number gets the country code, a full link is kept", () => {
    expect(whatsAppUrl('01560040012')).toBe('https://wa.me/8801560040012');
    expect(whatsAppUrl('https://wa.me/8801560040012')).toBe('https://wa.me/8801560040012');
    expect(whatsAppUrl('  ')).toBeNull();
  });
});

describe('Batch 31 Part 8: small copies are real copies, with the full photo as fallback', () => {
  const base = 'https://x.supabase.co/storage/v1/object/public/product-images';
  const full = `${base}/products/a.webp`;
  const small = `${base}/products/thumb/a.webp?v=1`;

  it('only a file in a thumb/ folder counts as a small copy', () => {
    expect(isSmallCopy(full, small)).toBe(true);
    expect(isSmallCopy(full, full)).toBe(false);
    expect(isSmallCopy(full, null)).toBe(false);
    expect(isSmallCopy(full, 'https://elsewhere.com/thumb/a.webp')).toBe(false);
  });

  it('a product whose "small" slot holds the full photo still needs one', () => {
    const product = { image_urls: [full], image_url: full, image_urls_thumb: [full] } as unknown as Product;
    expect(productNeedsSmallCopies(product)).toBe(true);
    expect(productNeedsSmallCopies({ ...product, image_urls_thumb: [small] } as Product)).toBe(false);
  });

  it('cards use the small copy when present, the full photo otherwise', () => {
    expect(cardImage({ image_urls: [full], image_url: full, image_urls_thumb: [small] } as unknown as Product)).toBe(small);
    expect(cardImage({ image_urls: [full], image_url: full, image_urls_thumb: [] } as unknown as Product)).toBe(full);
  });

  it('Browse circles: small copy when present, full photo otherwise, nothing when no photo', () => {
    const cat = `${base}/categories/c.webp?v=5`;
    const catSmall = `${base}/categories/thumb/c.webp?v=6`;
    expect(categoryCircleImage({ image_url: cat, image_url_thumb: catSmall })).toBe(catSmall);
    expect(categoryCircleImage({ image_url: cat, image_url_thumb: null })).toBe(cat);
    expect(categoryCircleImage({ image_url: cat })).toBe(cat);
    expect(categoryCircleImage({ image_url: null, image_url_thumb: catSmall })).toBeNull();
  });
});
