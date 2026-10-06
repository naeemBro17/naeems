import { registerSW } from 'virtual:pwa-register';
import { AppUpdateController, CHECK_EVERY_MS, isTextField, markUpdated } from './appUpdate';

/**
 * Registers the service worker and starts the update checks. Called once
 * from main.tsx, after the page has loaded (never holds up the first paint).
 */
export async function startAppUpdates(listen: (onChange: () => void) => void): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  let registration: ServiceWorkerRegistration | undefined;
  let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;

  const controller = new AppUpdateController({
    applyUpdate: () => {
      markUpdated();
      void updateSW?.(true);
    },
    checkForUpdate: () => {
      if (navigator.onLine === false) return;
      void registration?.update().catch(() => undefined);
    },
    pageState: () => ({
      pathname: window.location.pathname,
      dialogOpen: document.querySelector('[aria-modal="true"]') !== null,
      editing: isTextField(document.activeElement),
      typedOnPage: false,
    }),
    isHidden: () => document.visibilityState === 'hidden',
    now: () => Date.now(),
  });

  updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => controller.onUpdateReady(),
    onRegisteredSW: (_url, reg) => {
      registration = reg;
      controller.check(true);
      window.setInterval(() => controller.onTimer(), CHECK_EVERY_MS);
    },
  });

  listen(() => controller.onNavigate());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') controller.onHidden();
    else controller.onVisible();
  });
  window.addEventListener('pointerdown', () => controller.onInteraction(), { capture: true, passive: true });
  window.addEventListener('keydown', () => controller.onInteraction(), { capture: true, passive: true });
  document.addEventListener(
    'input',
    (e) => {
      if (isTextField(e.target as Element | null)) controller.onTyped();
    },
    { capture: true }
  );
}
