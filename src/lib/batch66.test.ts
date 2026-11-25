import { afterEach, describe, expect, it } from 'vitest';
import {
  campaignHeadline,
  campaignOfProduct,
  campaignSavings,
  dropBlock,
  floorPercent,
  moveBlock,
  parseCampaigns,
  percentSalePrice,
  productCampaignPercent,
  promoBase,
  saleFor,
  setLiveCampaigns,
  shopPrice,
  type LiveCampaign,
} from './campaigns';
import { getDisplayPrice } from './pricing';
import { lowestVariantPrice, variantDisplayPrice, variantOptionsFor } from './variants';
import { countdownLeft, shortLeft } from '../components/campaign/useCountdown';
import {
  blockFor,
  blocksProblem,
  blocksToItems,
  campaignStatus,
  campaignSummary,
  dhakaRange,
  fromDhakaParts,
  itemsToBlocks,
  rowSalePrice,
  statusText,
  toDhakaParts,
} from './campaignsAdmin';
import type { Product, ProductVariant } from '../types';

const HOUR = 3600_000;
const NOW = Date.now();

function product(id: string, retail: number, offer: number | null = null): Product {
  return { id, name: `P ${id}`, retail_price: retail, offer_price: offer, region: null, size: null } as unknown as Product;
}
function variant(id: string, productId: string, retail: number, offer: number | null = null): ProductVariant {
  return {
    id,
    product_id: productId,
    region: 'AU',
    size: id,
    retail_price: retail,
    offer_price: offer,
    sort_order: 0,
    created_at: '2026-01-01',
  } as unknown as ProductVariant;
}

function campaign(over: Partial<LiveCampaign>): LiveCampaign {
  return {
    id: 'c1',
    name: 'Summer Fest',
    slug: 'summer-fest',
    style: 'plain',
    discount_mode: 'percent',
    percent: 20,
    starts_at: new Date(NOW - HOUR).toISOString(),
    ends_at: new Date(NOW + 48 * HOUR).toISOString(),
    items: [],
    ...over,
  };
}

afterEach(() => setLiveCampaigns([]));

describe('Batch 66 price rule (same as SQL campaign_sale_price)', () => {
  it('percent with no offer: 20% off ৳1,000 = ৳800, retail struck, % rounded down', () => {
    setLiveCampaigns([campaign({ items: [{ product_id: 'a', variant_id: null, campaign_price: null, sort_order: 0 }] })]);
    const d = getDisplayPrice(product('a', 1000));
    expect(d.mainPrice).toBe(800);
    expect(d.strikePrice).toBe(1000);
    expect(d.savePercent).toBe(20);
    expect(d.campaign?.name).toBe('Summer Fest');
  });

  it('percent with a lower offer: the offer wins', () => {
    setLiveCampaigns([campaign({ items: [{ product_id: 'a', variant_id: null, campaign_price: null, sort_order: 0 }] })]);
    expect(saleFor('a', null, 1000, 700)?.price).toBe(700);
    expect(saleFor('a', null, 1000, 900)?.price).toBe(800);
    expect(getDisplayPrice(product('a', 1000, 700)).mainPrice).toBe(700);
  });

  it('percent rounds to whole taka like SQL round()', () => {
    expect(percentSalePrice(999, 20)).toBe(799);
    expect(percentSalePrice(1003.13, 20)).toBe(803);
    expect(percentSalePrice(1001.25, 20)).toBe(801);
    expect(percentSalePrice(1250, 12.5)).toBe(1094);
    expect(percentSalePrice(1003, 15)).toBe(853);
  });

  it('own price, and size products (exact size only; the own size is null)', () => {
    setLiveCampaigns([
      campaign({
        discount_mode: 'own_price',
        percent: null,
        items: [
          { product_id: 'a', variant_id: null, campaign_price: 650, sort_order: 0 },
          { product_id: 'b', variant_id: 'b1', campaign_price: 1500, sort_order: 1 },
        ],
      }),
    ]);
    expect(saleFor('a', null, 900, null)?.price).toBe(650);
    expect(variantDisplayPrice(variant('b1', 'b', 2000)).mainPrice).toBe(1500);
    expect(variantDisplayPrice(variant('b2', 'b', 2500)).mainPrice).toBe(2500);
    // The product's own size (option id = product id) is not on sale.
    expect(saleFor('b', 'b', 1800, null)).toBeNull();
    const options = variantOptionsFor(product('b', 1800), [variant('b1', 'b', 2000), variant('b2', 'b', 2500)]);
    expect(lowestVariantPrice(options)).toBe(1500);
  });

  it('percent covers every size of the product', () => {
    setLiveCampaigns([campaign({ items: [{ product_id: 'b', variant_id: null, campaign_price: null, sort_order: 0 }] })]);
    expect(variantDisplayPrice(variant('b1', 'b', 2000)).mainPrice).toBe(1600);
    expect(variantDisplayPrice(variant('b2', 'b', 2500)).mainPrice).toBe(2000);
  });

  it('not in a campaign: prices exactly as before', () => {
    setLiveCampaigns([campaign({ items: [{ product_id: 'x', variant_id: null, campaign_price: null, sort_order: 0 }] })]);
    expect(getDisplayPrice(product('a', 1000, 900))).toEqual({ mainPrice: 900, strikePrice: 1000, savePercent: 10 });
    expect(getDisplayPrice(product('a', 1000))).toEqual({ mainPrice: 1000, strikePrice: null, savePercent: null });
    const options = variantOptionsFor(product('b', 1800), [variant('b1', 'b', 2000, 1700), variant('b2', 'b', 2500)]);
    expect(lowestVariantPrice(options)).toBe(1700);
    expect(shopPrice('a', null, 1000, 900)).toBe(900);
  });

  it('campaign ended (or not started): no sale', () => {
    const items = [{ product_id: 'a', variant_id: null, campaign_price: null, sort_order: 0 }];
    setLiveCampaigns([campaign({ ends_at: new Date(NOW - 1000).toISOString(), items })]);
    expect(getDisplayPrice(product('a', 1000)).mainPrice).toBe(1000);
    expect(saleFor('a', null, 1000, null, NOW + HOUR)).toBeNull();
    setLiveCampaigns([campaign({ starts_at: new Date(NOW + HOUR).toISOString(), items })]);
    expect(saleFor('a', null, 1000, null)).toBeNull();
    expect(campaignOfProduct('a')).toBeNull();
  });

  it('parses the server answer (numbers as strings)', () => {
    const parsed = parseCampaigns([
      { id: 'c', name: 'X', slug: 'x', style: 'glitter', discount_mode: 'percent', percent: '15.00', starts_at: 'a', ends_at: 'b', items: [{ product_id: 'p', variant_id: null, campaign_price: null, sort_order: '2' }] },
      'junk',
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].percent).toBe(15);
    expect(parsed[0].style).toBe('glitter');
    expect(parsed[0].items[0].sort_order).toBe(2);
  });
});

describe('Batch 66 headline', () => {
  const noSizes = () => [] as ProductVariant[];
  it('same % everywhere → "X% off every item"', () => {
    const c = campaign({
      items: [
        { product_id: 'a', variant_id: null, campaign_price: null, sort_order: 0 },
        { product_id: 'b', variant_id: null, campaign_price: null, sort_order: 1 },
      ],
    });
    setLiveCampaigns([c]);
    expect(campaignHeadline(c, [product('a', 1000), product('b', 500)], noSizes)).toBe('20% off every item');
  });

  it('mixed (a lower offer) → "Up to X% off"', () => {
    const c = campaign({
      items: [
        { product_id: 'a', variant_id: null, campaign_price: null, sort_order: 0 },
        { product_id: 'b', variant_id: null, campaign_price: null, sort_order: 1 },
      ],
    });
    setLiveCampaigns([c]);
    expect(campaignHeadline(c, [product('a', 1000), product('b', 1000, 700)], noSizes)).toBe('Up to 30% off');
  });

  it('rounds down: 24.6% shows 24', () => {
    expect(floorPercent(1000, 754)).toBe(24);
    expect(floorPercent(1000, 850)).toBe(15);
    const c = campaign({ discount_mode: 'own_price', percent: null, items: [{ product_id: 'a', variant_id: null, campaign_price: 754, sort_order: 0 }] });
    setLiveCampaigns([c]);
    expect(campaignHeadline(c, [product('a', 1000)], noSizes)).toBe('24% off every item');
    expect(productCampaignPercent(c, product('a', 1000), noSizes)).toBe(24);
    expect(getDisplayPrice(product('a', 1000)).savePercent).toBe(24);
  });
});

describe('Batch 66 countdown', () => {
  it('splits what is left into days, hours, minutes, seconds', () => {
    const left = countdownLeft(NOW + ((2 * 24 + 4) * 3600 + 5 * 60 + 9) * 1000 + 300, NOW);
    expect(left).toEqual({ d: 2, h: 4, m: 5, s: 9, done: false });
    expect(shortLeft(left)).toBe('2d 04:05:09');
    expect(countdownLeft(NOW - 5, NOW).done).toBe(true);
  });
});

describe('Batch 66 cart / summary', () => {
  const lines = [
    { unitPrice: 800, quantity: 2, sale: { campaignId: 'c1', campaignName: 'Summer Fest', retail: 1000 } },
    { unitPrice: 500, quantity: 1, sale: null },
    { unitPrice: 700, quantity: 1, sale: { campaignId: 'c1', campaignName: 'Summer Fest', retail: 1000 } },
  ];
  it('promo base leaves the sale items out', () => {
    expect(promoBase(lines)).toBe(500);
    expect(promoBase(lines.filter((l) => l.sale))).toBe(0);
  });
  it('savings row: Σ (retail − pays) × qty, named after the campaign', () => {
    expect(campaignSavings(lines)).toEqual({ label: 'Summer Fest savings', name: 'Summer Fest', amount: 700 });
    expect(campaignSavings([{ unitPrice: 500, quantity: 1, sale: null }])).toBeNull();
    const two = [...lines, { unitPrice: 90, quantity: 1, sale: { campaignId: 'c2', campaignName: '12.12', retail: 100 } }];
    expect(campaignSavings(two)?.label).toBe('Sale savings');
  });
});

describe('Batch 66 sorting', () => {
  it('↑ ↓ move one place, never past the ends', () => {
    expect(moveBlock(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveBlock(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveBlock(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveBlock(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
  it('drag drops a block at its new place', () => {
    expect(dropBlock(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(dropBlock(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(dropBlock(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
  it('sizes stay one block and save in order', () => {
    const b = blockFor(product('b', 1800), [variant('b1', 'b', 2000), variant('b2', 'b', 2500)], null);
    const a = blockFor(product('a', 900), [], null);
    b.rows[1].price = '1500';
    b.rows[2].price = '2100';
    a.rows[0].price = '650';
    const items = blocksToItems([a, b], 'own_price');
    expect(items).toEqual([
      { product_id: 'a', variant_id: null, campaign_price: 650, sort_order: 0 },
      { product_id: 'b', variant_id: 'b1', campaign_price: 1500, sort_order: 101 },
      { product_id: 'b', variant_id: 'b2', campaign_price: 2100, sort_order: 102 },
    ]);
    expect(blocksToItems([b, a], 'percent')).toEqual([
      { product_id: 'b', variant_id: null, campaign_price: null, sort_order: 0 },
      { product_id: 'a', variant_id: null, campaign_price: null, sort_order: 100 },
    ]);
    const back = itemsToBlocks({ items }, (id) => (id === 'a' ? blockFor(product('a', 900), [], null) : blockFor(product('b', 1800), [variant('b1', 'b', 2000), variant('b2', 'b', 2500)], null)));
    expect(back.map((x) => x.productId)).toEqual(['a', 'b']);
    expect(back[1].rows.map((r) => r.price)).toEqual(['', '1500', '2100']);
  });
  it('own price must be below retail', () => {
    const a = blockFor(product('a', 900), [], null);
    expect(blocksProblem([a], 'own_price')).toBe('P a: type a sale price.');
    a.rows[0].price = '900';
    expect(blocksProblem([a], 'own_price')).toBe('P a: the sale price must be below ৳900.');
    a.rows[0].price = '650';
    expect(blocksProblem([a], 'own_price')).toBeNull();
    expect(rowSalePrice(a.rows[0], 'own_price', null)).toBe(650);
    expect(rowSalePrice(a.rows[0], 'percent', 10)).toBe(810);
    expect(blocksProblem([], 'percent')).toBe('Add at least 1 product.');
  });
});

describe('Batch 66 admin words', () => {
  it('status pills', () => {
    const base = { is_enabled: true, starts_at: new Date(NOW - HOUR).toISOString(), ends_at: new Date(NOW + (2 * 24 + 4) * HOUR + 60_000).toISOString() };
    expect(campaignStatus(base, NOW)).toBe('live');
    expect(statusText(base, NOW)).toBe('Live · 2d 4h left');
    expect(statusText({ ...base, starts_at: new Date(NOW + 3 * 24 * HOUR).toISOString() }, NOW)).toBe('Starts in 3 days');
    expect(statusText({ ...base, ends_at: new Date(NOW - 1).toISOString() }, NOW)).toBe('Ended');
    expect(statusText({ ...base, is_enabled: false }, NOW)).toBe('Off');
  });
  it('Dhaka dates', () => {
    expect(toDhakaParts('2026-11-25T04:00:00Z')).toEqual({ date: '2026-11-25', time: '10:00' });
    expect(fromDhakaParts('2026-11-28', '23:59')).toBe('2026-11-28T23:59:00+06:00');
    expect(fromDhakaParts('2026-11-28', '')).toBeNull();
    expect(dhakaRange('2026-11-25T04:00:00Z', '2026-11-28T17:59:00Z')).toBe('25 Nov, 10:00 AM to 28 Nov, 11:59 PM');
  });
  it('summary', () => {
    expect(campaignSummary({ discount_mode: 'percent', percent: 15, items: [{ product_id: 'a', variant_id: null, campaign_price: null, sort_order: 0 }] })).toBe('15% off · 1 product');
    expect(
      campaignSummary({
        discount_mode: 'own_price',
        percent: null,
        items: [
          { product_id: 'a', variant_id: null, campaign_price: 1, sort_order: 0 },
          { product_id: 'b', variant_id: 'b1', campaign_price: 1, sort_order: 1 },
          { product_id: 'b', variant_id: 'b2', campaign_price: 1, sort_order: 2 },
        ],
      })
    ).toBe('Own prices · 2 products');
  });
});
