import { useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType, type Location } from 'react-router-dom';
import type { ReactNode } from 'react';
import { isNativeTransitionActive, setLastPathname } from '../../lib/heroTransition';
import { notifyRouteCommitted } from '../../lib/popNavigation';
import { classifyTransition, type TransitionKind } from '../../lib/routeClassification';

const SLIDE_MS = 350;
const FADE_MS = 150;

/**
 * A "back" fallback here only ever plays on a browser with no View
 * Transitions support (or prefers-reduced-motion) — everywhere else, Part 1
 * of reports/fix-phone-back.txt wraps the navigation in a real native
 * transition instead, click or phone back alike. This manual path used to
 * slide the new page in as the one and only element on screen — with the
 * old page already unmounted underneath, that slide's uncovered edge showed
 * bare background, not a real "old page sliding away", which is exactly the
 * black-gap bug the frame-by-frame phone recording caught. A crossfade has
 * no uncovered edge to leak through, so back always gets that instead now;
 * forward keeps its slide (the same single-element mechanics, but never
 * reported as showing a gap, and not this task's scope to change).
 */
function fallbackClassFor(kind: TransitionKind): string {
  if (kind === 'slide-forward') return 'page-transition';
  return 'page-fade';
}

/**
 * Slides each "deeper" route in from the right when navigating forward, and
 * mirrors that exactly (same distance, same easing, opposite edge) when the
 * browser/back button pops history. Top-level-to-top-level moves (e.g. Home
 * <-> Account) crossfade instead — see routeClassification.ts.
 *
 * The animation class is computed DURING RENDER (React's own supported
 * pattern for "derive state from a prop change", the same shape as tracking
 * a previous prop to reset other state — see the React docs on "Adjusting
 * state when a prop changes") rather than in a useEffect. A useEffect only
 * runs after this component's render has already committed and the browser
 * has painted it — which is exactly what let the new page show once, fully,
 * in its final resting position, before the animation class ever arrived a
 * frame later (the "flash + black frame on every transition" bug in
 * reports/batch-21.txt Part 1). Computing the class here means it's already
 * part of the very first commit, so there is never a frame without it.
 *
 * When a navigation is already being driven by a native View Transition
 * (lib/viewTransition.ts — the product hero morph, or any navigation started
 * through useAppNavigate), this component adds no class of its own at all —
 * see isNativeTransitionActive. Doing both would show two animations at
 * once. The one navigation trigger that can never be wrapped in a native
 * transition is a genuine phone back-gesture or the browser's own Back
 * button firing outside any of our click handlers; this component's class
 * is what plays for that one case, and it gets the same before-paint timing
 * fix as everything else.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [prevLocation, setPrevLocation] = useState<Location>(location);
  const [fallbackClass, setFallbackClass] = useState<string | undefined>(undefined);
  const clearTimer = useRef<number | undefined>(undefined);

  if (location.pathname !== prevLocation.pathname) {
    const fromPathname = prevLocation.pathname;
    setPrevLocation(location);

    if (isNativeTransitionActive()) {
      setFallbackClass(undefined);
    } else {
      const direction = navigationType === 'POP' ? 'back' : 'forward';
      const kind = classifyTransition(fromPathname, location.pathname, direction);
      setFallbackClass(fallbackClassFor(kind));
    }
  }

  // Owns clearing the class once its animation has actually had time to
  // play — a timer, not onAnimationEnd, since the fade and slide classes
  // apply two different animations at two different durations and either
  // one might be skipped entirely (prefers-reduced-motion, see app.css).
  useLayoutEffect(() => {
    window.clearTimeout(clearTimer.current);
    if (fallbackClass === undefined) return undefined;
    const ms = fallbackClass.includes('page-fade') ? FADE_MS : SLIDE_MS;
    clearTimer.current = window.setTimeout(() => setFallbackClass(undefined), ms);
    return () => window.clearTimeout(clearTimer.current);
  }, [fallbackClass]);

  // Fires after the new page's OWN layout effects (e.g. ViewerPage's scroll
  // restoration) — React runs layout effects child-first — so by the time a
  // phone-back-driven transition is told the DOM is ready (see
  // lib/popNavigation.ts), the page underneath is already fully settled,
  // not about to jump right after the browser captures its "after" snapshot.
  useLayoutEffect(() => {
    setLastPathname(location.pathname);
    notifyRouteCommitted();
  }, [location.pathname]);

  return (
    <div key={location.pathname} className={fallbackClass}>
      {children}
    </div>
  );
}
