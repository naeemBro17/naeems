/**
 * Homepage scroll restoration across a product visit.
 *
 * ProductCard and the bento tiles record the grid's scroll position before
 * navigating away; ViewerPage reads it back once products have landed, so
 * Back returns the reader to where they were instead of the top of the page.
 */
const SCROLL_KEY = 'grid_scroll_y';
const FLAG_KEY = 'grid_nav_from_product';

/** Call immediately before navigating from the homepage to a product. */
export function rememberGridScroll(): void {
  sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
  sessionStorage.setItem(FLAG_KEY, 'true');
}

/**
 * The scroll position to restore, or null when the homepage wasn't reached by
 * coming back from a product. Reading consumes it, so a later reload starts at
 * the top as normal.
 */
export function takeGridScroll(): number | null {
  if (sessionStorage.getItem(FLAG_KEY) !== 'true') return null;
  const saved = sessionStorage.getItem(SCROLL_KEY);
  sessionStorage.removeItem(FLAG_KEY);
  sessionStorage.removeItem(SCROLL_KEY);
  if (saved === null) return null;
  const y = Number.parseInt(saved, 10);
  return Number.isFinite(y) ? y : null;
}
