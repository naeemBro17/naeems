import { useEffect, useRef } from 'react';

/**
 * Set right before this hook's own cleanup calls `history.back()` to remove
 * its now-unneeded synthetic entry (Cancel/Confirm/Escape/Save closed it,
 * not a real back-button press). That call still fires one real 'popstate'
 * event on `window` — and every OTHER still-open sheet/modal using this same
 * hook (e.g. a ConfirmDialog nested inside a BottomSheet) also has a
 * listener attached and would otherwise mistake it for the user pressing
 * back, closing itself too. Module-level and shared by every hook instance
 * (not per-instance) because a single popstate event reaches every listener
 * on the page, and needs one shared flag any of them can consult. Each
 * instance clears it after checking so it only ever suppresses the one
 * popstate its own history.back() produced, never a real back press. */
let suppressNextPopstate = false;

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
    // A unique id per push, not just a boolean, so this instance's cleanup
    // can tell whether its entry is still the current one before popping it
    // — see the id check below for why that matters.
    const id = Math.random().toString(36).slice(2);
    window.history.pushState({ modalOpen: true, modalBackCloseId: id }, '');

    const handlePopState = () => {
      if (suppressNextPopstate) {
        suppressNextPopstate = false;
        return;
      }
      pushed = false;
      onCloseRef.current();
    };
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (!pushed) return;
      pushed = false;
      // Closing this way (Cancel/Save/Escape) normally means our pushed
      // entry is still the current one, and popping it is what spares the
      // user an extra back press later. But if a caller closed us AND
      // navigated to a real route in the same handler (e.g. the hamburger
      // menu's "Admin Panel" link: onClose() then navigate('/admin')), that
      // navigate() already pushed a NEWER entry on top of ours by the time
      // this cleanup runs (state updates that trigger it are async; the
      // history push isn't) — a blind history.back() here would pop THAT
      // navigation instead of our own entry, silently bouncing the user
      // right back to where they started. Checking whose entry is actually
      // on top first avoids that.
      if (window.history.state?.modalBackCloseId === id) {
        suppressNextPopstate = true;
        window.history.back();
      }
    };
  }, [isOpen]);
}
