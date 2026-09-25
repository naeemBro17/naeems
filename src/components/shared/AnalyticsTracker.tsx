import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useProducts } from '../../contexts/ProductContext';
import { initAnalytics, trackPageView } from '../../lib/analytics';

/**
 * Renders nothing — just wires Facebook Pixel / GA4 into the router. Lives
 * once near the app root (inside App.tsx) so every route change counts as a
 * pageview on both trackers, the way a normal multi-page site would, even
 * though this is a single-page app and only the first load is a real
 * document navigation (Batch 19 Part 2).
 */
export function AnalyticsTracker() {
  const { settings } = useProducts();
  const location = useLocation();
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (settings.fb_pixel_id.trim() === '' && settings.ga_measurement_id.trim() === '') return;
    initAnalytics(settings.fb_pixel_id, settings.ga_measurement_id);
    if (!hasInitialized.current) {
      hasInitialized.current = true;
      // The very first pageview would otherwise be missed — settings (and
      // so the IDs) only become known after this async fetch resolves,
      // which is after the initial route has already rendered once.
      trackPageView(location.pathname);
    }
    // Only re-run when the IDs themselves change (e.g. admin just saved
    // them) — location changes are handled by the effect below.
  }, [settings.fb_pixel_id, settings.ga_measurement_id]);

  useEffect(() => {
    if (!hasInitialized.current) return;
    trackPageView(location.pathname);
  }, [location.pathname]);

  return null;
}
