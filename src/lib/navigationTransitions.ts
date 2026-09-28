import { flushSync } from 'react-dom';
import type { NavigateFunction } from 'react-router-dom';
import { getCurrentDetailProductId, runExclusiveTransition, setHeroReverseTarget } from './heroTransition';
import { classifyTransition } from './routeClassification';
import { prefersReducedMotion, supportsViewTransitions } from './viewTransition';

/**
 * THE one mechanism for a real back/forward traversal — a phone hardware
 * back button, a browser gesture, the browser's own Back/Forward buttons,
 * AND every in-app "<-" button (which now just calls plain `navigate(-1)` /
 * `history.back()`, a real traversal like any other — see BackButton.tsx,
 * SearchPage.tsx, CollapsingHeader.tsx). All of them fire the exact same
 * underlying browser event, so there is no separate code path left for the
 * in-app button to diverge from — see fix-one-transition-system's task doc.
 *
 * Registers a `navigate` event listener (the Navigation API — Baseline
 * "Newly Available" Jan 2026). On a browser without `window.navigation`
 * (older Safari/Firefox), this simply never attaches — every traversal on
 * such a browser just gets its own default, un-intercepted handling: an
 * instant change, no animation, per that doc's explicit scope limit. For every
 * `'traverse'` navigation this can intercept, `event.intercept()` is called
 * BEFORE react-router's own popstate-driven history sync ever gets a chance
 * to run — the Navigation API supersedes popstate for an intercepted
 * navigation, so there is no longer a race between "the DOM update" and "the
 * transition snapshot", which is exactly what made the old popstate+Promise
 * approach (lib/popNavigation.ts, deleted) capture its "old" snapshot AFTER
 * the page had already silently changed underneath it (the hard-cut, then a
 * second delayed animation once a 500ms safety timeout finally fired).
 *
 * `intercept()` itself is always called synchronously (required by spec),
 * but the actual work inside `handler` is queued through
 * lib/heroTransition.ts's runExclusiveTransition — opening a product then
 * immediately tapping back, before the open's own hero animation has
 * actually finished, must wait for that one to genuinely settle first, not
 * start a second native transition while the browser still has one active
 * (see that queue's doc comment for the real abort bug this avoids).
 *
 * Inside the handler, the actual route change happens ourselves, wrapped in
 * `flushSync` inside `document.startViewTransition`'s callback — the same
 * proven synchronous pattern lib/viewTransition.ts already uses for a
 * forward tap. For a `'traverse'` navigation the browser has ALREADY moved
 * the session-history index and updated the URL by the time this handler
 * runs (MDN: NavigateEvent.intercept "handler ... runs after currentEntry
 * has been updated") — calling `navigate(toPath, { replace: true })` here
 * doesn't move history again, it just brings react-router's own state in
 * sync with where the browser already is, at the exact synchronous moment
 * the transition needs it.
 *
 * One same-URL traversal is deliberately left alone: `useModalBackClose`
 * pushes a synthetic same-pathname history entry so a phone back closes an
 * open sheet instead of leaving the page, and still needs its own popstate
 * listener to fire normally for that. `toPathname === fromPathname` is that
 * exact case (a modal push/pop never changes the path) — skipped here so
 * `intercept()` is never called and the browser's default handling (which
 * does still dispatch popstate for a NON-intercepted navigation) runs as
 * before.
 */
export function setupNavigationApiTransitions(navigate: NavigateFunction): () => void {
  const navigation = window.navigation;
  if (!navigation) return () => undefined;

  const onNavigate = (event: NavigateEvent) => {
    if (!event.canIntercept) return;
    if (event.hashChange || event.downloadRequest != null) return;
    if (event.navigationType !== 'traverse') return;

    const fromPathname = window.location.pathname;
    const destUrl = new URL(event.destination.url);
    const toPathname = destUrl.pathname;
    if (toPathname === fromPathname) return; // modal-close pop — see doc comment

    const currentIndex = navigation.currentEntry?.index ?? -1;
    const goingBack = currentIndex === -1 ? true : event.destination.index < currentIndex;
    const heroProductId = goingBack ? getCurrentDetailProductId() : null;
    const toPath = `${destUrl.pathname}${destUrl.search}${destUrl.hash}`;

    const applyRoute = () => navigate(toPath, { replace: true });

    if (!supportsViewTransitions() || prefersReducedMotion()) {
      event.intercept({
        handler: () => runExclusiveTransition(async () => flushSync(applyRoute)),
      });
      return;
    }

    const kind = classifyTransition(fromPathname, toPathname, goingBack ? 'back' : 'forward');
    const htmlClass = heroProductId ? 'vt-hero' : `vt-${kind}`;

    event.intercept({
      handler: () =>
        runExclusiveTransition(async () => {
          if (heroProductId) setHeroReverseTarget(heroProductId);
          document.documentElement.classList.add(htmlClass);

          const transition = document.startViewTransition(() => {
            flushSync(applyRoute);
          });

          // `ready` and `finished` are separate promises — both can reject
          // independently, and each needs its own rejection handler or it
          // surfaces as an uncaught error even though `finished` is handled.
          transition.ready.catch(() => undefined);
          try {
            await transition.finished;
          } catch {
            // A skipped/aborted transition still needs its class cleared
            // below — nothing more to do here.
          } finally {
            document.documentElement.classList.remove(htmlClass);
            setHeroReverseTarget(null);
          }
        }),
    });
  };

  navigation.addEventListener('navigate', onNavigate);
  return () => navigation.removeEventListener('navigate', onNavigate);
}
