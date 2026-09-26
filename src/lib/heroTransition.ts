/**
 * Small shared state two unrelated parts of the tree need to agree on for a
 * native View Transition to look right — see reports/batch-21.txt Part 1.
 *
 * 1. `nativeTransitionActive` — set for the exact synchronous window a
 *    navigation is being driven by `document.startViewTransition` (see
 *    lib/viewTransition.ts). PageTransition checks this so it never also
 *    plays its own manual CSS slide/fade on top of the browser's own
 *    snapshot-based animation — that would show two motions at once.
 * 2. `heroReverseTarget` — the id of the product a "back" navigation is
 *    leaving, set just before that navigation starts. The home grid (and the
 *    bento tiles) read it while rendering their post-navigation frame and,
 *    for the one matching card, tag their image box with the same
 *    view-transition-name the product page's own gallery image carries — so
 *    the browser morphs the big image back into that exact card instead of
 *    just crossfading the whole page. No match (card scrolled out of the
 *    grid's DOM window, or the grid isn't the page being returned to) simply
 *    means no element carries the name on the "new" side, which the browser
 *    already treats as a plain crossfade of that region — the task's own
 *    documented fallback, not an error case to special-case here.
 */

let nativeTransitionActive = false;
let heroReverseTarget: string | null = null;

export function setNativeTransitionActive(active: boolean): void {
  nativeTransitionActive = active;
}

export function isNativeTransitionActive(): boolean {
  return nativeTransitionActive;
}

export function setHeroReverseTarget(productId: string | null): void {
  heroReverseTarget = productId;
}

export function getHeroReverseTarget(): string | null {
  return heroReverseTarget;
}
