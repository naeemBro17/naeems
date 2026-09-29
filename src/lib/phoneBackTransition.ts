import { runExclusiveTransition, isTransitionRunning, setHeroReverseTarget } from './heroTransition';
import { clearHeroNames, prefersReducedMotion, supportsViewTransitions } from './viewTransition';

/**
 * THE switch for the phone-back reverse hero (fix/back-known-good Part 3,
 * step 2). `false` means a phone/browser Back off a product page is a clean
 * instant switch — the guaranteed baseline. `true` means it tries the
 * reverse-hero morph below instead. See reports/fix-back-known-good.txt for
 * why it is set the way it is.
 */
export const PHONE_BACK_HERO_ENABLED = true;

/**
 * Called by lib/appHistory.ts for a phone/browser Back (never for the in-app
 * <- button, which drives its own transition — see lib/viewTransition.ts's
 * navigateBack — and never for any forward navigation). `applyRoute` hands
 * the Back to react-router and commits it synchronously; it has NOT run yet
 * when this is called, so the page on screen is still the product page.
 *
 * Returns true when it took over (it then runs `applyRoute` itself, inside
 * `document.startViewTransition`, so the browser's "before" picture is
 * captured from the product page that is genuinely still on screen — the
 * route update is held back until the browser asks for it, instead of racing
 * a separate listener). Returns false to mean "not mine": the caller then
 * applies the route instantly, exactly as if this module did not exist.
 */
export function tryPhoneBackHero(applyRoute: () => void, leavingProductId: string | null, hasUAVisualTransition: boolean): boolean {
  if (!PHONE_BACK_HERO_ENABLED) return false;
  if (!leavingProductId) return false;
  // The browser already played its own back animation (e.g. a predictive
  // back-swipe preview) — a second one on top would be the double motion
  // this whole fix exists to remove.
  if (hasUAVisualTransition) return false;
  if (!supportsViewTransitions() || prefersReducedMotion()) return false;
  // Another transition still animating: its snapshots are already taken, so
  // an instant switch underneath it is the only thing that can't glitch.
  if (isTransitionRunning()) return false;

  void runExclusiveTransition(async () => {
    setHeroReverseTarget(leavingProductId);
    document.documentElement.classList.add('vt-hero');
    const transition = document.startViewTransition(applyRoute);
    transition.ready.catch(() => undefined);
    try {
      await transition.finished;
    } catch {
      // A skipped transition has still applied the route — only cleanup left.
    } finally {
      document.documentElement.classList.remove('vt-hero');
      setHeroReverseTarget(null);
      clearHeroNames();
    }
  });
  return true;
}
