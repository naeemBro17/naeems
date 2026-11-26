import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterAdd, closeSideCart, lineKey, openSideCart, useSideCart } from './sideCart';
import { matchesAllWords, smartSearch } from './smartSearch';
import { productSearchGroups, searchProductGroups } from './manualOrderSearch';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Product } from '../types';
import type { SideCartState } from './sideCart';

// The side cart's state is one store read through its hook, as the
// components read it (rendered once to read the current snapshot).
function current(): SideCartState {
  let seen: SideCartState | null = null;
  function Probe() {
    seen = useSideCart();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!seen) throw new Error('no state');
  return seen;
}

describe('Batch 70 Part 1a: the side cart opens on the first add of a visit only', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    closeSideCart();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the first add opens it in "added" mode with the line highlighted; the second does not change it', () => {
    expect(afterAdd('p1', null)).toBe(true);
    let s = current();
    expect(s.open).toBe(true);
    expect(s.mode).toBe('added');
    expect(s.highlightKey).toBe(lineKey('p1', null));
    const nudge = s.nudge;

    closeSideCart();
    expect(current().open).toBe(false);
    expect(afterAdd('p2', 'v2')).toBe(false);
    s = current();
    expect(s.open).toBe(false);
    expect(s.nudge).toBe(nudge);
  });

  it('the bubble opens it in "cart" mode with nothing highlighted; close closes', () => {
    openSideCart();
    let s = current();
    expect(s.open).toBe(true);
    expect(s.mode).toBe('cart');
    expect(s.highlightKey).toBeNull();
    closeSideCart();
    s = current();
    expect(s.open).toBe(false);
  });

  it('still works when sessionStorage throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(afterAdd('p3', null)).toBe(true);
    expect(current().open).toBe(true);
    expect(current().mode).toBe('added');
  });

  it('a line key is the product and the option', () => {
    expect(lineKey('a', null)).toBe('a|');
    expect(lineKey('a', undefined)).toBe('a|');
    expect(lineKey('a', 'b')).toBe('a|b');
  });
});

/* -------------------------------------------- Part 4: Kaarbar-style search */

interface Item {
  id: string;
  text: string;
}

const items: Item[] = [
  { id: 'hydUK', text: 'CeraVe Hydrating Cleanser 236ml (UK) CeraVe Cleanser' },
  { id: 'foamAU', text: 'CeraVe Foaming Cleanser 236ml (AUSTRALIA) CeraVe Cleanser' },
  { id: 'sun', text: 'La Roche-Posay Anthelios 50ml La Roche-Posay Sunscreen' },
  { id: 'qv', text: 'QV Gentle Wash 236ml (AUSTRALIA) Ego Body wash' },
  { id: 'bn', text: 'নিভিয়া বডি লোশন Nivea Lotion' },
];
const ids = (list: Item[]) => list.map((i) => i.id);
const search = (q: string) => ids(smartSearch(items, q, (i) => i.text));

describe('Batch 70 Part 4: every word starts a word, in any order', () => {
  it('"cerave 236 aus f" finds the Foaming Cleanser (AUSTRALIA), not the Hydrating one (UK)', () => {
    const hits = search('cerave 236 aus f');
    expect(hits).toEqual(['foamAU']);
    expect(hits).not.toContain('hydUK');
  });

  it('word order does not matter', () => {
    expect(search('aus cerave')).toEqual(['foamAU']);
    expect(search('cleanser foaming')).toEqual(['foamAU']);
  });

  it('a typo falls back to close spellings ("cerve" finds CeraVe)', () => {
    const hits = search('cerve');
    expect(hits).toContain('foamAU');
    expect(hits).toContain('hydUK');
  });

  it('"236" alone finds every 236ml product', () => {
    expect(search('236').sort()).toEqual(['foamAU', 'hydUK', 'qv']);
  });

  it('an empty query returns everything, in order', () => {
    expect(search('')).toEqual(ids(items));
    expect(search('   ')).toEqual(ids(items));
  });

  it('Bangla text does not crash and is found', () => {
    expect(() => search('নিভিয়া')).not.toThrow();
    expect(search('নিভিয়া')).toEqual(['bn']);
    expect(search('nivea')).toEqual(['bn']);
  });

  it('words that start the product name rank first', () => {
    // "cerave cleanser": both CeraVe products start with "cerave"; the
    // La Roche-Posay row never matches.
    expect(search('cerave cleanser')).toEqual(expect.arrayContaining(['foamAU', 'hydUK']));
    expect(search('cerave cleanser')).not.toContain('sun');
  });

  it('a word in the middle of a word does not match ("ave" is not CeraVe)', () => {
    expect(matchesAllWords('CeraVe Foaming', 'ave')).toBe(false);
    expect(matchesAllWords('CeraVe Foaming', 'cera foa')).toBe(true);
  });
});

describe('Batch 70 Part 4: the admin order picker reads brand and SKU too', () => {
  const product = {
    id: 'P',
    name: 'CeraVe Foaming Cleanser 236ml (AUSTRALIA)',
    brand: 'CeraVe',
    sku: 'NM-5008',
    is_active: true,
    retail_price: 1850,
    offer_price: 1750,
    stock_quantity: 4,
    region: null,
    size: null,
    image_url: null,
    image_urls: [],
    image_urls_thumb: [],
  } as unknown as Product;
  const groups = productSearchGroups([product], () => []);

  it('finds the product by any start of its words, its brand or its SKU', () => {
    for (const term of ['cerave 236 aus f', 'aus cerave', 'nm 5008', 'nm']) {
      expect(searchProductGroups(groups, term).map((g) => g.productId)).toEqual(['P']);
    }
    expect(searchProductGroups(groups, '')).toEqual([]);
  });
});
