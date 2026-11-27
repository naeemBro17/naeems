import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BackButton } from '../components/shared/BackButton';
import { SiteFooter } from '../components/shared/SiteFooter';
import { Modal } from '../components/shared/Modal';
import { AccountIntro } from '../components/account/AccountIntro';
import { AccountHome } from '../components/account/AccountHome';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { initialsOf } from '../lib/format';
import { BottomSheet } from '../components/shared/BottomSheet';
import { useMyStoreWallet } from '../hooks/useMyStoreWallet';
import { WalletOpenNote } from '../components/account/WalletOpenNote';
import { AccountMoreList } from '../components/account/AccountMoreList';
import { formatTaka } from '../lib/format';
import '../styles/batch68.css';

/** Batch 51 Part 4: "Pre-orders — COMING SOON" (no function yet). */
function PreordersSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="Pre-orders"
      headerAction={<span className="acct-soon">COMING SOON</span>}
      panelClassName="acct-sheet acct-sheet--float"
      hideClose
      swipeToClose
    >
      <div className="acct-sheet__body" data-testid="preorders-sheet">
        <p className="acct-sheet__text">Soon you can reserve sold-out favourites, and we'll bring them in just for you.</p>
        <button type="button" className="acct-sheet__ok" onClick={onClose}>
          Got it
        </button>
      </div>
    </BottomSheet>
  );
}

function AccountSkeleton() {
  return (
    <div className="account-skeleton" aria-hidden="true">
      <div className="skeleton account-skeleton__avatar" />
      <div className="skeleton account-skeleton__line account-skeleton__line--name" />
      <div className="skeleton account-skeleton__line account-skeleton__line--email" />
      <div className="skeleton account-skeleton__card" />
      <div className="skeleton account-skeleton__card" />
    </div>
  );
}

/** Batch 60: the My Wallet card, right under the header (signed-in
 *  customers; hidden until migration-060 has been run). Batch 62: a closed
 *  wallet (invite only) shows the story line instead of a balance. */
function WalletCard() {
  const { wallet } = useMyStoreWallet();
  if (!wallet.available) return null;
  const waiting = wallet.waiting[0];
  return (
    <>
      <Link to="/wallet" className="mw-card" data-testid="account-wallet" data-open={wallet.open ? 'true' : 'false'}>
        <span className="mw-card__label">MY WALLET</span>
        {wallet.open ? (
          <>
            <p className="mw-card__balance">{formatTaka(wallet.balance)}</p>
            <span className="mw-card__hint">Your skincare fund</span>
          </>
        ) : (
          <>
            <p className="mw-card__balance mw-card__balance--story">Save for the glow you love</p>
            <span className="mw-card__hint">Invite only · Tap to learn more</span>
          </>
        )}
        {waiting && <span className="mw-card__wait">{formatTaka(waiting.amount)} waiting for confirmation</span>}
        <svg className="mw-card__chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </Link>
      {/* Batch 64: once, when Naeem has opened her wallet (a portal, so the
          page order above stays as it is). */}
      <WalletOpenNote walletOpen={wallet.open} />
    </>
  );
}

function StaffAccountView() {
  const { session, profile, isAdmin, isStaff, staff, signOut } = useAuth();
  const { showToast } = useToast();
  const [isLogoutOpen, setIsLogoutOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  // Batch 24: moderators (staff) open the admin panel too.
  const label = isAdmin ? 'Admin' : isStaff ? `Staff: ${staff?.username ?? ''}` : 'Wholesaler account';
  const panelPath = isStaff ? '/admin' : '/wholesaler-access';
  const panelLabel = isStaff ? 'Open admin panel' : 'Open wholesaler account';

  const handleLogout = async () => {
    setIsSigningOut(true);
    await signOut();
    setIsSigningOut(false);
    setIsLogoutOpen(false);
    showToast('Signed out', 'info');
  };

  return (
    <div className="account-page">
      <div className="account-header">
        <span className="account-header__avatar account-header__avatar--initials" aria-hidden="true">
          {initialsOf(profile?.business_name || session?.user.email || label)}
        </span>
        <div className="account-header__info">
          <p className="account-header__name">{profile?.business_name || label}</p>
          {session?.user.email && <p className="account-header__email">{session.user.email}</p>}
        </div>
      </div>

      <Link to={panelPath} className="account-row">
        <span>{panelLabel}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="account-row__chevron">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </Link>

      <AccountMoreList />

      <button type="button" className="account-logout" onClick={() => setIsLogoutOpen(true)}>
        Log out
      </button>

      <Modal isOpen={isLogoutOpen} onClose={() => setIsLogoutOpen(false)} title="Log out?">
        <p className="confirm-message">You'll need to sign in again to get back to your panel.</p>
        <div className="confirm-actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setIsLogoutOpen(false)}
            disabled={isSigningOut}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={handleLogout}
            disabled={isSigningOut}
          >
            {isSigningOut ? <span className="spinner" aria-hidden="true" /> : 'Log out'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

/** The bottom nav's Account tab. Public browsing never requires this page —
 *  it's the one place a customer opts into an account at all. */
export function AccountPage() {
  useDocumentTitle("Account | NAEEM'S");
  const { session, profile, isLoading } = useAuth();
  const [preordersOpen, setPreordersOpen] = useState(false);
  // Role alone, not approval status — a wholesaler awaiting approval is
  // still a wholesaler, not a customer, and belongs on their own account
  // screen (which shows their pending status), not the customer view.
  const isStaff = profile?.role === 'wholesaler' || profile?.role === 'admin' || profile?.role === 'moderator';

  // Batch 68: not signed in: full-screen Intro -> Sign in (no page header, no footer).
  if (!isLoading && !session) {
    return (
      <div className="viewer-shell detail-shell">
        <AccountIntro />
      </div>
    );
  }

  // Signed-in customer: the new Account layout (its own top row). The
  // footer sits on the same page colour (no white band in dark mode).
  if (!isLoading && session && !isStaff && profile) {
    return (
      <div className="viewer-shell detail-shell">
        <AccountHome
          wallet={<WalletCard />}
          preordersOpen={preordersOpen}
          onOpenPreorders={() => setPreordersOpen(true)}
        />
        <PreordersSheet isOpen={preordersOpen} onClose={() => setPreordersOpen(false)} />
        <div className="b68-acct b68-acct--footer">
          <SiteFooter />
        </div>
      </div>
    );
  }

  // Loading (or a customer's profile still on its way), and staff /
  // wholesaler: as before.
  const showSkeleton = isLoading || (Boolean(session) && !isStaff);
  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">Account</h1>
        <div className="detail-header__actions" />
      </header>

      <main className="detail-main">
        {showSkeleton ? <AccountSkeleton /> : <StaffAccountView />}
        <SiteFooter />
      </main>
    </div>
  );
}
