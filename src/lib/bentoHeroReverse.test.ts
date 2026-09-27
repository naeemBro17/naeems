import { describe, expect, it } from 'vitest';
import { heroReverseFaceFor, heroReverseIndexFor } from './bentoHeroReverse';

describe('heroReverseIndexFor', () => {
  const products = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('returns null when there is no reverse-hero target', () => {
    expect(heroReverseIndexFor(products, null)).toBeNull();
  });

  it('finds the index of the targeted product, even when it is not first', () => {
    expect(heroReverseIndexFor(products, 'b')).toBe(1);
    expect(heroReverseIndexFor(products, 'c')).toBe(2);
  });

  it('returns null when the target is not in this list (e.g. a different tile)', () => {
    expect(heroReverseIndexFor(products, 'not-here')).toBeNull();
  });

  it('returns null for an empty product list', () => {
    expect(heroReverseIndexFor([], 'a')).toBeNull();
  });
});

describe('heroReverseFaceFor', () => {
  const front = { id: 'front-id' };
  const back = { id: 'back-id' };

  it('returns null when there is no reverse-hero target', () => {
    expect(heroReverseFaceFor(front, back, null)).toBeNull();
  });

  it('matches the front face', () => {
    expect(heroReverseFaceFor(front, back, 'front-id')).toBe('front');
  });

  it('matches the back face', () => {
    expect(heroReverseFaceFor(front, back, 'back-id')).toBe('back');
  });

  it('returns null when the target matches neither face', () => {
    expect(heroReverseFaceFor(front, back, 'someone-else')).toBeNull();
  });

  it('never crashes and returns null when there is no back face at all (a single-face tile)', () => {
    expect(heroReverseFaceFor(front, undefined, 'back-id')).toBeNull();
    expect(heroReverseFaceFor(front, undefined, 'front-id')).toBe('front');
  });
});
