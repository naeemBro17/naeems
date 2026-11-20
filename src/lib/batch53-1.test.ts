import { describe, expect, it } from 'vitest';
import { itemKeysInView, itemsKeptInView, needsPrice, type ItemDraft } from './kaarbar/oldSales';

// Batch 53.1: on "Needs you", typing a buying price must not make the row
// leave the list after the first digit.

function draft(key: string, price: string, how: ItemDraft['how'] = 'hidden'): ItemDraft {
  return { key, name: `Test ${key}`, kaarbarPrice: 0, how, choice: null, price, priceFrom: 'none', saved: null };
}

describe('keeping rows in view while typing', () => {
  const start = [draft('a', ''), draft('b', '500'), draft('c', ''), draft('d', '', 'none')];

  it('"Needs you" takes the rows with no product or no price', () => {
    expect([...itemKeysInView(start, 'needs', '')]).toEqual(['a', 'c', 'd']);
  });

  it('a row stays after one digit, and while the rest is typed', () => {
    const keys = itemKeysInView(start, 'needs', '');
    let list = start;
    for (const typed of ['1', '11', '110', '1100']) {
      list = list.map((d) => (d.key === 'a' ? { ...d, price: typed } : d));
      const shown = itemsKeptInView(list, keys);
      expect(shown.map((d) => d.key)).toEqual(['a', 'c', 'd']);
      expect(shown[0].price).toBe(typed);
      expect(needsPrice(shown[0])).toBe(false);
    }
    // Taking the view again (filter / search changed, or saved) drops the finished row.
    expect([...itemKeysInView(list, 'needs', '')]).toEqual(['c', 'd']);
  });

  it('a row stays after its product is chosen', () => {
    const keys = itemKeysInView(start, 'needs', '');
    const list = start.map((d) => (d.key === 'd' ? { ...d, how: 'hidden' as const, price: '90' } : d));
    expect(itemsKeptInView(list, keys).map((d) => d.key)).toEqual(['a', 'c', 'd']);
    expect([...itemKeysInView(list, 'needs', '')]).toEqual(['a', 'c']);
  });

  it('the search and the other filters still narrow the list', () => {
    expect([...itemKeysInView(start, 'all', 'test c')]).toEqual(['c']);
    expect([...itemKeysInView(start, 'hidden', '')]).toEqual(['a', 'b', 'c']);
    expect([...itemKeysInView(start, 'matched', '')]).toEqual([]);
  });
});
