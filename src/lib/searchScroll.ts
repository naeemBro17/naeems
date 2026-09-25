/**
 * SearchPage's own scroll restoration across a product visit — the same
 * pattern as lib/gridScroll.ts for the home grid, kept as a separate key
 * space so a visit to a product from search and a visit from home don't
 * clobber each other's "come back to where you were" position.
 */
const SCROLL_KEY = 'search_scroll_y';
const FLAG_KEY = 'search_nav_from_product';

/** Call immediately before navigating from search results to a product. */
export function rememberSearchScroll(): void {
  sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
  sessionStorage.setItem(FLAG_KEY, 'true');
}

/**
 * The scroll position to restore, or null when search wasn't reached by
 * coming back from a product. Reading consumes it, so a later fresh visit
 * to /search starts at the top as normal.
 */
export function takeSearchScroll(): number | null {
  if (sessionStorage.getItem(FLAG_KEY) !== 'true') return null;
  const saved = sessionStorage.getItem(SCROLL_KEY);
  sessionStorage.removeItem(FLAG_KEY);
  sessionStorage.removeItem(SCROLL_KEY);
  if (saved === null) return null;
  const y = Number.parseInt(saved, 10);
  return Number.isFinite(y) ? y : null;
}
