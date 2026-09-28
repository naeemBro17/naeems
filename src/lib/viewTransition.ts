import { flushSync } from 'react-dom';
import type { NavigateFunction, NavigateOptions, To } from 'react-router-dom';
import type { Product } from '../types';
import { runExclusiveTransition } from './heroTransition';
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
 * animations. Queued through lib/heroTransition.ts's runExclusiveTransition
 * so this never starts a second native transition while a back/forward
 * traversal (lib/navigationTransitions.ts) still has one in flight, or vice
 * versa — see that queue's own doc comment for the abort bug this avoids.
 */
function runWithViewTransition(mutate: () => void, htmlClass?: string, onDone?: () => void): void {
  if (!supportsViewTransitions() || prefersReducedMotion()) {
    mutate();
    onDone?.();
    return;
  }
  runExclusiveTransition(async () => {
    if (htmlClass) document.documentElement.classList.add(htmlClass);
    const transition = document.startViewTransition(() => {
      flushSync(mutate);
    });
    // `ready` and `finished` are separate promises — both can reject
    // independently (e.g. a skipped/aborted transition), and each needs its
    // own rejection handler or it surfaces as an uncaught error even though
    // `finished` below is already handled.
    transition.ready.catch(() => undefined);
    try {
      await transition.finished;
    } catch {
      // A skipped/aborted transition (e.g. reduced-motion toggled mid-flight,
      // or the document going hidden) still needs its class cleared below —
      // nothing more to do here.
    } finally {
      if (htmlClass) document.documentElement.classList.remove(htmlClass);
      onDone?.();
    }
  });
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

function resolveToPathname(to: To): string | null {
  if (typeof to === 'string') return to.split('?')[0].split('#')[0];
  return to.pathname ?? null;
}

/**
 * Generic replacement for a plain `navigate(to)` push/replace call, used by
 * useAppNavigate (hooks/useAppNavigate.ts) so every in-app "go deeper" or
 * "go sideways" navigation — not just the product hero case — gets the same
 * "no flash, no black frame" native crossfade/slide.
 *
 * Deliberately forward/lateral-only: a real "go back" is a browser
 * traversal (`navigate(-1)` calls `history.go(-1)` under the hood, same as a
 * phone back button), so it's handled by lib/navigationTransitions.ts
 * instead — the ONE mechanism for back, in-app button or phone alike. A
 * caller that needs to go back should call plain react-router `useNavigate()`
 * (`navigate(-1)`), not this — see BackButton.tsx, SearchPage.tsx,
 * CollapsingHeader.tsx.
 */
export function navigateWithTransition(
  navigate: NavigateFunction,
  to: To,
  options?: NavigateOptions
): void {
  const fromPathname = window.location.pathname;
  const toPathname = resolveToPathname(to);
  const kind = toPathname ? classifyTransition(fromPathname, toPathname, 'forward') : 'slide-forward';

  runWithViewTransition(() => navigate(to, options), `vt-${kind}`);
}
