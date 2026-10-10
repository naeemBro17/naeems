// Batch 39 Part 5: the pure part of the sitemap — no network, no files —
// so it can be tested (scripts/sitemap-core.test.mjs).
//   one <url> per address (no duplicates; the newest lastmod wins),
//   a stable order (alphabetical by address),
//   never a hidden product, a test product or a test brand.

export const SITE_URL = 'https://naeems-all.vercel.app';

export const STATIC_ROUTES = ['/', '/contact', '/brands', '/about', '/delivery', '/return-policy', '/terms', '/privacy'];

/** Throwaway test data the automated tests create (SKU / slug / name start with "e2e"). */
export function isTestItem(row) {
  return [row.sku, row.slug, row.name].some((v) => typeof v === 'string' && /^e2e[\s_-]/i.test(v.trim()));
}

/**
 * products: [{ slug, sku, name?, updated_at, is_active? }]
 * brands:   [{ id, slug, name?, updated_at }] — only brands with a live product are listed
 * usedBrandIds: brand ids that have at least one live product
 * → [{ loc, lastmod, changefreq }] sorted by loc, one per loc.
 */
export function sitemapEntries(products = [], brands = [], usedBrandIds = new Set()) {
  const byLoc = new Map();
  const add = (path, updatedAt, changefreq) => {
    const loc = `${SITE_URL}${path}`;
    const lastmod = typeof updatedAt === 'string' && updatedAt.length >= 10 ? updatedAt.slice(0, 10) : null;
    const existing = byLoc.get(loc);
    if (!existing) {
      byLoc.set(loc, { loc, lastmod, changefreq });
      return;
    }
    if (lastmod && (!existing.lastmod || lastmod > existing.lastmod)) existing.lastmod = lastmod;
  };
  for (const path of STATIC_ROUTES) add(path, null, 'daily');
  for (const product of products) {
    if (product.is_active === false || isTestItem(product)) continue;
    const key = (product.slug ?? '').trim() || (product.sku ?? '').trim();
    if (!key) continue;
    add(`/product/${key}`, product.updated_at ?? null, 'weekly');
  }
  for (const brand of brands) {
    if (!usedBrandIds.has(brand.id) || isTestItem(brand)) continue;
    const slug = (brand.slug ?? '').trim();
    if (!slug) continue;
    add(`/brand/${slug}`, brand.updated_at ?? null, 'weekly');
  }
  return [...byLoc.values()].sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
}

export function buildXml(entries) {
  const lines = entries.map(
    (e) => `  <url><loc>${e.loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}<changefreq>${e.changefreq}</changefreq></url>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join('\n')}\n</urlset>\n`;
}
