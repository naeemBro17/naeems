import { useEffect, useRef } from 'react';

interface UseSwipeOptions {
  /** Which axis the gesture travels along. */
  axis: 'x' | 'y';
  /** Swipe distance in px before a slide change is committed. */
  threshold?: number;
  /** Called with -1 (back) or +1 (forward) once a swipe passes the threshold. */
  onSwipe: (direction: -1 | 1) => void;
  /** Skip all listeners — used when there is only one slide. */
  enabled: boolean;
}

const DEFAULT_THRESHOLD = 30;

/**
 * Touch swipe detection on a single element.
 *
 * The touchmove listener is registered natively with `{ passive: false }`:
 * React's synthetic touchmove is attached to the root as a passive listener,
 * where preventDefault() is ignored (and warns). Without preventDefault the
 * gesture scrolls the page underneath the tile while the tile also moves,
 * which is exactly the behaviour this has to avoid. `touch-action: none` in
 * CSS covers the same ground for browsers that honour it; both are applied.
 */
export function useSwipe<T extends HTMLElement>({
  axis,
  threshold = DEFAULT_THRESHOLD,
  onSwipe,
  enabled,
}: UseSwipeOptions) {
  const ref = useRef<T>(null);
  // Kept in a ref so re-registering listeners isn't needed when the handler
  // identity changes between renders.
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    let start = 0;
    let tracking = false;

    const coord = (touch: Touch) => (axis === 'y' ? touch.clientY : touch.clientX);

    const handleStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      start = coord(e.touches[0]);
      tracking = true;
    };

    const handleMove = (e: TouchEvent) => {
      if (!tracking) return;
      // Keeps the gesture inside the tile instead of scrolling the page.
      e.preventDefault();
    };

    const handleEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = e.changedTouches[0];
      if (!touch) return;
      const delta = coord(touch) - start;
      if (Math.abs(delta) < threshold) return;
      // A swipe up (negative delta on Y) or left (negative on X) advances.
      onSwipeRef.current(delta < 0 ? 1 : -1);
    };

    el.addEventListener('touchstart', handleStart, { passive: true });
    el.addEventListener('touchmove', handleMove, { passive: false });
    el.addEventListener('touchend', handleEnd, { passive: true });
    el.addEventListener('touchcancel', handleEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleStart);
      el.removeEventListener('touchmove', handleMove);
      el.removeEventListener('touchend', handleEnd);
      el.removeEventListener('touchcancel', handleEnd);
    };
  }, [axis, threshold, enabled]);

  return ref;
}
