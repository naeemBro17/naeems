import type { Product, ToastType } from '../types';
import { getDisplayPrice } from './pricing';
import { formatTaka } from './format';
import { coverImage } from './productImages';

const CARD_SIZE = 1080;
const BRAND_ORANGE = '#F05020';
const DANGER_RED = '#FF3B30';
const TEXT_PRIMARY = '#1C1C1E';
const TEXT_MUTED = '#AEAEB2';
const FONT_STACK = "'Inter', system-ui, -apple-system, sans-serif";
const LOGO_SRC = '/icons/icon-512.png';
const SHARE_TAGLINE = "Shop the full catalog at Naeem's";

/** Load an image element, resolving once it's fully decoded. */
function loadImage(src: string, crossOrigin?: 'anonymous'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${src}`));
    img.src = src;
  });
}

function priceBlock(product: Product): HTMLDivElement {
  const { mainPrice, strikePrice, savePercent } = getDisplayPrice(product);

  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'baseline';
  wrap.style.flexWrap = 'wrap';
  wrap.style.gap = '20px';
  wrap.style.marginTop = '24px';

  const main = document.createElement('span');
  main.textContent = formatTaka(mainPrice);
  main.style.fontSize = '80px';
  main.style.fontWeight = '800';
  main.style.color = BRAND_ORANGE;
  main.style.lineHeight = '1';
  wrap.appendChild(main);

  if (strikePrice !== null) {
    const strike = document.createElement('span');
    strike.textContent = formatTaka(strikePrice);
    strike.style.fontSize = '44px';
    strike.style.fontWeight = '600';
    strike.style.color = TEXT_MUTED;
    strike.style.textDecoration = 'line-through';
    wrap.appendChild(strike);
  }

  if (savePercent !== null) {
    const badge = document.createElement('span');
    badge.textContent = `Save ${savePercent}%`;
    badge.style.fontSize = '36px';
    badge.style.fontWeight = '700';
    badge.style.color = '#fff';
    badge.style.background = DANGER_RED;
    badge.style.padding = '10px 22px';
    badge.style.borderRadius = '999px';
    badge.style.lineHeight = '1';
    wrap.appendChild(badge);
  }

  return wrap;
}

/**
 * Render a 1080x1080 branded product card off-screen and return it as a PNG Blob.
 *
 * The product photo must be loadable with crossOrigin="anonymous" and the
 * storage bucket must send CORS headers, otherwise html2canvas taints the
 * canvas and toBlob throws. The logo is same-origin so it never taints.
 */
export async function generateShareCardImage(product: Product): Promise<Blob> {
  // Preload images first so html2canvas draws them synchronously.
  const photoUrl = coverImage(product);
  const [photo, logo] = await Promise.all([
    photoUrl ? loadImage(photoUrl, 'anonymous').catch(() => null) : Promise.resolve(null),
    loadImage(LOGO_SRC).catch(() => null),
  ]);

  const card = document.createElement('div');
  card.style.position = 'fixed';
  card.style.top = '0';
  // Off-screen but fully laid out (not display:none — html2canvas needs layout).
  card.style.left = '-99999px';
  card.style.width = `${CARD_SIZE}px`;
  card.style.height = `${CARD_SIZE}px`;
  card.style.background = '#FFFFFF';
  card.style.fontFamily = FONT_STACK;
  card.style.display = 'flex';
  card.style.flexDirection = 'column';
  card.style.overflow = 'hidden';
  card.style.boxSizing = 'border-box';

  // --- Photo (top ~65%) ---
  const photoWrap = document.createElement('div');
  photoWrap.style.width = '100%';
  photoWrap.style.height = '65%';
  photoWrap.style.background = '#FFFFFF';
  photoWrap.style.display = 'flex';
  photoWrap.style.alignItems = 'center';
  photoWrap.style.justifyContent = 'center';
  photoWrap.style.overflow = 'hidden';
  if (photo) {
    photo.style.width = '100%';
    photo.style.height = '100%';
    photo.style.objectFit = 'cover';
    photoWrap.appendChild(photo);
  } else {
    photoWrap.style.background = '#F2F2F7';
  }
  card.appendChild(photoWrap);

  // --- Details (bottom ~35%) ---
  const details = document.createElement('div');
  details.style.flex = '1';
  details.style.display = 'flex';
  details.style.flexDirection = 'column';
  details.style.padding = '48px 56px';
  details.style.boxSizing = 'border-box';

  const name = document.createElement('div');
  name.textContent = product.name;
  name.style.fontSize = '54px';
  name.style.fontWeight = '700';
  name.style.color = TEXT_PRIMARY;
  name.style.lineHeight = '1.2';
  name.style.display = '-webkit-box';
  name.style.webkitBoxOrient = 'vertical';
  // Two-line clamp keeps long names readable at thumbnail size.
  (name.style as unknown as Record<string, string>).WebkitLineClamp = '2';
  name.style.overflow = 'hidden';
  details.appendChild(name);

  details.appendChild(priceBlock(product));

  // --- Logo watermark + tagline (bottom) ---
  const footer = document.createElement('div');
  footer.style.marginTop = 'auto';
  footer.style.display = 'flex';
  footer.style.alignItems = 'center';
  footer.style.gap = '20px';

  if (logo) {
    logo.style.width = '72px';
    logo.style.height = '72px';
    logo.style.borderRadius = '16px';
    footer.appendChild(logo);
  }

  const tagline = document.createElement('span');
  tagline.textContent = SHARE_TAGLINE;
  tagline.style.fontSize = '32px';
  tagline.style.fontWeight = '600';
  tagline.style.color = TEXT_MUTED;
  footer.appendChild(tagline);

  details.appendChild(footer);
  card.appendChild(details);

  document.body.appendChild(card);

  try {
    // Lazy-load html2canvas so it only ships when a share is actually triggered.
    const html2canvas = (await import('html2canvas')).default;
    const canvas = await html2canvas(card, {
      width: CARD_SIZE,
      height: CARD_SIZE,
      backgroundColor: '#FFFFFF',
      useCORS: true,
      scale: 1,
      logging: false,
    });
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png')
    );
    if (!blob) throw new Error('Could not encode share image.');
    return blob;
  } finally {
    document.body.removeChild(card);
  }
}

/**
 * Shared "Share This Product" action used by both the card icon and the
 * detail-page header icon. Generates the branded image, then either opens the
 * OS share sheet with the image attached, or falls back to a direct download.
 * The caller owns the per-icon loading/disabled state around this call.
 */
export async function shareProduct(
  product: Product,
  showToast: (message: string, type?: ToastType) => void
): Promise<void> {
  try {
    const blob = await generateShareCardImage(product);
    const file = new File([blob], `${product.sku}-share.png`, { type: 'image/png' });

    if (
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] })
    ) {
      await navigator.share({ files: [file], title: product.name });
      return;
    }

    // File sharing unsupported — download the image so it can be attached manually.
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('Image saved — you can now attach it in your chat app');
  } catch (error) {
    // A user cancelling the native share sheet rejects with AbortError — that's
    // not a failure, so don't show an error toast for it.
    if (error instanceof DOMException && error.name === 'AbortError') return;
    showToast("Couldn't create the share image, try again", 'error');
  }
}
