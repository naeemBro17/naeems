import type { Product, ToastType } from '../types';
import { getDisplayPrice } from './pricing';
import { formatTaka } from './format';

/** Canonical public URL for a product's detail page. */
export function productUrl(product: Product): string {
  return `${window.location.origin}/product/${product.sku}`;
}

/**
 * Open the OS share sheet for a product. Nothing is generated or awaited
 * beforehand, so the sheet appears on the same tap. Where the Web Share API is
 * missing (most desktop browsers) the link is copied instead.
 */
export async function shareProduct(
  product: Product,
  showToast: (message: string, type?: ToastType) => void
): Promise<void> {
  const url = productUrl(product);
  const price = formatTaka(getDisplayPrice(product).mainPrice);

  if (navigator.share) {
    try {
      await navigator.share({
        title: product.name,
        text: `${product.name} — ${price}`,
        url,
      });
    } catch {
      // User cancelled the share sheet — not an error.
    }
    return;
  }

  await navigator.clipboard.writeText(url);
  showToast('Link copied — share it anywhere');
}
