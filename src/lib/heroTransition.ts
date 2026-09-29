/**
 * Small shared state two unrelated parts of the tree need to agree on for a
 * native View Transition to look right — see reports/batch-21.txt Part 1.
 *
 * 1. `runExclusiveTransition` — queues every `document.startViewTransition`
 *    call (a forward tap or the in-app <- via lib/viewTransition.ts, or a
 *    phone back via lib/phoneBackTransition.ts) so one always fully
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
let runningCount = 0;

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
  runningCount += 1;
  const tracked = async () => {
    try {
      await work();
    } finally {
      runningCount -= 1;
    }
  };
  const run = transitionQueue.then(tracked, tracked);
  transitionQueue = run.catch(() => undefined);
  return run;
}

/** True while any queued transition has not fully finished yet. */
export function isTransitionRunning(): boolean {
  return runningCount > 0;
}

let heroReverseTarget: string | null = null;

export function setHeroReverseTarget(productId: string | null): void {
  heroReverseTarget = productId;
}

export function getHeroReverseTarget(): string | null {
  return heroReverseTarget;
}

/**
 * Where on the page each product was last opened from. A featured product is
 * on Home TWICE — in a bento tile and in the grid — and if both copies claim
 * the returning product's view-transition-name, Chrome aborts the whole
 * transition ("Unexpected duplicate view-transition-name"): exactly the hard
 * cut with no reverse hero Naeem's phone showed for the top grid cards, which
 * are the featured ones. So only the copy the shopper actually tapped claims
 * it; a product opened some other way (a deep link) falls back to the grid.
 */
export type HeroOrigin = 'grid' | 'bento-stack' | 'bento-flip';

const openedFrom = new Map<string, HeroOrigin>();

export function rememberHeroOrigin(productId: string, origin: HeroOrigin): void {
  openedFrom.set(productId, origin);
}

function isFrom(productId: string, origin: HeroOrigin): boolean {
  return (openedFrom.get(productId) ?? 'grid') === origin;
}

/** The reverse-hero target, but only for the copy at `origin`. */
export function heroReverseTargetFor(origin: HeroOrigin): string | null {
  const id = heroReverseTarget;
  return id !== null && isFrom(id, origin) ? id : null;
}

/** The product being returned from, but only for the copy at `origin`. */
export function returningFromProductIdFor(origin: HeroOrigin): string | null {
  const id = getReturningFromProductId();
  return id !== null && isFrom(id, origin) ? id : null;
}

/**
 * The product a Back navigation is leaving, set for the one synchronous
 * render of the page being returned to — whether or not that Back animates
 * (a phone back is an instant switch; see lib/appHistory.ts). BentoGrid reads
 * it while mounting so the swipe stack / flip tile comes back showing the
 * exact product that was opened, not its default first card.
 */
let returningFromProductId: string | null = null;

export function setReturningFromProductId(productId: string | null): void {
  returningFromProductId = productId;
}

export function getReturningFromProductId(): string | null {
  return returningFromProductId ?? heroReverseTarget;
}

/**
 * The product id ProductDetailPage is currently showing, if any — set in an
 * effect there, read the moment a Back starts, before React has processed
 * it (lib/viewTransition.ts's navigateBack for the in-app <-, and
 * lib/appHistory.ts for a phone back), so leaving a product page can
 * reverse-hero morph into, or restore, the exact card it came from.
 */
let currentDetailProductId: string | null = null;

export function setCurrentDetailProductId(productId: string | null): void {
  currentDetailProductId = productId;
}

export function getCurrentDetailProductId(): string | null {
  return currentDetailProductId;
}
