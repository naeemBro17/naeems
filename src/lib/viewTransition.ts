import { flushSync } from 'react-dom';
import type { NavigateFunction, NavigateOptions, To } from 'react-router-dom';
import type { Product } from '../types';
import {
  setHeroReverseTarget,
  setNativeTransitionActive,
} from './heroTransition';
import { classifyTransition } from './routeClassification';

/** view-transition-name shared by a product card's image box and the detail
 *  page's gallery box, so the browser morphs one into the other. */
export function productHeroName(productId: string): string {
  return `product-hero-${productId}`;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function supportsViewTransitions(): boolean {
  return typeof document.startViewTransition === 'function';
}

/**
 * Runs `mutate` (a synchronous DOM/router update) inside a native View
 * Transition when the browser supports it and the reader hasn't asked for
 * reduced motion, otherwise just runs it plainly. `htmlClass`, when given, is
 * added to <html> before the transition starts (so ::view-transition-old/new
 * CSS scoped to it applies — see app.css) and removed once it finishes; this
 * is the standard way to give different navigations different transition
 * animations. Also flips the nativeTransitionActive flag PageTransition reads
 * to avoid ever layering its own manual CSS class on top of a native one.
 */
function runWithViewTransition(mutate: () => void, htmlClass?: string, onDone?: () => void): void {
  if (!supportsViewTransitions() || prefersReducedMotion()) {
    mutate();
    onDone?.();
    return;
  }
  if (htmlClass) document.documentElement.classList.add(htmlClass);
  setNativeTransitionActive(true);
  const transition = document.startViewTransition(() => {
    flushSync(mutate);
  });
  const clear = () => {
    setNativeTransitionActive(false);
    if (htmlClass) document.documentElement.classList.remove(htmlClass);
    onDone?.();
  };
  transition.ready.catch(() => undefined);
  transition.finished.then(clear, clear);
}

/**
 * Navigates to a product's detail page using the native View Transitions API
 * so the tapped card's image box morphs into the detail page's gallery box
 * (a shared-element / hero transition) instead of the site's usual slide.
 *
 * Falls back to a plain navigate — an instant change, no animation — when the
 * browser doesn't support the API or the reader has asked for reduced motion.
 * `product`, the exact row the tapped card was already rendering, is handed
 * along in location state so the detail page can paint its first frame from
 * it immediately — it never has to wait on a fetch (or even the catalog
 * context) before the transition starts.
 */
export function navigateToProductWithHero(
  navigate: NavigateFunction,
  path: string,
  product: Product
): void {
  runWithViewTransition(() => navigate(path, { state: { product } }), 'vt-hero');
}

/**
 * The reverse of the above: leaving a product's detail page back to wherever
 * it was opened from. Tags `productId` as the "hero reverse target" for the
 * one frame the destination renders after this navigation — see
 * lib/heroTransition.ts for how the grid/bento cards use that to morph the
 * big image back into the exact card it came from, and what happens when no
 * card matches (a plain crossfade, not an error).
 */
export function navigateBackWithHeroReverse(navigate: NavigateFunction, productId: string): void {
  if (!supportsViewTransitions() || prefersReducedMotion()) {
    navigate(-1);
    return;
  }
  setHeroReverseTarget(productId);
  runWithViewTransition(() => navigate(-1), 'vt-hero', () => setHeroReverseTarget(null));
}

function resolveToPathname(to: To): string | null {
  if (typeof to === 'string') return to.split('?')[0].split('#')[0];
  return to.pathname ?? null;
}

/**
 * Generic replacement for a plain `navigate(to)` / `navigate(-1)` call, used
 * by useAppNavigate (hooks/useAppNavigate.ts) so every in-app-triggered
 * navigation — not just the product hero case — gets the same "no flash,
 * no black frame" native crossfade/slide instead of the manual CSS classes
 * PageTransition falls back to for a navigation it never got to wrap (a real
 * phone back-gesture or browser Back button, which fires outside any of our
 * own click handlers — see reports/batch-21.txt Part 1 for why that one case
 * stays a documented fallback rather than something this helper can reach).
 */
export function navigateWithTransition(
  navigate: NavigateFunction,
  to: To | number,
  options?: NavigateOptions
): void {
  const fromPathname = window.location.pathname;
  const direction: 'forward' | 'back' = typeof to === 'number' ? 'back' : 'forward';
  const toPathname = typeof to === 'number' ? null : resolveToPathname(to);
  const kind = toPathname
    ? classifyTransition(fromPathname, toPathname, direction)
    : direction === 'back'
      ? 'slide-back'
      : 'slide-forward';

  runWithViewTransition(() => {
    if (typeof to === 'number') {
      navigate(to);
    } else {
      navigate(to, options);
    }
  }, `vt-${kind}`);
}
