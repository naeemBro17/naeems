// Vercel serverless function — Batch 26 Part 5 (brand link previews).
//
// Same idea as api/product-og.ts: link-preview bots don't run JavaScript,
// so vercel.json sends ONLY their requests for /brand/:slug here (a `has`
// user-agent condition). Real visitors always get the normal app.
// Title "<Brand> — Naeem's", a one-line description, and the banner (or
// the logo) as the picture.

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

/** A brand link part is lowercase letters, digits and single hyphens. */
function isSafeSlug(value: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && value.length <= 80;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
<meta property="og:type" content="website">
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

interface BrandRow {
  id: string;
  name: string;
  logo_url: string | null;
  banner_image_url: string | null;
}

export default async function handler(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  const slugParam = req.query.slug;
  const slug = Array.isArray(slugParam) ? slugParam[0] : slugParam;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');

  const fallback = () => {
    res.status(200).send(
      renderHtml({
        title: "Naeem's — Authentic Skincare",
        description: FALLBACK_DESCRIPTION,
        image: FALLBACK_IMAGE,
        url: slug ? `${SITE_URL}/brand/${slug}` : SITE_URL,
      })
    );
  };

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

  if (!slug || !isSafeSlug(slug) || !supabaseUrl || !supabaseAnonKey) {
    fallback();
    return;
  }

  try {
    const headers = { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` };
    const brandRes = await fetch(
      `${supabaseUrl}/rest/v1/brands?select=id,name,logo_url,banner_image_url&slug=eq.${slug}&limit=1`,
      { headers }
    );
    if (!brandRes.ok) {
      fallback();
      return;
    }
    const brand = ((await brandRes.json()) as BrandRow[])[0];
    if (!brand) {
      fallback();
      return;
    }

    let countText = '';
    const countRes = await fetch(
      `${supabaseUrl}/rest/v1/products_view?select=id&brand_id=eq.${brand.id}&is_active=eq.true`,
      { headers: { ...headers, Prefer: 'count=exact', Range: '0-0' } }
    );
    const total = Number(countRes.headers.get('content-range')?.split('/')[1]);
    if (countRes.ok && Number.isFinite(total) && total > 0) {
      countText = ` — ${total} product${total === 1 ? '' : 's'}`;
    }

    res.status(200).send(
      renderHtml({
        title: `${brand.name} — Naeem's`,
        description: `Shop authentic ${brand.name} at Naeem's${countText}.`,
        image: brand.banner_image_url ?? brand.logo_url ?? FALLBACK_IMAGE,
        url: `${SITE_URL}/brand/${slug}`,
      })
    );
  } catch {
    fallback();
  }
}
