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

/** Movement below this, on either axis, is noise — not yet a confirmed gesture. */
const DIRECTION_LOCK_PX = 10;

/**
 * Touch swipe detection on a single element.
 *
 * The touchmove listener is registered natively with `{ passive: false }`:
 * React's synthetic touchmove is attached to the root as a passive listener,
 * where preventDefault() is ignored (and warns). Without preventDefault the
 * gesture scrolls the page underneath the tile while the tile also moves,
 * which is exactly the behaviour this has to avoid.
 *
 * preventDefault is only called once the gesture is confirmed to run along
 * this element's own axis (movement on that axis clearly exceeds the other,
 * past DIRECTION_LOCK_PX) — a horizontal-swipe tile (axis: 'x') never blocks
 * a finger that's actually scrolling the page vertically. `touch-action`
 * in CSS (e.g. pan-y on a horizontal swiper) covers the same ground for
 * browsers that honour it before JS even runs; both are applied.
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

    let startX = 0;
    let startY = 0;
    let tracking = false;
    /** Set once movement is confirmed to run along this element's axis. */
    let locked = false;

    const coord = (touch: Touch) => (axis === 'y' ? touch.clientY : touch.clientX);

    const handleStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      locked = false;
    };

    const handleMove = (e: TouchEvent) => {
      if (!tracking) return;
      const touch = e.touches[0];
      if (!touch) return;
      if (!locked) {
        const dx = Math.abs(touch.clientX - startX);
        const dy = Math.abs(touch.clientY - startY);
        const along = axis === 'y' ? dy : dx;
        const across = axis === 'y' ? dx : dy;
        if (along <= DIRECTION_LOCK_PX || along <= across) return;
        locked = true;
      }
      // Confirmed along this element's own axis — keep the gesture inside
      // the tile instead of letting the page scroll underneath it too.
      e.preventDefault();
    };

    const handleEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      if (!locked) return;
      const touch = e.changedTouches[0];
      if (!touch) return;
      const delta = coord(touch) - (axis === 'y' ? startY : startX);
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
