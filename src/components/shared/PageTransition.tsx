import { useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Slides each route in as it mounts: from the right when navigating forward,
 * from the left when the browser/back button pops history.
 *
 * The animation carries no fill-mode, so the transform is gone the moment it
 * finishes — the fixed bottom nav and sticky headers inside a page are only
 * affected for the 200ms it runs, and behave normally after.
 *
 * Keying on pathname (not the full location) means query or hash changes on
 * the same page don't re-trigger the slide.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  // A cold load reports POP, which would slide the first paint in for no
  // reason — the first render is shown as-is.
  const isFirstRender = useRef(true);
  const animate = !isFirstRender.current;
  isFirstRender.current = false;

  const direction = navigationType === 'POP' ? 'back' : 'forward';
  // Set by navigateToProductWithHero — a native View Transition is already
  // driving this navigation's motion (the card's image morphing into the
  // detail gallery), so the usual slide-in would just run underneath it.
  const isHeroTransition = (location.state as { hero?: boolean } | null)?.hero === true;

  return (
    <div
      key={location.pathname}
      className={
        animate && !isHeroTransition
          ? `page-transition page-transition--${direction}`
          : undefined
      }
    >
      {children}
    </div>
  );
}
