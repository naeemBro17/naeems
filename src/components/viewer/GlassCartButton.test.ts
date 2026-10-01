import { describe, expect, it } from 'vitest';
import { showsGlassCart } from './GlassCartButton';

describe('showsGlassCart', () => {
  it('shows on Home, Search, All Brands and brand pages', () => {
    for (const path of ['/', '/search', '/brands', '/brand/cerave']) expect(showsGlassCart(path)).toBe(true);
  });

  it('never on the product page, cart, checkout, account or admin', () => {
    for (const path of [
      '/product/x',
      '/cart',
      '/checkout/delivery',
      '/checkout/summary',
      '/checkout/success',
      '/account',
      '/orders',
      '/admin',
      '/admin-access',
      '/contact',
    ]) {
      expect(showsGlassCart(path)).toBe(false);
    }
  });
});
