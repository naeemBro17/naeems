import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useModalBackClose } from '../../hooks/useModalBackClose';

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Accessible name for the dialog. */
  title: string;
  children: ReactNode;
  /** Batch 31: an icon button shown in the header, left of the close button. */
  headerAction?: ReactNode;
  /** Batch 31: extra class on the panel (e.g. a fixed height for a picker). */
  panelClassName?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Must match the .sheet-panel--closing animation duration in app.css. */
const CLOSE_ANIMATION_MS = 220;

/**
 * Sheet that slides up from the bottom edge over a dimmed backdrop. Traps
 * focus, closes on Escape or a backdrop tap, and locks page scroll while open.
 * Shared by the hamburger menu, the bottom-nav account sheet and the review
 * submission form.
 *
 * Closing keeps the sheet mounted for one animation so it slides back down
 * instead of vanishing.
 */
export function BottomSheet({ isOpen, onClose, title, children, headerAction, panelClassName }: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Batch 31 Part 3: the focus effect below must run only when the sheet
  // opens or closes. Callers often pass a new onClose on every render; with
  // onClose in its dependencies, every keystroke in a search box inside the
  // sheet re-ran it — focus jumped back to the page and then to the first
  // button, and the phone keyboard closed after each letter.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [isRendered, setIsRendered] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);

  // Device/browser back closes the sheet instead of leaving the page.
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
        onCloseRef.current();
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
  }, [isOpen]);

  if (!isRendered) return null;

  return (
    <div
      className={`sheet-backdrop${isClosing ? ' sheet-backdrop--closing' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`sheet-panel${panelClassName ? ` ${panelClassName}` : ''}${isClosing ? ' sheet-panel--closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header">
          <h2 className="sheet-title">{title}</h2>
          {headerAction && <div className="sheet-header__actions">{headerAction}</div>}
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
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
