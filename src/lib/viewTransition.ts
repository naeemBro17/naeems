import { flushSync } from 'react-dom';
import type { NavigateFunction } from 'react-router-dom';
import type { Product } from '../types';

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
 * this one navigation so the two animations never run at once. `product`, the
 * exact row the tapped card was already rendering, is handed along too so the
 * detail page can paint its first frame from it immediately — it never has to
 * wait on a fetch (or even the catalog context) before the transition starts.
 */
export function navigateToProductWithHero(
  navigate: NavigateFunction,
  path: string,
  product: Product
): void {
  const state = { hero: true, product };
  if (typeof document.startViewTransition !== 'function' || prefersReducedMotion()) {
    navigate(path, { state });
    return;
  }
  const transition = document.startViewTransition(() => {
    flushSync(() => navigate(path, { state }));
  });
  // The browser aborts an in-flight transition if the tab is backgrounded
  // (app-switch, notification pull-down, etc.) — an expected outcome, not a
  // bug. The navigation itself already committed above either way; this only
  // stops that abort from surfacing as an unhandled-rejection console error.
  transition.ready.catch(() => undefined);
  transition.finished.catch(() => undefined);
}
