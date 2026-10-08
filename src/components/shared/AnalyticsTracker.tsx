import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useProducts } from '../../contexts/ProductContext';
import { PAGEVIEW_SETTLE_MS, initAnalytics, isExcludedPath, pauseTracking, trackPageView } from '../../lib/analytics';

/**
 * Renders nothing — just wires Facebook Pixel / GA4 into the router. Lives
 * once near the app root (inside App.tsx) so every route change counts as a
 * pageview on both trackers, the way a normal multi-page site would, even
 * though this is a single-page app and only the first load is a real
 * document navigation (Batch 19 Part 2).
 *
 * Batch 34 Part 4: exactly one PageView per page. One effect, one record of
 * the last page counted — the first load, a later arrival of the tracker
 * IDs and a re-render can never count the same page twice. A page that
 * redirects at once (e.g. an empty cart's checkout → /cart) counts only the
 * page the visitor actually lands on. On /admin and /wholesaler-access the
 * trackers are not even loaded, and GA is paused if they were loaded before.
 */
export function AnalyticsTracker() {
  const { settings } = useProducts();
  const { pathname } = useLocation();
  const lastCounted = useRef<string | null>(null);
  const fbId = settings.fb_pixel_id;
  const gaId = settings.ga_measurement_id;

  useEffect(() => {
    if (fbId.trim() === '' && gaId.trim() === '') return;
    if (isExcludedPath(pathname)) {
      pauseTracking(true);
      lastCounted.current = pathname;
      return;
    }
    pauseTracking(false);
    initAnalytics(fbId, gaId);
    if (lastCounted.current === pathname) return;
    const timer = window.setTimeout(() => {
      lastCounted.current = pathname;
      trackPageView(pathname);
    }, PAGEVIEW_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [pathname, fbId, gaId]);

  return null;
}
