/**
 * Small shared state two unrelated parts of the tree need to agree on for a
 * native View Transition to look right — see reports/batch-21.txt Part 1.
 *
 * 1. `runExclusiveTransition` — queues every `document.startViewTransition`
 *    call (a forward tap via lib/viewTransition.ts, or a back/forward
 *    traversal via lib/navigationTransitions.ts) so one always fully
 *    finishes before the next one starts. The browser only allows one
 *    active transition per document; starting a second one while the first
 *    is still animating doesn't queue politely on its own — it aborts the
 *    FIRST one with "Transition was aborted because of invalid state"
 *    (caught opening a product then immediately tapping back, before the
 *    open's ~320ms hero animation had actually finished — real, reproduced
 *    by fix-one-transition-system's own e2e suite). Simply checking "is one
 *    active, skip mine if so" doesn't fix this: skipping doesn't stop the
 *    browser's OWN default (non-intercepted) handling of the second
 *    navigation from mutating the DOM out-of-band while the first
 *    transition is still capturing/animating, which is what actually
 *    triggers the abort. Awaiting this queue before doing anything else
 *    means the DOM genuinely doesn't change again until the browser has
 *    fully finished the previous one.
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

let transitionQueue: Promise<void> = Promise.resolve();

/**
 * Runs `work` only once every previously-queued transition has fully
 * settled, and queues anything scheduled after it the same way. `work`
 * itself is responsible for starting (and awaiting) its own
 * `document.startViewTransition` call. Returns a promise resolving once
 * THIS `work` call has finished, for a caller that needs to know (the
 * Navigation API's `intercept()` handler reports done via its own returned
 * promise).
 */
export function runExclusiveTransition(work: () => Promise<void>): Promise<void> {
  const run = transitionQueue.then(work, work);
  transitionQueue = run.catch(() => undefined);
  return run;
}

let heroReverseTarget: string | null = null;

export function setHeroReverseTarget(productId: string | null): void {
  heroReverseTarget = productId;
}

export function getHeroReverseTarget(): string | null {
  return heroReverseTarget;
}

/**
 * The product id ProductDetailPage is currently showing, if any — set in an
 * effect there, read by lib/navigationTransitions.ts the instant a real
 * back/forward traversal's `navigate` event fires (before React has
 * processed it) so leaving a product page reverse-hero morphs into the exact
 * card it came from, whether the trigger was a phone back or the in-app <-
 * button — both are the same traversal now.
 */
let currentDetailProductId: string | null = null;

export function setCurrentDetailProductId(productId: string | null): void {
  currentDetailProductId = productId;
}

export function getCurrentDetailProductId(): string | null {
  return currentDetailProductId;
}
