import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useModalBackClose } from '../../hooks/useModalBackClose';

interface SideDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Accessible name for the dialog. */
  title: string;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Must match the .side-drawer--closing animation duration in app.css. */
const CLOSE_ANIMATION_MS = 280;

/**
 * Panel that slides in from the left edge, over a dimmed backdrop covering
 * the rest of the screen. Same behaviour contract as BottomSheet (focus
 * trap, Escape/backdrop-tap/back-button close, scroll lock) — just a
 * different container, for menus expected to grow into a longer list of
 * links than a bottom sheet suits. Currently only the hamburger menu uses
 * this; BottomSheet itself is untouched for everything else.
 *
 * Closing keeps the drawer mounted for one animation so it slides back out
 * to the left instead of vanishing — the reverse of how it opened, not a
 * different animation, per CLAUDE.md's motion rules.
 */
export function SideDrawer({ isOpen, onClose, title, children }: SideDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [isRendered, setIsRendered] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);

  // Device/browser back closes the drawer instead of leaving the page.
  useModalBackClose(isOpen, onClose);

  useEffect(() => {
    if (isOpen) {
      setIsRendered(true);
      setIsClosing(false);
      return;
    }
    if (!isRendered) return;
    setIsClosing(true);
    const timer = window.setTimeout(() => {
      setIsRendered(false);
      setIsClosing(false);
    }, CLOSE_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen, isRendered]);

  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';

    const panel = panelRef.current;
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? panel)?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;

      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      );
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      previousFocusRef.current?.focus();
    };
  }, [isOpen, onClose]);

  if (!isRendered) return null;

  return (
    <div
      className={`side-drawer-backdrop${isClosing ? ' side-drawer-backdrop--closing' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`side-drawer${isClosing ? ' side-drawer--closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="side-drawer__header">
          <h2 className="side-drawer__title">{title}</h2>
          <button
            type="button"
            className="sheet-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="side-drawer__body">{children}</div>
      </div>
    </div>
  );
}
