import { useEffect, useRef, useState } from 'react';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/**
 * Batch 48: a number that counts to its new value (the checkout Total when
 * the advance discount comes on or off). Ease-out over `durationMs`; with
 * prefers-reduced-motion the new value shows at once. Only the text
 * changes — nothing is animated in layout.
 */
export function useCountTo(target: number, durationMs = 320): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    if (shownRef.current === target) return;
    if (prefersReducedMotion()) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const from = shownRef.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - k, 3);
      const value = k >= 1 ? target : Math.round(from + (target - from) * eased);
      shownRef.current = value;
      setShown(value);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return shown;
}
