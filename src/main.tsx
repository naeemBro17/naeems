import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { setupPopTransitions } from './lib/popNavigation';
import 'flag-icons/css/flag-icons.min.css';
import './styles/tokens.css';
import './styles/app.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

// Must run before <BrowserRouter> ever mounts, so this module's popstate
// listener is registered before react-router's own one — see
// lib/popNavigation.ts for why that ordering is what makes a real phone
// back button get the same native View Transition an in-app tap does.
setupPopTransitions();

// Hands scroll position on Back/Forward entirely to the app instead of the
// browser's own guess — in an SPA, the browser decides that BEFORE React
// has rendered the new page's real content, so its restored position and
// React's actual layout routinely disagree and visibly fight each other
// (see reports/batch-18.txt Part 6: this is exactly what made returning to
// home from /search shake). Only ViewerPage.tsx currently owns scroll
// position on mount (SearchPage does too, but only within its own page);
// everywhere else simply starts at the top, which is what a plain
// `pushState` navigation already did anyway — this only changes Back/
// Forward, which 'auto' restoration applies to and 'manual' doesn't.
if ('scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
