import { useLayoutEffect } from 'react';
import { NavigationType, useLocation, useNavigationType } from 'react-router-dom';
import type { ReactNode } from 'react';
import { documentLoadWasTraverse, recallScroll, rememberScroll } from '../../lib/scrollMemory';

/** How long a restore keeps re-applying itself while a returned-to page is
 *  still growing (images reserving height, a list fetching) before giving up
 *  and leaving the scroll wherever the page's real height allows. */
const RESTORE_WINDOW_MS = 3000;

/** How often, at most, the current page's scroll is re-saved while the
 *  shopper scrolls — so a later Back returns to where they really were, not
 *  where they were when they last left this page. */
const SAVE_THROTTLE_MS = 150;

/** True only for the very first page this document renders — the one whose
 *  "Pop" is really a reload or fresh open, not a Back. */
let isFirstPage = true;

/**
 * Puts the page at `target` now, synchronously, and — when the page isn't
 * tall enough to reach it yet — re-applies it each time the page grows,
 * until it's reached, the window above passes, or the shopper touches the
 * screen themselves (their own scroll always wins). Returns a cleanup.
 */
function restoreScroll(target: number): () => void {
  window.scrollTo({ top: target, behavior: 'instant' });
  if (target <= 0 || window.scrollY >= target - 1) return () => undefined;

  const observer = new ResizeObserver(() => {
    window.scrollTo({ top: target, behavior: 'instant' });
    if (window.scrollY >= target - 1) stop();
  });
  const timer = window.setTimeout(() => stop(), RESTORE_WINDOW_MS);
  const userEvents = ['touchstart', 'wheel', 'keydown'] as const;
  function stop() {
    observer.disconnect();
    window.clearTimeout(timer);
    for (const name of userEvents) window.removeEventListener(name, stop);
  }
  observer.observe(document.body);
  for (const name of userEvents) window.addEventListener(name, stop, { passive: true });
  return stop;
}

/**
 * The one place a page's starting scroll position is decided, for every
 * route. A Back/Forward (phone or in-app) lands exactly where that entry was
 * left — saved by lib/appHistory.ts as it was left, and kept current while
 * the shopper scrolls; any other arrival, including a reload, starts at the
 * top (this is what makes the Expert page always open at its very top
 * instead of wherever Home had been scrolled to).
 *
 * Rendered as the FIRST child inside PageTransition's keyed wrapper, so its
 * layout effect runs after the whole new page is in the DOM but before any
 * of the page's own layout effects (React runs them child-first, in sibling
 * order) — e.g. Home's pinned-chip check already reads the restored
 * position — and before the browser paints the first frame.
 */
function ScrollRestorer() {
  const location = useLocation();
  const navigationType = useNavigationType();

  useLayoutEffect(() => {
    const firstPage = isFirstPage;
    isFirstPage = false;
    const isTraverse =
      navigationType === NavigationType.Pop && (!firstPage || documentLoadWasTraverse());
    const saved = isTraverse ? recallScroll(location.key) : null;
    const stopRestore = restoreScroll(saved ?? 0);

    let timer: number | undefined;
    const save = () => {
      timer = undefined;
      rememberScroll(location.key, window.scrollY);
    };
    const onScroll = () => {
      if (timer === undefined) timer = window.setTimeout(save, SAVE_THROTTLE_MS);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', save);
    return () => {
      stopRestore();
      window.clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', save);
    };
    // Mount-only: the wrapper this lives in remounts on every page change,
    // and a same-page URL update (a filter chip) must never move the scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

/**
 * Every page-transition ANIMATION lives in the native View Transitions API
 * (lib/viewTransition.ts for in-app taps and the in-app "<-",
 * lib/phoneBackTransition.ts for the optional phone-back hero); this
 * component animates nothing itself.
 *
 * `key={location.pathname}` forces a real unmount+remount on every route
 * change (not just a re-render) — several pages (ProductDetailPage's
 * per-slug state, BentoGrid's restore-on-return) depend on mounting fresh.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <div key={location.pathname}>
      <ScrollRestorer />
      {children}
    </div>
  );
}
