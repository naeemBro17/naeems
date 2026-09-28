import { useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Every actual page-transition ANIMATION now lives in exactly one place: the
 * native View Transitions API, driven either by lib/viewTransition.ts (a
 * forward/lateral in-app tap) or lib/navigationTransitions.ts (any real
 * back/forward traversal — phone back, browser Back/Forward, and the in-app
 * "<-" button, which is just a traversal too). This component no longer
 * animates anything itself — see fix-one-transition-system's task doc for
 * why a second, manual CSS-class mechanism layered on top of the native one
 * was the root cause of a hard-cut-then-delayed-second-animation bug.
 *
 * What's left: `key={location.pathname}` forces a real unmount+remount on
 * every route change (not just a re-render) — several pages (ViewerPage's
 * scroll restoration, ProductDetailPage's per-slug state) depend on mounting
 * fresh rather than updating in place.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <div key={location.pathname}>{children}</div>;
}
