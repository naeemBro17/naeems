import { flushSync } from 'react-dom';
import type { NavigateFunction, NavigateOptions, To } from 'react-router-dom';
import type { Product } from '../types';
import { backAndWaitForRoute } from './appHistory';
import { getCurrentDetailProductId, runExclusiveTransition, setHeroReverseTarget } from './heroTransition';
import { prepareHeroCornerMorph } from './heroCorners';

/** view-transition-name shared by a product card's image box and the detail
 *  page's gallery box, so the browser morphs one into the other. */
export function productHeroName(productId: string): string {
  return `product-hero-${productId}`;
}

/**
 * Removes the shared name from every element still carrying one once a
 * reverse hero has finished — the returned-to card keeps its inline name
 * until something re-renders it, and if the shopper then opened the same
 * product from its OTHER copy on the page (a featured product is in a bento
 * tile and the grid), two elements would share the name and Chrome would
 * abort that transition.
 */
export function clearHeroNames(): void {
  document.querySelectorAll<HTMLElement>('[style*="view-transition-name"]').forEach((el) => {
    el.style.removeProperty('view-transition-name');
  });
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function supportsViewTransitions(): boolean {
  return typeof document.startViewTransition === 'function';
}

/**
 * Runs `update` inside a native View Transition started right here, from the
 * tap's own click handler — so the browser captures its "before" picture
 * while the old page is still genuinely on screen, then calls `update`, then
 * captures "after" once `update`'s promise settles. `htmlClass` goes on
 * <html> for the duration (see the vt-* rules in app.css). Queued through
 * lib/heroTransition.ts's runExclusiveTransition so a second transition never
 * starts while one is still animating (that aborts the first). Without View
 * Transitions support, or with reduced motion, `update` just runs — an
 * instant change. `heroName`, for a product hero, also morphs the image's
 * rounded corners between the two ends (lib/heroCorners.ts).
 */
function runWithViewTransition(
  update: () => void | Promise<void>,
  htmlClass: string,
  onDone?: () => void,
  heroName?: string
): void {
  if (!supportsViewTransitions() || prefersReducedMotion()) {
    void Promise.resolve(update()).finally(() => onDone?.());
    return;
  }
  void runExclusiveTransition(async () => {
    document.documentElement.classList.add(htmlClass);
    const morphCorners = heroName ? prepareHeroCornerMorph(heroName) : null;
    const transition = document.startViewTransition(update);
    morphCorners?.(transition);
    // `ready` and `finished` are separate promises — both can reject
    // independently (a skipped/aborted transition), and each needs its own
    // rejection handler or it surfaces as an uncaught error.
    transition.ready.catch(() => undefined);
    try {
      await transition.finished;
    } catch {
      // Skipped/aborted — the update still ran; only cleanup is left.
    } finally {
      document.documentElement.classList.remove(htmlClass);
      onDone?.();
    }
  });
}

/**
 * Navigates to a product's detail page so the tapped card's image box morphs
 * into the detail page's gallery box (a shared-element / hero transition).
 * `product`, the exact row the tapped card was already rendering, is handed
 * along in location state so the detail page can paint its first frame from
 * it immediately — it never has to wait on a fetch before the transition.
 */
export function navigateToProductWithHero(
  navigate: NavigateFunction,
  path: string,
  product: Product
): void {
  runWithViewTransition(
    () => flushSync(() => navigate(path, { state: { product } })),
    'vt-hero',
    undefined,
    productHeroName(product.id)
  );
}

/**
 * Every other in-app forward/lateral navigation (via hooks/useAppNavigate):
 * one quick crossfade. There is no horizontal slide anywhere any more —
 * Back never slides (fix/back-known-good Part 4), and a forward move must be
 * mirrored by its Back (CLAUDE.md motion rules), so forward doesn't either.
 */
export function navigateWithTransition(
  navigate: NavigateFunction,
  to: To,
  options?: NavigateOptions
): void {
  runWithViewTransition(() => flushSync(() => navigate(to, options)), 'vt-fade');
}

/**
 * The in-app "<-" button — the Batch 21 approach restored (it did a clean
 * reverse hero on Naeem's real phone; fix-one-transition-system replaced it
 * with a plain navigate(-1) and that broke it on the device): the click
 * handler starts the View Transition itself, so the "before" picture is the
 * product page, and only then steps back. One improvement over Batch 21:
 * instead of hoping react-router's re-render lands before the browser takes
 * its "after" picture, the update callback waits for lib/appHistory.ts to
 * report the returned-to page as committed (backAndWaitForRoute).
 *
 * Leaving a product page morphs its big image back into the exact card it
 * was opened from (grid, bento or search result — they all carry the same
 * view-transition-name for the returning product, see heroTransition.ts);
 * anything else crossfades. With no in-app history to go back to (a deep
 * link), goes Home instead.
 */
export function navigateBack(navigate: NavigateFunction): void {
  if (window.history.length <= 2) {
    navigateWithTransition(navigate, '/');
    return;
  }
  const heroProductId = getCurrentDetailProductId();
  if (heroProductId) setHeroReverseTarget(heroProductId);
  runWithViewTransition(
    backAndWaitForRoute,
    heroProductId ? 'vt-hero' : 'vt-fade',
    () => {
      if (!heroProductId) return;
      setHeroReverseTarget(null);
      clearHeroNames();
    },
    heroProductId ? productHeroName(heroProductId) : undefined
  );
}
