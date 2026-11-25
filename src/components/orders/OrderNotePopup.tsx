import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { useAuth } from '../../contexts/AuthContext';
import {
  fetchUnseenOrderNote,
  markOrderNoteSeen,
  noteCardAllowedOn,
  setOrderNoteGate,
  type UnseenOrderNote,
} from '../../lib/orderNotes';

/** Must match .onote-pop--out's animations (batch65.css). */
const LEAVE_MS = 260;
/** After the first page has drawn, so the first screen is not slowed. */
const CHECK_AFTER_MS = 1200;

/**
 * Batch 65: a note Naeem wrote about one of her orders, shown once as a
 * floating card (Home, Account, My Orders). Mounted once in the app
 * shell; asks the database once per app load, for a signed-in customer
 * only (`allowed`). View order / OK / tapping outside / Escape mark it
 * seen. On that order's own page the note is shown (and marked seen)
 * there, so the card is dropped.
 */
export function OrderNotePopup({ allowed }: { allowed: boolean }) {
  const [note, setNote] = useState<UnseenOrderNote | null>(null);
  const [leaving, setLeaving] = useState(false);
  const started = useRef(false);
  const closing = useRef(false);
  const mainRef = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  const navigate = useAppNavigate();

  useEffect(() => {
    if (!allowed || started.current) return;
    setOrderNoteGate('waiting');
    const t = window.setTimeout(() => {
      started.current = true;
      void fetchUnseenOrderNote().then((n) => {
        if (n) {
          setNote(n);
          setOrderNoteGate('shown');
        } else {
          setOrderNoteGate('none');
        }
      });
    }, CHECK_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [allowed]);

  // Opening that order's page shows the note there instead.
  useEffect(() => {
    if (note && pathname.replace(/\/+$/, '') === `/orders/${note.order_id}`) setNote(null);
  }, [note, pathname]);

  const visible = allowed && note !== null && noteCardAllowedOn(pathname);

  const close = (then?: () => void) => {
    if (!note || closing.current) return;
    closing.current = true;
    void markOrderNoteSeen(note.order_id);
    setLeaving(true);
    window.setTimeout(() => {
      setNote(null);
      setLeaving(false);
      closing.current = false;
      then?.();
    }, LEAVE_MS);
  };

  useEffect(() => {
    if (!visible) return;
    mainRef.current?.focus({ preventScroll: true });
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!visible || !note) return null;

  return (
    <div className={`onote-pop${leaving ? ' onote-pop--out' : ''}`} data-testid="order-note-popup">
      <div className="onote-pop__dim" onClick={() => close()} aria-hidden="true" />
      <div className="onote-pop__card" role="dialog" aria-modal="true" aria-labelledby="onote-pop-title">
        <div className="onote-pop__head">
          <span className="onote-pop__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <div>
            <p className="onote-pop__eyebrow">Order {note.order_number}</p>
            <h2 className="onote-pop__title" id="onote-pop-title">
              A note about your order
            </h2>
          </div>
        </div>
        <p className="onote-pop__msg">{note.note}</p>
        <p className="onote-pop__sig">Note from Naeem&apos;s</p>
        <div className="onote-pop__btns">
          <button
            ref={mainRef}
            type="button"
            className="onote-pop__main"
            onClick={() => close(() => navigate(`/orders/${note.order_id}`))}
          >
            View order
          </button>
          <button type="button" className="onote-pop__ok" onClick={() => close()}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

/** The app shell's copy: only for a signed-in customer (never staff or a
 *  visitor), by the same role check the wallet card uses. */
export function CustomerOrderNotePopup() {
  const { session, profile } = useAuth();
  return <OrderNotePopup allowed={Boolean(session) && profile?.role === 'customer'} />;
}
