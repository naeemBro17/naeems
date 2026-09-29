import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router-dom';
import App from './App';
import { appHistory } from './lib/appHistory';
import 'flag-icons/css/flag-icons.min.css';
import './styles/tokens.css';
import './styles/app.css';

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

createRoot(rootElement).render(
  <StrictMode>
    {/* Same as BrowserRouter, but on a history object this app owns — see
        lib/appHistory.ts for why every Back has to pass through it first. */}
    <HistoryRouter history={appHistory}>
      <App />
    </HistoryRouter>
  </StrictMode>
);
