import { useEffect, useState } from 'react';

/** Batch 66: what is left until a campaign ends. */
export interface Left {
  d: number;
  h: number;
  m: number;
  s: number;
  done: boolean;
}

export function countdownLeft(end: number, now = Date.now()): Left {
  const ms = Math.max(0, end - now);
  const t = Math.floor(ms / 1000);
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60, done: ms === 0 };
}

/** Ticks on each whole second (lined up with the clock, so two timers on
 *  one screen change together). */
export function useCountdown(endsAt: string): Left {
  const end = new Date(endsAt).getTime();
  const [left, setLeft] = useState<Left>(() => countdownLeft(end));
  useEffect(() => {
    setLeft(countdownLeft(end));
    let id = 0;
    const tick = () => {
      const next = countdownLeft(end);
      setLeft(next);
      if (!next.done) id = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    };
    id = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    return () => window.clearTimeout(id);
  }, [end]);
  return left;
}

export const two = (n: number): string => String(n).padStart(2, '0');

/** "2d 04:05:09" for the cart line tag. */
export function shortLeft(l: Left): string {
  return `${l.d}d ${two(l.h)}:${two(l.m)}:${two(l.s)}`;
}
