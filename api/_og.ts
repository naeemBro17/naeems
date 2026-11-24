// Batch 52 Part 1 — the link-preview tags every robot-only function shares
// (Facebook, Messenger, WhatsApp, …). A file whose name starts with "_" is
// not a function of its own on Vercel; product-og.ts and combo-og.ts
// import it. Pure: no network, no environment, so the unit tests read it.
//
// No price in any preview (Naeem's brand decision): the picture and the
// name make people tap; the price is seen inside the shop.

export const SITE_URL = 'https://naeems-all.vercel.app';
export const SITE_NAME = "NAEEM'S";

/** The shop's designed wide banner (public/og-shop.jpg, 1200 × 630). */
export const SHOP_IMAGE = `${SITE_URL}/og-shop.jpg`;
export const SHOP_TITLE = "NAEEM'S | 100% Authentic Skincare";
export const SHOP_DESCRIPTION =
  'Imported from Australia, USA, Canada, Korea, Japan, India & UK. Cash on delivery all over Bangladesh.';

export const PRODUCT_DESCRIPTION = '100% authentic. Imported for you.';

export interface PreviewFields {
  title: string;
  description: string;
  image: string;
  imageWidth: number;
  imageHeight: number;
  url: string;
  type: 'website' | 'product';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A product link part: letters, digits, hyphen, underscore. */
export function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,120}$/.test(value);
}

/** A combo link code: 8 lowercase letters / digits (see src/lib/combos.ts). */
export function isComboCode(value: string): boolean {
  return /^[a-z2-9]{8}$/.test(value);
}

/** The shop link (home, and the fallback for anything unknown). */
export function shopPreview(url: string = `${SITE_URL}/`): PreviewFields {
  return {
    title: SHOP_TITLE,
    description: SHOP_DESCRIPTION,
    image: SHOP_IMAGE,
    imageWidth: 1200,
    imageHeight: 630,
    url,
    type: 'website',
  };
}

/** A product link: its own square main photo, shown in full. */
export function productPreview(name: string, image: string | null, url: string): PreviewFields {
  if (!image) return { ...shopPreview(url), title: `${name.trim()} | ${SITE_NAME}`, description: PRODUCT_DESCRIPTION, type: 'product' };
  return {
    title: `${name.trim()} | ${SITE_NAME}`,
    description: PRODUCT_DESCRIPTION,
    image,
    imageWidth: 1200,
    imageHeight: 1200,
    url,
    type: 'product',
  };
}

/** A combo link: its collage picture (made once, when the combo was made). */
export function comboPreview(name: string, productCount: number, image: string | null, url: string): PreviewFields {
  const n = Math.max(0, Math.floor(productCount));
  return {
    title: `${name.trim()}, picked for you by ${SITE_NAME}`,
    description: `${n} product${n === 1 ? '' : 's'}, hand-picked by Naeem. 100% authentic.`,
    image: image ?? SHOP_IMAGE,
    imageWidth: 1200,
    imageHeight: 630,
    url,
    type: 'website',
  };
}

/** The small HTML page a link-preview robot reads. */
export function renderPreviewHtml(f: PreviewFields): string {
  const title = escapeHtml(f.title);
  const description = escapeHtml(f.description);
  const image = escapeHtml(f.image);
  const url = escapeHtml(f.url);
  const imageType = /\.png(\?|$)/i.test(f.image) ? 'image/png' : /\.webp(\?|$)/i.test(f.image) ? 'image/webp' : 'image/jpeg';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:type" content="${f.type}">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${image}">
<meta property="og:image:secure_url" content="${image}">
<meta property="og:image:type" content="${imageType}">
<meta property="og:image:width" content="${f.imageWidth}">
<meta property="og:image:height" content="${f.imageHeight}">
<meta property="og:image:alt" content="${title}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
<link rel="canonical" href="${url}">
</head>
<body>
<h1>${title}</h1>
<p>${description}</p>
</body>
</html>
`;
}
