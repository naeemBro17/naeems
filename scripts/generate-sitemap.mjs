// Runs before every build (see package.json "prebuild") and writes
// public/sitemap.xml: the fixed public routes plus one <url> per active
// product, fetched from products_view with the anon key (public data only).
// Network failure (offline dev machine, Supabase hiccup) must never break
// the build, so any error here falls back to the static-routes-only sitemap
// and exits 0.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const SITE_URL = 'https://naeems-all.vercel.app';

function loadEnv() {
  if (process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY) {
    return {
      url: process.env.VITE_SUPABASE_URL,
      anonKey: process.env.VITE_SUPABASE_ANON_KEY,
    };
  }
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return null;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  const vars = {};
  for (const line of lines) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) vars[match[1]] = match[2];
  }
  if (!vars.VITE_SUPABASE_URL || !vars.VITE_SUPABASE_ANON_KEY) return null;
  return { url: vars.VITE_SUPABASE_URL, anonKey: vars.VITE_SUPABASE_ANON_KEY };
}

const STATIC_ROUTES = ['/', '/contact'];

function buildXml(productUrls) {
  const staticEntries = STATIC_ROUTES.map(
    (path) => `  <url><loc>${SITE_URL}${path}</loc><changefreq>daily</changefreq></url>`
  );
  const productEntries = productUrls.map(
    ({ path, updatedAt }) =>
      `  <url><loc>${SITE_URL}${path}</loc>${
        updatedAt ? `<lastmod>${updatedAt.slice(0, 10)}</lastmod>` : ''
      }<changefreq>weekly</changefreq></url>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
    ...staticEntries,
    ...productEntries,
  ].join('\n')}\n</urlset>\n`;
}

async function main() {
  let productUrls = [];
  const env = loadEnv();

  if (env) {
    try {
      const res = await fetch(
        `${env.url}/rest/v1/products_view?select=slug,sku,updated_at&is_active=eq.true`,
        { headers: { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}` } }
      );
      if (res.ok) {
        const rows = await res.json();
        productUrls = rows.map((row) => ({
          path: `/product/${row.slug ?? row.sku}`,
          updatedAt: row.updated_at ?? null,
        }));
      } else {
        console.warn(`generate-sitemap: products_view fetch failed (${res.status}), writing static-only sitemap`);
      }
    } catch (err) {
      console.warn('generate-sitemap: could not reach Supabase, writing static-only sitemap:', err.message);
    }
  } else {
    console.warn('generate-sitemap: no Supabase env vars found, writing static-only sitemap');
  }

  writeFileSync(join(root, 'public', 'sitemap.xml'), buildXml(productUrls));
  console.log(`generate-sitemap: wrote sitemap.xml with ${STATIC_ROUTES.length + productUrls.length} URLs`);
}

main().catch((err) => {
  console.warn('generate-sitemap: unexpected error, writing static-only sitemap:', err);
  writeFileSync(join(root, 'public', 'sitemap.xml'), buildXml([]));
});
