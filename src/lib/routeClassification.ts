/**
 * Top-level screens reached from the bottom nav, hamburger menu, or footer —
 * lateral moves between "places", not a drill-down into one item. These never
 * slide (a directional push implies a hierarchy that isn't there); they get a
 * quick crossfade instead. Everything not listed here (product detail, order
 * detail, contact/expert, checkout steps, admin) is a "deeper" screen and
 * slides in from the right, exactly as before.
 *
 * Shared by PageTransition (its own fallback CSS classing) and
 * lib/viewTransition.ts (picks the same kind for the native View Transition
 * path) so the two systems never disagree about what a given navigation is.
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

export function isTopLevel(pathname: string): boolean {
  return TOP_LEVEL_PATHS.has(pathname);
}

export type TransitionKind = 'fade' | 'slide-forward' | 'slide-back';

export function classifyTransition(
  fromPathname: string,
  toPathname: string,
  direction: 'forward' | 'back'
): TransitionKind {
  if (isTopLevel(fromPathname) && isTopLevel(toPathname)) return 'fade';
  return direction === 'back' ? 'slide-back' : 'slide-forward';
}
