// Runs before every build (see package.json "prebuild") and writes
// public/sitemap.xml: the fixed public routes plus one <url> per active
// product and per brand with a live product, fetched from products_view
// with the anon key (public data only). Network failure (offline dev
// machine, Supabase hiccup) must never break the build, so any error here
// falls back to the static-routes-only sitemap and exits 0.
// Batch 39: the list itself is built by sitemap-core.mjs — one line per
// address, alphabetical, no hidden / test products — and the file is only
// written when its content changed.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATIC_ROUTES, buildXml, sitemapEntries } from './sitemap-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const target = join(root, 'public', 'sitemap.xml');

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

/** Writes the sitemap only when it differs from what is on disk. */
function writeIfChanged(xml, count) {
  const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (before === xml) {
    console.log(`generate-sitemap: sitemap.xml unchanged (${count} URLs)`);
    return;
  }
  writeFileSync(target, xml);
  console.log(`generate-sitemap: wrote sitemap.xml with ${count} URLs`);
}

async function main() {
  let products = [];
  let brands = [];
  let usedBrandIds = new Set();
  const env = loadEnv();

  if (env) {
    try {
      const headers = { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}` };
      const res = await fetch(`${env.url}/rest/v1/products_view?select=slug,sku,name,updated_at,is_active&is_active=eq.true`, { headers });
      if (res.ok) {
        products = await res.json();
        // Brand pages (Batch 26) — every brand with a live product. Before
        // migration-032 there is no brands table; that is simply skipped.
        const brandRes = await fetch(`${env.url}/rest/v1/brands?select=id,slug,name,updated_at`, { headers });
        const usedRes = await fetch(`${env.url}/rest/v1/products_view?select=brand_id,sku,slug,name&is_active=eq.true&brand_id=not.is.null`, { headers });
        if (brandRes.ok && usedRes.ok) {
          brands = await brandRes.json();
          // A brand whose only live products are test products is not listed.
          usedBrandIds = new Set(
            (await usedRes.json())
              .filter((r) => ![r.sku, r.slug, r.name].some((v) => typeof v === 'string' && /^e2e[\s_-]/i.test(v.trim())))
              .map((r) => r.brand_id)
          );
        }
      } else {
        console.warn(`generate-sitemap: products_view fetch failed (${res.status}), writing static-only sitemap`);
      }
    } catch (err) {
      console.warn('generate-sitemap: could not reach Supabase, writing static-only sitemap:', err.message);
      products = [];
      brands = [];
    }
  } else {
    console.warn('generate-sitemap: no Supabase env vars found, writing static-only sitemap');
  }

  const entries = sitemapEntries(products, brands, usedBrandIds);
  writeIfChanged(buildXml(entries), entries.length);
}

main().catch((err) => {
  console.warn('generate-sitemap: unexpected error, writing static-only sitemap:', err);
  writeIfChanged(buildXml(sitemapEntries([], [], new Set())), STATIC_ROUTES.length);
});
