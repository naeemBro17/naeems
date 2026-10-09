import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router-dom';
import App from './App';
import { appHistory } from './lib/appHistory';
import { pageForPath, preloadShopPages } from './lib/routePages';
import { trackInputModality } from './lib/inputModality';
import './styles/tokens.css';
import './styles/app.css';
import './styles/orderTracking.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

// Hands scroll position on Back/Forward entirely to the app instead of the
// browser's own guess — in an SPA, the browser decides that BEFORE React
// has rendered the new page's real content, so its restored position and
// React's actual layout routinely disagree and visibly fight each other
// (see reports/batch-18.txt Part 6). lib/appHistory.ts saves each entry's
// position as it's left, and PageTransition's ScrollRestorer puts it back
// before the returned-to page's first frame paints.
if ('scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

// Batch 34 Part 5: keyboard or finger — decides whether focus rings show.
trackInputModality();

// Batch 29 Part 7: a direct visit to a page's link starts that page's own
// file downloading right away, alongside the main one, instead of after it.
void pageForPath(window.location.pathname)
  ?.preload()
  .catch(() => undefined);

// Batch 33: the old photo cache could hold broken answers it could not see
// (see vite.config.ts) — the worker now uses a new one, so drop the old.
if (typeof caches !== 'undefined') {
  void caches.delete('supabase-storage-images').catch(() => undefined);
}

createRoot(rootElement).render(
  <StrictMode>
    {/* Same as BrowserRouter, but on a history object this app owns — see
        lib/appHistory.ts for why every Back has to pass through it first. */}
    <HistoryRouter history={appHistory}>
      <App />
    </HistoryRouter>
  </StrictMode>
);

// Then, once the first page is up and the phone is idle, the other shop
// pages (product page first) so every tap opens at once.
preloadShopPages();

// Batch 31 Part 7: the offline helper (service worker) and quick, safe app
// updates — registered after the page has loaded, never before first paint.
const startUpdates = () =>
  void import('./lib/appUpdateStart')
    .then(({ startAppUpdates }) => startAppUpdates((onChange) => appHistory.listen(() => onChange())))
    .catch(() => undefined);
if (document.readyState === 'complete') startUpdates();
else window.addEventListener('load', startUpdates, { once: true });
