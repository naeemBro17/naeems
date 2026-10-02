import { describe, expect, it } from 'vitest';
import { showsGlassCart } from './GlassCartButton';

describe('showsGlassCart', () => {
  it('shows on Home, Search, All Brands, brand pages and the product page', () => {
    for (const path of ['/', '/search', '/brands', '/brand/cerave', '/product/x']) {
      expect(showsGlassCart(path)).toBe(true);
    }
  });

  it('never on the cart, checkout, account, orders or admin', () => {
    for (const path of [
      '/cart',
      '/checkout/delivery',
      '/checkout/summary',
      '/checkout/success',
      '/account',
      '/orders',
      '/orders/abc',
      '/admin',
      '/admin-access',
      '/contact',
    ]) {
      expect(showsGlassCart(path)).toBe(false);
    }
  });
});
