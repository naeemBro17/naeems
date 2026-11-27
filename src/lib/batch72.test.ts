import { describe, expect, it } from 'vitest';
import { filterByCategory, inCategory, productCategoryIds, concernPath } from './categoryFilter';
import { DEFAULT_CONCERN_LIST, concernKey, matchConcerns, parseConcernList, sameConcern, withConcern } from './concerns';
import {
  defaultRoutineRules,
  isFallbackOn,
  parseRoutineQuestions,
  parseRoutineRules,
  pickQuestion,
  pickedForYou,
  pickedForYouLine,
  routineSuggestions,
  shouldAsk,
  skinProfileOf,
  type RoutineRule,
  type SkinProfile,
} from './routine';
import { applyProductFilters } from '../hooks/useProductFilters';
import { searchTextOf } from '../hooks/useSearch';
import { SKIN_TYPES } from './skinFields';
import type { Product } from '../types';

let seq = 0;
function product(over: Partial<Product> & { name: string }): Product {
  seq += 1;
  return {
    id: over.id ?? `p${seq}`,
    sku: `SKU${seq}`,
    slug: over.name.toLowerCase().replace(/\s+/g, '-'),
    brand: null,
    brand_id: null,
    description: null,
    category_id: null,
    category: null,
    retail_price: 1000,
    offer_price: null,
    wholesale_price: null,
    stock_status: 'in_stock',
    stock_quantity: null,
    note: null,
    how_to_use: null,
    key_ingredients: null,
    youtube_url: null,
    skin_types: null,
    skin_conditions: null,
    region: null,
    size: null,
    combined_from_product_id: null,
    is_featured: false,
    has_wholesale: false,
    image_url: null,
    image_urls: null,
    image_urls_thumb: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const CATS = [
  { id: 'moist', name: 'Moisturizer' },
  { id: 'clean', name: 'Cleanser' },
  { id: 'sun', name: 'Sunscreen' },
  { id: 'serum', name: 'Serum' },
  { id: 'body', name: 'Body Care' },
];

const none = new Set<string>();

describe('concerns', () => {
  it('"Anti-Aging", "anti aging" and "Anti aging" are the same concern', () => {
    expect(concernKey('Anti-Aging')).toBe('antiaging');
    expect(sameConcern('Anti-Aging', 'anti aging')).toBe(true);
    expect(sameConcern('Acne', 'Redness')).toBe(false);
  });

  it('parseConcernList: unset gives the defaults; duplicates and junk are dropped', () => {
    expect(parseConcernList(undefined)).toEqual([...DEFAULT_CONCERN_LIST]);
    expect(parseConcernList('')).toEqual([...DEFAULT_CONCERN_LIST]);
    expect(parseConcernList('not json')).toEqual([...DEFAULT_CONCERN_LIST]);
    expect(parseConcernList('{"a":1}')).toEqual([...DEFAULT_CONCERN_LIST]);
    expect(parseConcernList('["Acne", "acne", 7, "  ", " Pores ", "Anti-Aging", "anti aging"]')).toEqual([
      'Acne',
      'Pores',
      'Anti-Aging',
    ]);
    expect(parseConcernList(JSON.stringify(['x'.repeat(40)]))[0]).toHaveLength(24);
  });

  it('withConcern adds a new name once', () => {
    expect(withConcern(['Acne'], ' Pores ')).toEqual(['Acne', 'Pores']);
    expect(withConcern(['Acne'], 'ACNE')).toEqual(['Acne']);
    expect(withConcern(['Acne'], '  ')).toEqual(['Acne']);
  });

  it('matchConcerns: starts-with first, then contains', () => {
    const list = ['Dehydrated', 'Hydration', 'Redness'];
    expect(matchConcerns(list, 'hyd')).toEqual(['Hydration', 'Dehydrated']);
    expect(matchConcerns(list, '')).toEqual([]);
    expect(matchConcerns(list, 'zzz')).toEqual([]);
  });

  it('the shop link for a concern', () => {
    expect(concernPath('Anti aging')).toBe('/shop?concern=Anti%20aging');
  });

  it('skin types are exactly the four', () => {
    expect([...SKIN_TYPES]).toEqual(['Normal', 'Oily', 'Combination', 'Dry']);
  });
});

describe('more than one category', () => {
  it('main category first, then the extra ones, no repeats', () => {
    const p = product({ name: 'A', category_id: 'moist', extra_category_ids: ['sun', 'moist', 'serum'] });
    expect(productCategoryIds(p)).toEqual(['moist', 'sun', 'serum']);
    expect(inCategory(p, 'sun')).toBe(true);
    expect(inCategory(p, 'clean')).toBe(false);
    expect(productCategoryIds(product({ name: 'B' }))).toEqual([]);
  });

  it('filterByCategory finds a product through an extra category', () => {
    const a = product({ name: 'A', category_id: 'moist', extra_category_ids: ['sun'] });
    const b = product({ name: 'B', category_id: 'sun' });
    const c = product({ name: 'C', category_id: 'clean' });
    expect(filterByCategory([a, b, c], 'sun')).toEqual([a, b]);
    // Before the SQL: no extra_category_ids at all.
    expect(filterByCategory([c], 'clean')).toEqual([c]);
  });
});

describe('shop filters and search', () => {
  it('a concern filter keeps products with ANY chosen concern', () => {
    const acne = product({ name: 'Gel', skin_conditions: ['Acne'] });
    const aging = product({ name: 'Cream', skin_conditions: ['Anti-Aging'] });
    const plain = product({ name: 'Soap' });
    expect(applyProductFilters([acne, aging, plain], { brands: [], skinTypes: [], concerns: ['Acne'] })).toEqual([acne]);
    expect(applyProductFilters([acne, aging, plain], { brands: [], skinTypes: [], concerns: ['Anti aging', 'Acne'] })).toEqual([
      acne,
      aging,
    ]);
  });

  it('search text includes skin types and concerns', () => {
    const p = product({ name: 'Clear Gel', skin_types: ['Oily'], skin_conditions: ['Acne'] });
    expect(searchTextOf(p)).toContain('Oily');
    expect(searchTextOf(p)).toContain('Acne');
  });
});

describe('routine rules', () => {
  it('parseRoutineRules drops from = to and junk', () => {
    expect(
      parseRoutineRules('[{"from":"a","to":"b"},{"from":"a","to":"a"},{"from":"","to":"b"},7,{"from":"c"}]')
    ).toEqual([{ from: 'a', to: 'b' }]);
    expect(parseRoutineRules('nope')).toEqual([]);
  });

  it('defaultRoutineRules uses category names and skips missing ones', () => {
    // No "Oil cleanser" category: Sunscreen → Oil cleanser is skipped.
    expect(defaultRoutineRules(CATS)).toEqual([
      { from: 'moist', to: 'clean' },
      { from: 'clean', to: 'moist' },
      { from: 'serum', to: 'sun' },
    ]);
    expect(defaultRoutineRules([{ id: 'x', name: ' moisturizer ' }, { id: 'y', name: 'CLEANSER' }])).toEqual([
      { from: 'x', to: 'y' },
      { from: 'y', to: 'x' },
    ]);
    expect(defaultRoutineRules([{ id: 'f', name: 'Face Care' }])).toEqual([]);
  });

  it('parseRoutineQuestions trims, caps at 40 and drops empty rows', () => {
    expect(
      parseRoutineQuestions(JSON.stringify([{ text: ' Hi ', concern: 'Acne' }, { text: '', concern: 'Acne' }, { text: 'x', concern: ' ' }]))
    ).toEqual([{ text: 'Hi', concern: 'Acne' }]);
    expect(parseRoutineQuestions(JSON.stringify([{ text: 'y'.repeat(60), concern: 'Acne' }]))[0].text).toHaveLength(40);
  });

  it('the fallback is on unless switched off', () => {
    expect(isFallbackOn(undefined)).toBe(true);
    expect(isFallbackOn('')).toBe(true);
    expect(isFallbackOn('1')).toBe(true);
    expect(isFallbackOn('0')).toBe(false);
  });
});

describe('routineSuggestions', () => {
  const rules: RoutineRule[] = [{ from: 'moist', to: 'clean' }];

  it('a rule match: label, forCategory; the cart, hidden and out-of-stock products left out', () => {
    const anchor = product({ name: 'Day cream', category_id: 'moist' });
    const c1 = product({ name: 'Foam', category_id: 'clean' });
    const inCart = product({ name: 'Gel wash', category_id: 'clean' });
    const hidden = product({ name: 'Hidden wash', category_id: 'clean', is_active: false });
    const out = product({ name: 'Out wash', category_id: 'clean', stock_status: 'out_of_stock', stock_quantity: 0, keep_selling: false });
    const extra = product({ name: 'Balm', category_id: 'body', extra_category_ids: ['clean'] });
    const r = routineSuggestions({
      anchor,
      catalogue: [anchor, c1, inCart, hidden, out, extra],
      categories: CATS,
      rules,
      fallback: true,
      exclude: new Set([anchor.id, inCart.id]),
      profile: null,
    });
    expect(r.forCategory).toBe('Moisturizer');
    expect(r.picks.map((p) => p.product.name).sort()).toEqual(['Balm', 'Foam']);
    expect(r.picks.every((p) => p.label === 'Cleanser')).toBe(true);
  });

  it("the customer's fit sorts first", () => {
    const anchor = product({ name: 'Day cream', category_id: 'moist' });
    const plain = product({ name: 'A wash', category_id: 'clean', is_featured: true });
    const fits = product({ name: 'Z wash', category_id: 'clean', skin_types: ['Oily'], skin_conditions: ['Acne'] });
    const profile: SkinProfile = { skinType: 'Oily', concerns: ['Acne'], wants: [] };
    const r = routineSuggestions({ anchor, catalogue: [plain, fits], categories: CATS, rules, fallback: true, exclude: none, profile });
    expect(r.picks.map((p) => p.product.name)).toEqual(['Z wash', 'A wash']);
  });

  it('no rule fits: same concern before same brand; fallback off gives none', () => {
    const anchor = product({ name: 'Spot gel', category_id: 'serum', brand: 'Acme', skin_conditions: ['Acne'] });
    const sameBrand = product({ name: 'Acme lotion', category_id: 'body', brand: 'Acme', created_at: '2026-06-01T00:00:00Z' });
    const sameConcernP = product({ name: 'Clear toner', category_id: 'body', skin_conditions: ['acne'] });
    const other = product({ name: 'Unrelated', category_id: 'body' });
    const args = { anchor, catalogue: [sameBrand, sameConcernP, other], categories: CATS, rules, exclude: none, profile: null };
    const on = routineSuggestions({ ...args, fallback: true });
    expect(on.forCategory).toBeNull();
    expect(on.picks.map((p) => p.product.name)).toEqual(['Clear toner', 'Acme lotion']);
    expect(on.picks[0].label).toBe('Body Care');
    expect(routineSuggestions({ ...args, fallback: false }).picks).toEqual([]);
  });

  it('at most 6', () => {
    const anchor = product({ name: 'Day cream', category_id: 'moist' });
    const many = Array.from({ length: 9 }, (_, i) => product({ name: `Wash ${i}`, category_id: 'clean' }));
    const r = routineSuggestions({ anchor, catalogue: many, categories: CATS, rules, fallback: true, exclude: none, profile: null });
    expect(r.picks).toHaveLength(6);
  });
});

describe('the side cart question', () => {
  it('shows on every 4th open', () => {
    for (const n of [4, 8]) expect(shouldAsk(n)).toBe(true);
    for (const n of [0, 1, 2, 3, 5]) expect(shouldAsk(n)).toBe(false);
  });

  it('skips her concerns and rotates', () => {
    const qs = [
      { text: 'Acne?', concern: 'Acne' },
      { text: 'Aging?', concern: 'Anti aging' },
      { text: 'Glow?', concern: 'Brightening' },
    ];
    expect(pickQuestion(qs, 4, [])?.text).toBe('Aging?');
    expect(pickQuestion(qs, 8, [])?.text).toBe('Glow?');
    expect(pickQuestion(qs, 12, [])?.text).toBe('Acne?');
    expect(pickQuestion(qs, 4, ['Anti-Aging'])?.text).toBe('Glow?');
    expect(pickQuestion(qs, 4, ['acne', 'anti aging', 'brightening'])).toBeNull();
    expect(pickQuestion([], 4, [])).toBeNull();
  });
});

describe('Picked for you', () => {
  const cats = [...CATS, { id: 'sunblock', name: 'Sun Block' }];

  it('orders by score; why = concern, then want, then skin type; fewer than 3 gives none', () => {
    const profile: SkinProfile = { skinType: 'Oily', concerns: ['Acne'], wants: ['Even tone'] };
    const all = product({ name: 'All three', skin_types: ['Oily'], skin_conditions: ['Acne', 'Dark Spots'] });
    const want = product({ name: 'Want only', skin_conditions: ['Brightening'] });
    const type = product({ name: 'Type only', skin_types: ['Oily'], is_featured: true });
    const no = product({ name: 'Nothing' });
    const out = product({ name: 'Out', skin_conditions: ['Acne'], stock_status: 'out_of_stock', stock_quantity: 0, keep_selling: false });
    const picked = pickedForYou([no, type, want, all, out], profile, cats);
    expect(picked.map((p) => p.product.name)).toEqual(['All three', 'Type only', 'Want only']);
    expect(picked.map((p) => p.why)).toEqual(['Acne', 'Oily', 'Even tone']);
    expect(pickedForYou([all, want], profile, cats)).toEqual([]);
  });

  it('"Sun protection" matches a "Sunscreen" or "Sun Block" category', () => {
    const profile: SkinProfile = { skinType: null, concerns: [], wants: ['Sun protection'] };
    const list = [
      product({ name: 'SPF 50', category_id: 'sun' }),
      product({ name: 'Block', category_id: 'sunblock' }),
      product({ name: 'Extra', category_id: 'body', extra_category_ids: ['sun'] }),
      product({ name: 'Body', category_id: 'body' }),
    ];
    const picked = pickedForYou(list, profile, cats);
    expect(picked.map((p) => p.product.name).sort()).toEqual(['Block', 'Extra', 'SPF 50']);
    expect(picked.every((p) => p.why === 'Sun protection')).toBe(true);
  });

  it('the line under the title', () => {
    expect(pickedForYouLine({ skinType: 'Combination', concerns: ['Acne', 'Hyperpigmentation'], wants: [] })).toBe(
      'For combination skin, acne and hyperpigmentation'
    );
    expect(pickedForYouLine({ skinType: 'Dry', concerns: [], wants: ['Glow'] })).toBe('For dry skin');
    expect(pickedForYouLine({ skinType: null, concerns: [], wants: ['Glow'] })).toBe('');
  });

  it('skinProfileOf: none or empty gives null', () => {
    expect(skinProfileOf(null)).toBeNull();
    expect(skinProfileOf({})).toBeNull();
    expect(skinProfileOf({ skin_type: null, skin_concerns: [], skin_wants: [] })).toBeNull();
    expect(skinProfileOf({ skin_type: 'Dry', skin_concerns: null })).toEqual({ skinType: 'Dry', concerns: [], wants: [] });
  });
});
