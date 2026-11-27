// Batch 71: the floating bottom bar (components/viewer/BottomNav.tsx).
import { useSyncExternalStore } from 'react';

export type NavTab = 'home' | 'shop' | 'search' | 'account';

/** It hides after this much scrolling down (px)... */
export const NAV_HIDE_AFTER_PX = 24;
/** ...and comes back after this much scrolling up (or at the top). */
export const NAV_SHOW_AFTER_PX = 12;

/** The tab shown as active, or null where the bar is not shown at all
 *  (product, cart, checkout, account, orders, admin...). Brands belong to
 *  the Shop tab. */
export function showsBottomNav(pathname: string): NavTab | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/') return 'home';
  if (path === '/shop' || path === '/brands' || path.startsWith('/brand/')) return 'shop';
  if (path === '/search') return 'search';
  return null;
}

/** The query words the product grid reads. */
const GRID_PARAMS = ['cat', 'brand', 'skin', 'q', 'sort'] as const;

/** An old Home link that meant the grid ("/?cat=face-care") -> the same
 *  query on /shop; null when the visit is for the Home itself. */
export function shopRedirectFor(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!GRID_PARAMS.some((key) => params.has(key))) return null;
  return `/shop?${params.toString()}`;
}

/**
 * Hide on a scroll down, show on a scroll up. `anchor` is where the last
 * change of direction started; returns the new visibility and anchor.
 */
export function navAfterScroll(
  state: { visible: boolean; anchor: number },
  y: number
): { visible: boolean; anchor: number } {
  if (y <= 0) return { visible: true, anchor: 0 };
  if (state.visible) {
    if (y < state.anchor) return { visible: true, anchor: y };
    if (y - state.anchor >= NAV_HIDE_AFTER_PX) return { visible: false, anchor: y };
    return state;
  }
  if (y > state.anchor) return { visible: false, anchor: y };
  if (state.anchor - y >= NAV_SHOW_AFTER_PX) return { visible: true, anchor: y };
  return state;
}

/* The bar's visibility, shared with the cart bubble (it keeps clear of the
   bar while it shows, like the product page's buy bar). */
let navShown = true;
const navListeners = new Set<() => void>();

export function setNavShown(next: boolean): void {
  if (next === navShown) return;
  navShown = next;
  navListeners.forEach((listener) => listener());
}

function subscribeNav(listener: () => void): () => void {
  navListeners.add(listener);
  return () => {
    navListeners.delete(listener);
  };
}

function navSnapshot(): boolean {
  return navShown;
}

export function useNavShown(): boolean {
  return useSyncExternalStore(subscribeNav, navSnapshot, navSnapshot);
}
