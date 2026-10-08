import { describe, expect, it } from 'vitest';
import { isStockError, lineKey, stockChanges, type LiveStock } from './cartStock';

function live(entries: [string, string | null, LiveStock][]): Map<string, LiveStock> {
  return new Map(entries.map(([p, v, s]) => [lineKey(p, v), s]));
}

describe('Batch 33 — cart stock changes', () => {
  it('removes a sold-out line and lowers a line to what is left', () => {
    const changes = stockChanges(
      [
        { productId: 'a', variantId: null, quantity: 2 },
        { productId: 'b', variantId: 'v1', quantity: 3 },
        { productId: 'c', variantId: null, quantity: 1 },
      ],
      live([
        ['a', null, { name: 'CeraVe Foaming Cleanser', label: null, available: 0 }],
        ['b', 'v1', { name: 'Sunscreen', label: 'AU · 50ml', available: 1 }],
        ['c', null, { name: 'Toner', label: null, available: 5 }],
      ])
    );
    expect(changes).toEqual([
      { productId: 'a', variantId: null, name: 'CeraVe Foaming Cleanser', label: null, available: 0 },
      { productId: 'b', variantId: 'v1', name: 'Sunscreen', label: 'AU · 50ml', available: 1 },
    ]);
  });

  it('leaves uncounted products and unknown lines alone; never below zero', () => {
    const changes = stockChanges(
      [
        { productId: 'a', variantId: null, quantity: 9 },
        { productId: 'x', variantId: null, quantity: 1 },
        { productId: 'n', variantId: null, quantity: 1 },
      ],
      live([
        ['a', null, { name: 'A', label: null, available: null }],
        ['n', null, { name: 'N', label: null, available: -2 }],
      ])
    );
    expect(changes).toEqual([{ productId: 'n', variantId: null, name: 'N', label: null, available: 0 }]);
  });

  it('recognises place_order stock refusals only', () => {
    expect(isStockError('Only 1 of "CeraVe" left in stock.')).toBe(true);
    expect(isStockError('"CeraVe" is out of stock.')).toBe(true);
    expect(isStockError('"CeraVe" is no longer available.')).toBe(true);
    expect(isStockError('Invalid or expired code')).toBe(false);
    expect(isStockError(null)).toBe(false);
  });
});
