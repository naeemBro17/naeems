import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import type { MyStoreWallet } from '../../lib/storeWallet';
import { readSwr } from '../../lib/swrCache';
import { customerKeyFor, markWalletNoteSeen, readWalletNoteSeen, shouldShowWalletNote } from '../../lib/walletOpenNote';
import { orderNoteGate, subscribeOrderNoteGate, walletNoteMayShow } from '../../lib/orderNotes';

/** Must match .wallet-note's in / out animations (batch64.css). */
const LEAVE_MS = 280;

function JarIcon() {
  return (
    <svg className="wallet-note__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="2.5" width="10" height="3.5" rx="1.2" />
      <path d="M8 6c-1.6 1.1-2.5 2.6-2.5 4.4V18a3.5 3.5 0 003.5 3.5h6a3.5 3.5 0 003.5-3.5v-7.6C18.5 8.6 17.6 7.1 16 6" />
      <circle cx="12" cy="14.5" r="2.6" />
      <path d="M12 13.3v2.4" />
    </svg>
  );
}

/**
 * Batch 64 Part 4: "Your wallet is open", once per customer on this device.
 * `walletOpen` is what the page already knows about her wallet (no new
 * request). Placed above the bottom nav on Home (`aboveNav`).
 */
export function WalletOpenNote({ walletOpen, aboveNav = false }: { walletOpen: boolean; aboveNav?: boolean }) {
  const { session, profile } = useAuth();
  const navigate = useAppNavigate();
  const titleId = useId();
  const isCustomer = Boolean(session) && profile?.role === 'customer';
  const customerKey = session ? customerKeyFor(session.user.id) : null;
  const show =
    customerKey !== null &&
    shouldShowWalletNote({ isCustomer, walletOpen, seen: isCustomer && walletOpen ? readWalletNoteSeen(customerKey) : null });
  const [closed, setClosed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef<number>();
  // Batch 65: a note about her order goes first; this card waits until the
  // note check has answered, and for the next app load after a note.
  const gate = useSyncExternalStore(subscribeOrderNoteGate, orderNoteGate);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  if (!show || closed || customerKey === null || !walletNoteMayShow(gate)) return null;

  const later = () => {
    if (leaving) return;
    markWalletNoteSeen(customerKey);
    setLeaving(true);
    timerRef.current = window.setTimeout(() => setClosed(true), LEAVE_MS);
  };
  const openWallet = () => {
    markWalletNoteSeen(customerKey);
    setClosed(true);
    navigate('/wallet');
  };

  return createPortal(
    <div
      className={`wallet-note${aboveNav ? ' wallet-note--above-nav' : ''}${leaving ? ' wallet-note--leaving' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="wallet-open-note"
    >
      <JarIcon />
      <div className="wallet-note__body">
        <p className="wallet-note__title" id={titleId}>
          Your wallet is open
        </p>
        <p className="wallet-note__text">
          You can now save with us for the products you love. Add any amount and use it on your next order.
        </p>
        <div className="wallet-note__actions">
          <button type="button" className="wallet-note__main" onClick={openWallet}>
            Open my wallet
          </button>
          <button type="button" className="wallet-note__later" onClick={later}>
            Later
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Home: the wallet copy the app already saved on this device (Account,
 *  Wallet page); Home never asks the database for it. */
export function HomeWalletOpenNote() {
  const { session, profile } = useAuth();
  const userId = session && profile?.role === 'customer' ? session.user.id : null;
  const copy = userId ? readSwr<MyStoreWallet>(`wallet:${userId}`) : null;
  const walletOpen = copy !== null && copy.data.available === true && copy.data.open === true;
  return <WalletOpenNote walletOpen={walletOpen} aboveNav />;
}
