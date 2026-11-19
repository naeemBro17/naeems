// Vercel serverless function — Batch 19 Part 3 (link previews); Batch 52
// Part 1 changed the words (no price, "— NAEEM'S").
//
// Link-preview bots (Facebook, WhatsApp, Twitter, Telegram, Slack, LinkedIn,
// Discord) don't run JavaScript, so a shared /product/:slug link only ever
// sees index.html's one static description — never that product's real
// name/photo (see reports/batch-15.txt). vercel.json rewrites
// /product/:slug to this function, but ONLY when the request's User-Agent
// matches one of those bots (a `has` condition on the rewrite) — a real
// visitor's browser always gets the normal single-page app, unchanged and
// with zero extra delay; this function never runs for them at all.
//
// Deliberately typed against the small slice of req/res this file actually
// uses rather than depending on @vercel/node, so no new dependency is
// needed just for this one function. The tags come from ./_og.ts (shared
// with combo-og.ts); the ".js" ending is how Vercel finds it once built.

import { SITE_URL, isSafeIdentifier, productPreview, renderPreviewHtml, shopPreview } from './_og.js';

interface MinimalRequest {
  query: Record<string, string | string[] | undefined>;
}

interface MinimalResponse {
  setHeader(name: string, value: string): void;
  status(code: number): MinimalResponse;
  send(body: string): void;
}

interface ProductRow {
  name: string;
  image_url: string | null;
  image_urls: string[] | null;
}

export default async function handler(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  const slugParam = req.query.slug;
  const slug = Array.isArray(slugParam) ? slugParam[0] : slugParam;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Bots re-fetch a shared link repeatedly; a short cache keeps this
  // function from re-querying Supabase on every single crawl.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');

  const url = slug ? `${SITE_URL}/product/${slug}` : `${SITE_URL}/`;
  const fallback = () => {
    res.status(200).send(renderPreviewHtml(shopPreview(url)));
  };

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

  if (!slug || !isSafeIdentifier(slug) || !supabaseUrl || !supabaseAnonKey) {
    fallback();
    return;
  }

  try {
    const apiUrl =
      `${supabaseUrl}/rest/v1/products_view?` +
      `select=name,image_url,image_urls` +
      `&or=(slug.eq.${slug},sku.eq.${slug})&is_active=eq.true&limit=1`;
    const apiRes = await fetch(apiUrl, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
    });
    if (!apiRes.ok) {
      fallback();
      return;
    }
    const rows = (await apiRes.json()) as ProductRow[];
    const product = rows[0];
    if (!product) {
      fallback();
      return;
    }
    // The main photo, whole and square — nothing drawn on it.
    const image = product.image_urls?.[0] ?? product.image_url ?? null;
    res.status(200).send(renderPreviewHtml(productPreview(product.name, image, url)));
  } catch {
    fallback();
  }
}
