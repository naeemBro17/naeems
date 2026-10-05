import { useSyncExternalStore } from 'react';

/**
 * Whether the product page's glass buy bar is on screen (Batch 29 Part 3).
 *
 * The floating glass cart lives outside the page (next to the bottom nav in
 * App.tsx), but on the product page it sits just above the buy bar and
 * slides down and back up together with it. The product page writes the
 * bar's state here; the floating cart reads it.
 *
 *  - 'shown'  — the bar is on screen; the cart sits just above it.
 *  - 'hidden' — the bar slid away on a scroll down; the cart takes its place.
 *  - 'none'   — no bar (no product page, or the product is still loading or
 *               wasn't found); the cart sits low, as if the bar were hidden.
 */
export type BuyBarState = 'shown' | 'hidden' | 'none';

let current: BuyBarState = 'none';
const listeners = new Set<() => void>();

export function setBuyBarState(next: BuyBarState): void {
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): BuyBarState {
  return current;
}

export function useBuyBarState(): BuyBarState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
