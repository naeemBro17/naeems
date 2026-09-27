import {
  getCurrentDetailProductId,
  getLastPathname,
  isNativeTransitionActive,
  setHeroReverseTarget,
  setNativeTransitionActive,
} from './heroTransition';
import { classifyTransition } from './routeClassification';
import { prefersReducedMotion, supportsViewTransitions } from './viewTransition';

/** Resolved by notifyRouteCommitted (called from PageTransition's own
 *  useLayoutEffect) once react-router's popstate-driven location update has
 *  actually committed — see the doc comment on setupPopTransitions for why
 *  this signal, rather than flushSync, is what drives the transition here. */
let pendingResolve: (() => void) | null = null;

/** A real popstate that never causes a route change (e.g. one this app
 *  doesn't otherwise expect) must not leave a transition waiting forever —
 *  that would permanently block every future document.startViewTransition
 *  call, since the browser only allows one active at a time. */
const COMMIT_TIMEOUT_MS = 500;

/**
 * Called from PageTransition's useLayoutEffect after every location commit.
 * A no-op unless a popstate-driven transition is actually waiting on it.
 */
export function notifyRouteCommitted(): void {
  if (pendingResolve) {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve();
  }
}

function runPopTransition(htmlClass: string): void {
  document.documentElement.classList.add(htmlClass);
  setNativeTransitionActive(true);

  const transition = document.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        let settled = false;
        pendingResolve = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        window.setTimeout(() => {
          if (settled) return;
          settled = true;
          pendingResolve = null;
          resolve();
        }, COMMIT_TIMEOUT_MS);
      })
  );

  const clear = () => {
    setNativeTransitionActive(false);
    document.documentElement.classList.remove(htmlClass);
    setHeroReverseTarget(null);
  };
  transition.ready.catch(() => undefined);
  transition.finished.then(clear, clear);
}

/**
 * Makes a genuine phone back button / back gesture (and the browser's own
 * Back/Forward buttons) behave exactly like an in-app tap: a real native
 * View Transition crossfade/slide, with a reverse hero morph off a product
 * page — see reports/fix-phone-back.txt.
 *
 * A phone back fires `popstate` completely outside any of this app's click
 * handlers, so useAppNavigate/navigateWithTransition (lib/viewTransition.ts)
 * can never wrap it — those only run inside a handler THIS app calls. This
 * instead listens for the browser's own popstate directly. react-router's
 * <BrowserRouter> registers its own popstate listener too (inside a layout
 * effect the first time it mounts, i.e. after this module's listener below —
 * call setupPopTransitions() before the app renders, from main.tsx, so this
 * listener is always registered first and therefore always runs first when
 * the event fires).
 *
 * Because this listener runs before react-router's, document.startViewTransition
 * captures its "old" snapshot showing the page still in its current position
 * — nothing has changed yet. react-router's own (completely untouched)
 * popstate handling then runs immediately after, updates its location state,
 * and React re-renders/commits the new page — normal automatic batching, not
 * flushSync, since nothing here drives that update directly. The transition's
 * callback is a Promise that only resolves once notifyRouteCommitted fires
 * from PageTransition's post-commit layout effect, which is what lets the
 * browser wait for the real DOM change before capturing the "new" snapshot,
 * instead of grabbing one a frame too early (the flash bug in
 * reports/batch-21.txt Part 1, here for a different trigger).
 */
export function setupPopTransitions(): void {
  window.addEventListener(
    'popstate',
    () => {
      if (!supportsViewTransitions() || prefersReducedMotion()) return;
      if (isNativeTransitionActive()) return;

      const fromPathname = getLastPathname();
      const toPathname = window.location.pathname;
      const heroProductId = getCurrentDetailProductId();

      if (heroProductId) {
        setHeroReverseTarget(heroProductId);
        runPopTransition('vt-hero');
        return;
      }

      const kind = classifyTransition(fromPathname, toPathname, 'back');
      runPopTransition(`vt-${kind}`);
    },
    { capture: true }
  );
}
