import { flushSync } from 'react-dom';
import type { NavigateFunction } from 'react-router-dom';

/** view-transition-name shared by a product card's image box and the detail
 *  page's gallery box, so the browser morphs one into the other. */
export function productHeroName(productId: string): string {
  return `product-hero-${productId}`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Navigates to a product's detail page using the native View Transitions API
 * so the tapped card's image box morphs into the detail page's gallery box
 * (a shared-element / hero transition) instead of the site's usual slide.
 *
 * Falls back to a plain navigate — an instant change, no animation — when the
 * browser doesn't support the API or the reader has asked for reduced motion.
 * `state: { hero: true }` tells PageTransition to skip its own slide class for
 * this one navigation so the two animations never run at once.
 */
export function navigateToProductWithHero(navigate: NavigateFunction, path: string): void {
  if (typeof document.startViewTransition !== 'function' || prefersReducedMotion()) {
    navigate(path);
    return;
  }
  document.startViewTransition(() => {
    flushSync(() => navigate(path, { state: { hero: true } }));
  });
}
