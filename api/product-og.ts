// Vercel serverless function — Batch 19 Part 3 (link previews).
//
// Link-preview bots (Facebook, WhatsApp, Twitter, Telegram, Slack, LinkedIn,
// Discord) don't run JavaScript, so a shared /product/:slug link only ever
// sees index.html's one static description — never that product's real
// name/price/photo (see reports/batch-15.txt). vercel.json rewrites
// /product/:slug to this function, but ONLY when the request's User-Agent
// matches one of those bots (a `has` condition on the rewrite) — a real
// visitor's browser always gets the normal single-page app, unchanged and
// with zero extra delay; this function never runs for them at all.
//
// Deliberately typed against the small slice of req/res this file actually
// uses rather than depending on @vercel/node, so no new dependency is
// needed just for this one function.

interface MinimalRequest {
  query: Record<string, string | string[] | undefined>;
}

interface MinimalResponse {
  setHeader(name: string, value: string): void;
  status(code: number): MinimalResponse;
  send(body: string): void;
}

const SITE_URL = 'https://naeems-all.vercel.app';
const FALLBACK_IMAGE = `${SITE_URL}/og-image.png`;
const FALLBACK_DESCRIPTION = 'Premium Australian skincare — check prices instantly';

/** Same shape ProductDetailPage.tsx's safeIdentifier() validates against —
 *  a slug/sku can only ever be alphanumeric plus hyphen/underscore. */
function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,120}$/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTaka(amount: number): string {
  return '৳' + amount.toLocaleString('en-BD');
}

interface OgFields {
  title: string;
  description: string;
  image: string;
  url: string;
}

function renderHtml({ title, description, image, url }: OgFields): string {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeImage = escapeHtml(image);
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<meta name="description" content="${safeDescription}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Naeem's">
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDescription}">
<meta property="og:image" content="${safeImage}">
<meta property="og:url" content="${safeUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeDescription}">
<meta name="twitter:image" content="${safeImage}">
</head>
<body>
<h1>${safeTitle}</h1>
<p>${safeDescription}</p>
</body>
</html>
`;
}

interface ProductRow {
  name: string;
  brand: string | null;
  description: string | null;
  retail_price: number;
  offer_price: number | null;
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

  const fallback = () => {
    res.status(200).send(
      renderHtml({
        title: "Naeem's — Authentic Skincare",
        description: FALLBACK_DESCRIPTION,
        image: FALLBACK_IMAGE,
        url: slug ? `${SITE_URL}/product/${slug}` : SITE_URL,
      })
    );
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
      `select=name,brand,description,retail_price,offer_price,image_url,image_urls` +
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

    const price =
      product.offer_price !== null && product.offer_price < product.retail_price
        ? product.offer_price
        : product.retail_price;
    const image = product.image_urls?.[0] ?? product.image_url ?? FALLBACK_IMAGE;
    const brandPrefix = product.brand ? `${product.brand} — ` : '';
    const description = `${brandPrefix}${formatTaka(price)}${
      product.description ? ` — ${product.description.slice(0, 150)}` : ''
    }`;

    res.status(200).send(
      renderHtml({
        title: `${product.name} — Naeem's`,
        description,
        image,
        url: `${SITE_URL}/product/${slug}`,
      })
    );
  } catch {
    fallback();
  }
}
