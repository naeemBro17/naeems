import { describe, expect, it } from 'vitest';
import { SITE_URL, STATIC_ROUTES, buildXml, sitemapEntries } from './sitemap-core.mjs';

// Batch 39 Part 5: the sitemap generator.
describe('Batch 39 sitemap', () => {
  const products = [
    { slug: 'zeta-cream', sku: 'NM-9', updated_at: '2026-10-08T10:00:00Z' },
    { slug: 'alpha-wash', sku: 'NM-1', updated_at: '2026-09-01T10:00:00Z' },
    // the same address twice (a slug equal to another row's slug)
    { slug: 'alpha-wash', sku: 'NM-2', updated_at: '2026-10-01T10:00:00Z' },
    // no slug → the SKU is the address
    { slug: null, sku: 'NM-3', updated_at: null },
    // hidden and test products are never listed
    { slug: 'hidden-serum', sku: 'NM-4', updated_at: null, is_active: false },
    { slug: 'e2e-b39-a-123', sku: 'E2E-B39-A-123', name: 'E2E B39 Cleanser', updated_at: null },
    { slug: 'some-toner', sku: 'NM-5', name: 'E2E B38 Toner', updated_at: null },
  ];
  const brands = [
    { id: 'b1', slug: 'cerave', updated_at: '2026-08-01T00:00:00Z' },
    { id: 'b2', slug: 'no-live-products', updated_at: null },
    { id: 'b3', slug: 'e2e-brand', updated_at: null },
  ];
  const used = new Set(['b1', 'b3']);

  it('one line per address, the newest date kept', () => {
    const entries = sitemapEntries(products, brands, used);
    const locs = entries.map((e) => e.loc);
    expect(new Set(locs).size).toBe(locs.length);
    expect(entries.find((e) => e.loc.endsWith('/product/alpha-wash'))?.lastmod).toBe('2026-10-01');
  });

  it('stable order: alphabetical by address, whatever order the rows came in', () => {
    const a = sitemapEntries(products, brands, used).map((e) => e.loc);
    const b = sitemapEntries([...products].reverse(), [...brands].reverse(), used).map((e) => e.loc);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
    expect(buildXml(sitemapEntries(products, brands, used))).toBe(buildXml(sitemapEntries([...products].reverse(), brands, used)));
  });

  it('never hidden or test products, never test brands or brands with nothing on sale', () => {
    const xml = buildXml(sitemapEntries(products, brands, used));
    expect(xml).not.toContain('hidden-serum');
    expect(xml).not.toContain('e2e-b39');
    expect(xml).not.toContain('some-toner');
    expect(xml).not.toContain('e2e-brand');
    expect(xml).not.toContain('no-live-products');
    expect(xml).toContain(`${SITE_URL}/brand/cerave`);
    expect(xml).toContain(`${SITE_URL}/product/NM-3`);
  });

  it('the fixed pages are always there', () => {
    const locs = sitemapEntries([], [], new Set()).map((e) => e.loc);
    expect(locs).toHaveLength(STATIC_ROUTES.length);
    for (const path of STATIC_ROUTES) expect(locs).toContain(`${SITE_URL}${path}`);
  });
});
