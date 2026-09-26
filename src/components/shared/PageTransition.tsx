import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Top-level screens reached from the bottom nav, hamburger menu, or footer —
 * lateral moves between "places", not a drill-down into one item. These never
 * slide (a directional push implies a hierarchy that isn't there); they get a
 * quick crossfade instead. Everything not listed here (product detail, order
 * detail, contact/expert, checkout steps, admin) is a "deeper" screen and
 * slides in from the right, exactly as before.
 */
const TOP_LEVEL_PATHS = new Set([
  '/',
  '/search',
  '/cart',
  '/account',
  '/orders',
  '/return-policy',
  '/delivery',
  '/terms',
  '/privacy',
  '/about',
]);

function isTopLevel(pathname: string): boolean {
  return TOP_LEVEL_PATHS.has(pathname);
}

const SLIDE_MS = 350;
const FADE_MS = 150;

/**
 * Slides each "deeper" route in from the right when navigating forward, and
 * mirrors that exactly (same distance, same easing, opposite edge) when the
 * browser/back button pops history. Top-level-to-top-level moves (e.g. Home
 * <-> Account) crossfade instead — see isTopLevel above.
 *
 * The transition class lives in state, set by an effect keyed on the
 * pathname actually changing, and cleared by its own timer — not recomputed
 * fresh on every render. It used to be a plain per-render class derived from
 * "did the path just change", which a same-path REPLACE right behind a real
 * navigation (e.g. SearchPage syncing ?q= into the URL right after landing)
 * would immediately stomp back to "no class", cutting the just-started
 * animation off after a couple of frames (see reports/fix-animation-audit.txt
 * Part 3). Gating on a real pathname change and owning the class in state
 * means a same-path re-render simply leaves whatever's already playing alone.
 *
 * The animation carries no fill-mode, so the transform is gone the moment it
 * finishes — the fixed bottom nav and sticky headers inside a page are only
 * affected while it runs, and behave normally after.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const isFirstRender = useRef(true);
  const prevPathname = useRef(location.pathname);
  const [transitionClass, setTransitionClass] = useState<string | undefined>(undefined);
  const clearTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (isFirstRender.current) {
      // A cold load reports POP, which would slide/fade the first paint in
      // for no reason — the first render is shown as-is.
      isFirstRender.current = false;
      prevPathname.current = location.pathname;
      return;
    }
    if (location.pathname === prevPathname.current) {
      // Same-page update (query/hash/state) — never (re)trigger a
      // transition, and never touch one already playing.
      return;
    }

    const fromTopLevel = isTopLevel(prevPathname.current);
    const toTopLevel = isTopLevel(location.pathname);
    const direction = navigationType === 'POP' ? 'back' : 'forward';
    // Set by navigateToProductWithHero — a native View Transition is already
    // driving this navigation's motion (the card's image morphing into the
    // detail gallery), so the usual slide-in would just run underneath it.
    const isHeroTransition = (location.state as { hero?: boolean } | null)?.hero === true;
    prevPathname.current = location.pathname;

    window.clearTimeout(clearTimer.current);

    if (isHeroTransition) {
      setTransitionClass(undefined);
      return;
    }

    if (fromTopLevel && toTopLevel) {
      setTransitionClass('page-fade');
      clearTimer.current = window.setTimeout(() => setTransitionClass(undefined), FADE_MS);
    } else {
      setTransitionClass(`page-transition page-transition--${direction}`);
      clearTimer.current = window.setTimeout(() => setTransitionClass(undefined), SLIDE_MS);
    }
  }, [location.pathname, location.state, navigationType]);

  useEffect(() => () => window.clearTimeout(clearTimer.current), []);

  return (
    <div key={location.pathname} className={transitionClass}>
      {children}
    </div>
  );
}
