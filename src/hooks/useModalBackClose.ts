import { useEffect, useRef } from 'react';

/**
 * Makes the device/browser back button close an open sheet or modal instead
 * of navigating the app away from the page underneath it. Without this, a
 * sheet is pure component state with no history entry of its own, so back
 * skips straight past it to whatever route was open before the sheet opened
 * (e.g. all the way to Home from an admin edit sheet).
 *
 * While open, one synthetic history entry is pushed. Real back navigation
 * (hardware/browser back) pops it, which fires 'popstate' and closes the
 * sheet via onClose. Closing any other way (Cancel, backdrop tap, Escape,
 * Save) already calls onClose itself — the effect's cleanup then removes the
 * now-unneeded synthetic entry with a programmatic back, so the user is never
 * left needing an extra back press later.
 */
export function useModalBackClose(isOpen: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    let pushed = true;
    window.history.pushState({ modalOpen: true }, '');

    const handlePopState = () => {
      pushed = false;
      onCloseRef.current();
    };
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (pushed) {
        pushed = false;
        window.history.back();
      }
    };
  }, [isOpen]);
}
