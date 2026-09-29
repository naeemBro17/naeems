import { Action, createBrowserHistory, type History } from '@remix-run/router';
import { flushSync } from 'react-dom';
import { rememberScroll } from './scrollMemory';
import { getCurrentDetailProductId, setReturningFromProductId } from './heroTransition';
import { tryPhoneBackHero } from './phoneBackTransition';

type Listener = Parameters<History['listen']>[0];
type Update = Parameters<Listener>[0];

/**
 * The one browser-history object the whole app runs on (main.tsx hands it to
 * react-router's HistoryRouter — same behaviour as BrowserRouter, which
 * builds exactly this `createBrowserHistory({ v5Compat: true })` internally).
 * Owning it means every route change passes through `wrapListener` below
 * BEFORE react-router sees it, which is what the old design lacked:
 *
 * - The scroll position of the entry being left is saved at that exact
 *   moment (the new page hasn't rendered yet, so window.scrollY is still the
 *   old page's) — see lib/scrollMemory.ts.
 * - A Back is handed to react-router synchronously (flushSync), so the
 *   returned-to page — with its scroll already restored — is complete on the
 *   very first frame, and nothing else updates it a frame later.
 * - A phone/browser Back is applied here, not in a second listener racing
 *   react-router's own (the fix/phone-back and fix-one-transition-system
 *   designs both raced it, and on a real phone react-router won: the page
 *   changed before the transition's "before" picture, so a ghost crossfade
 *   between two near-identical pictures played afterwards).
 */
const browserHistory = createBrowserHistory({ v5Compat: true });

/** Key of the entry currently rendered — `browserHistory.location` already
 *  reads the NEW url by the time a popstate arrives, so it can't say what
 *  is being left. */
let renderedKey = browserHistory.location.key;
let renderedPathname = browserHistory.location.pathname;

let pendingInAppBack: (() => void) | null = null;
let lastPopHadUAVisualTransition = false;

// Registered at module load — before react-router's own popstate listener,
// which is only added when HistoryRouter first subscribes — so this flag is
// already current for the pop that listener is about to deliver.
window.addEventListener('popstate', (event: PopStateEvent) => {
  const withFlag = event as PopStateEvent & { hasUAVisualTransition?: boolean };
  lastPopHadUAVisualTransition = withFlag.hasUAVisualTransition === true;
});

function wrapListener(listener: Listener): Listener {
  const deliver = (update: Update) => {
    renderedKey = update.location.key;
    renderedPathname = update.location.pathname;
    listener(update);
  };

  return (update: Update) => {
    rememberScroll(renderedKey, window.scrollY);

    if (update.action !== Action.Pop) {
      // Push/replace: already inside the caller's own flushSync when it runs
      // under a View Transition (lib/viewTransition.ts), and plain otherwise
      // — e.g. a setSearchParams from an effect, where flushSync isn't
      // allowed.
      deliver(update);
      return;
    }

    // Same pathname = a sheet/modal closing on Back (hooks/useModalBackClose
    // pushes a same-URL entry), never a page change: no hero, no restore.
    const samePage = update.location.pathname === renderedPathname;
    const goingBack = update.delta === null || update.delta < 0;
    const leavingProductId = goingBack && !samePage ? getCurrentDetailProductId() : null;
    const applyRoute = () => {
      setReturningFromProductId(leavingProductId);
      try {
        flushSync(() => deliver(update));
      } finally {
        setReturningFromProductId(null);
      }
    };

    // The in-app <- already started its own View Transition and is waiting
    // inside its update callback for exactly this pop (navigateBack).
    if (pendingInAppBack) {
      const done = pendingInAppBack;
      pendingInAppBack = null;
      applyRoute();
      done();
      return;
    }

    if (tryPhoneBackHero(applyRoute, leavingProductId, lastPopHadUAVisualTransition)) return;
    applyRoute();
  };
}

/** Safety net: a Back that never arrives (history.back() left the site, say)
 *  must not hold a View Transition's frozen frame on screen. */
const IN_APP_BACK_TIMEOUT_MS = 1000;

/**
 * Steps back one entry and resolves once react-router has committed the
 * returned-to page — used as the update callback of the in-app <-'s own View
 * Transition, so the browser's "after" picture is always the real page.
 */
export function backAndWaitForRoute(): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingInAppBack = null;
      resolve();
    }, IN_APP_BACK_TIMEOUT_MS);
    pendingInAppBack = () => {
      window.clearTimeout(timer);
      resolve();
    };
    browserHistory.go(-1);
  });
}

export const appHistory: History = {
  get action() {
    return browserHistory.action;
  },
  get location() {
    return browserHistory.location;
  },
  createHref: (to) => browserHistory.createHref(to),
  createURL: (to) => browserHistory.createURL(to),
  encodeLocation: (to) => browserHistory.encodeLocation(to),
  push: (to, state) => browserHistory.push(to, state),
  replace: (to, state) => browserHistory.replace(to, state),
  go: (delta) => browserHistory.go(delta),
  listen: (listener) => browserHistory.listen(wrapListener(listener)),
};
