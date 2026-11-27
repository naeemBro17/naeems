import { useSyncExternalStore } from 'react';

// Batch 70: the side cart's open state, shared by the product page, the
// product cards, the floating cart bubble and the panel itself.
//  - mode 'added': opened by an add; the title says "Added to cart" and the
//    added line is highlighted at the top.
//  - mode 'cart': opened from the bubble; the title says "Your cart".
// The panel opens by itself only on the FIRST add of a visit (this browser
// tab session). Later adds fly into the bubble instead.
export type SideCartMode = 'added' | 'cart';

export interface SideCartState {
  open: boolean;
  mode: SideCartMode;
  /** Cart key of the line just added: `${productId}|${variantId ?? ''}`. */
  highlightKey: string | null;
  /** Bumps every time the panel opens with mode 'added', so the nudge replays. */
  nudge: number;
}

const SESSION_KEY = 'naeems.sideCartShown';
let state: SideCartState = { open: false, mode: 'cart', highlightKey: null, nudge: 0 };
const listeners = new Set<() => void>();

function set(next: SideCartState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export function lineKey(productId: string, variantId: string | null | undefined): string {
  return `${productId}|${variantId ?? ''}`;
}

function shownThisVisit(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markShown(): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    // Private mode: the panel may open once more this visit; nothing breaks.
  }
}

/** After any add. Returns true when the panel opened (first add of the
 *  visit), false when the caller should fly the item into the bubble. */
export function afterAdd(productId: string, variantId: string | null | undefined): boolean {
  if (shownThisVisit()) return false;
  markShown();
  set({ open: true, mode: 'added', highlightKey: lineKey(productId, variantId), nudge: state.nudge + 1 });
  return true;
}

/** Batch 72: an add from inside the open panel ("Complete your routine"):
 *  it stays open and shows the new line highlighted, like any other add. */
export function showAddedInPanel(productId: string, variantId: string | null | undefined): void {
  markShown();
  set({ ...state, open: true, mode: 'added', highlightKey: lineKey(productId, variantId) });
}

export function openSideCart(): void {
  set({ ...state, open: true, mode: 'cart', highlightKey: null });
}

export function closeSideCart(): void {
  if (!state.open) return;
  set({ ...state, open: false });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SideCartState {
  return state;
}

export function useSideCart(): SideCartState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
