import type { Product } from '../types';
import { getDisplayPrice } from './pricing';

/**
 * The exact text copied by every Copy button (product cards + detail page):
 * product name and its active display price together, so resellers can paste
 * a ready-to-send quote without retyping the name.
 * Uses getDisplayPrice, so an active offer copies the offer price automatically.
 * Example: "Aveeno Hair Oat Milk Blend Conditioner — ৳1,999"
 */
export function buildCopyText(product: Product): string {
  const { mainPrice } = getDisplayPrice(product);
  const formattedPrice = '৳' + mainPrice.toLocaleString('en-IN');
  return product.name + ' — ' + formattedPrice;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers / non-secure contexts.
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
}
