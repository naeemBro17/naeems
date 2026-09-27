/**
 * Pure matching logic behind BentoGrid's reverse-hero restore — split out so
 * it can be unit-tested without a live catalog (this environment has no
 * admin login to seed enough featured products to exercise every branch
 * through a real browser — see reports/fix-phone-back.txt). BentoGrid.tsx
 * calls these with whatever lib/heroTransition.ts's getHeroReverseTarget()
 * returns; a null target (the common case — most navigations aren't a
 * reverse-hero return at all) always yields "no match" instantly.
 */

interface Identified {
  id: string;
}

/** Which slide of the swipeable stack tile a reverse-hero return targets, if
 *  any — used to restore that exact slide into view (instead of always slide
 *  0) before the transition captures its "after" snapshot. */
export function heroReverseIndexFor(products: Identified[], targetId: string | null): number | null {
  if (!targetId) return null;
  const index = products.findIndex((p) => p.id === targetId);
  return index >= 0 ? index : null;
}

/** Which face of the auto-flipping tile a reverse-hero return targets, if
 *  any — used to freeze the flip on that exact face instead of whatever the
 *  CSS animation happened to be showing when the grid remounted. */
export function heroReverseFaceFor(
  front: Identified | undefined,
  back: Identified | undefined,
  targetId: string | null
): 'front' | 'back' | null {
  if (!targetId) return null;
  if (front && targetId === front.id) return 'front';
  if (back && targetId === back.id) return 'back';
  return null;
}
