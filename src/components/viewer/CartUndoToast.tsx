import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useCart } from '../../contexts/CartContext';

/** How long "Removed · Undo" stays up. */
export const UNDO_TOAST_MS = 5000;
/** Must match .undo-toast--leaving's animation duration in app.css. */
const LEAVE_MS = 200;

/** Where the toast sits, so it never covers the page's bottom controls. */
function placement(pathname: string): string {
  if (pathname === '/') return 'undo-toast--above-nav';
  if (pathname.startsWith('/product/')) return 'undo-toast--above-buybar';
  if (pathname === '/cart') return 'undo-toast--above-cart-bar';
  return '';
}

/**
 * "Removed · Undo" (Batch 29 Part 4). Every removal — − at 1 on a card, the
 * buy bar or the cart page — happens at once with no dialog, and this glass
 * toast offers to put the line back for 5 seconds. A new removal replaces
 * it; only the latest can be undone. Rendered once next to the floating cart
 * in App.tsx, outside any animated page.
 */
export function CartUndoToast() {
  const { lastRemoved, undoRemove, dismissRemoved } = useCart();
  const location = useLocation();
  const [leaving, setLeaving] = useState(false);
  const removalId = lastRemoved?.id ?? null;

  useEffect(() => {
    if (removalId === null) return;
    setLeaving(false);
    let leaveTimer = 0;
    const showTimer = window.setTimeout(() => {
      setLeaving(true);
      leaveTimer = window.setTimeout(dismissRemoved, LEAVE_MS);
    }, UNDO_TOAST_MS);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(leaveTimer);
    };
  }, [removalId, dismissRemoved]);

  if (!lastRemoved) return null;

  return (
    <div
      key={lastRemoved.id}
      className={`undo-toast ${placement(location.pathname)}${leaving ? ' undo-toast--leaving' : ''}`}
      role="status"
      aria-live="polite"
      data-testid="undo-toast"
    >
      <svg
        className="undo-toast__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 7h16" />
        <path d="M9 7V4.8h6V7" />
        <path d="M6.5 7l.9 12.2h9.2l.9-12.2" />
      </svg>
      <span className="undo-toast__text">Removed</span>
      <button type="button" className="undo-toast__undo" onClick={undoRemove} data-testid="undo-button">
        Undo
      </button>
    </div>
  );
}
