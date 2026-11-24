import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BackButton } from '../components/shared/BackButton';
import { SiteFooter } from '../components/shared/SiteFooter';
import { Modal } from '../components/shared/Modal';
import { GoogleSignInButton } from '../components/shared/GoogleSignInButton';
import { EditDeliveryDetailsSheet } from '../components/account/EditDeliveryDetailsSheet';
import { useAuth } from '../contexts/AuthContext';
import { useProducts } from '../contexts/ProductContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { initialsOf } from '../lib/format';
import { openExternal, whatsAppUrl } from '../lib/expertLinks';
import { loginReturnPath } from '../lib/loginReturn';
import { BottomSheet } from '../components/shared/BottomSheet';
import { HeartIcon } from '../components/viewer/Wishlist';
import { useWishlist } from '../contexts/WishlistContext';
import { useMyStoreWallet } from '../hooks/useMyStoreWallet';
import { formatTaka } from '../lib/format';

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="acct-row__chevron">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function RowIcon({ name }: { name: 'orders' | 'clock' | 'help' }) {
  return (
    <span className="acct-row__icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {name === 'orders' && (
          <>
            <rect x="5" y="3.5" width="14" height="17" rx="2" />
            <path d="M9 8h6M9 12h6M9 16h3" />
          </>
        )}
        {name === 'clock' && (
          <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V12l3 2" />
          </>
        )}
        {name === 'help' && <path d="M20 11.5a8 8 0 01-11.7 7.1L4 20l1.4-4.1A8 8 0 1120 11.5z" />}
      </svg>
    </span>
  );
}

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

/** A soft skincare-adjacent brand mark — a droplet — built entirely from
 *  shapes, no external image or copyrighted artwork. */
function BrandMark() {
  return (
    <div className="account-welcome__mark" aria-hidden="true">
      <svg viewBox="0 0 64 64" fill="none">
        <circle cx="32" cy="32" r="32" fill="var(--color-accent-soft)" />
        <path
          d="M32 14c8 10 13 17.2 13 23.5C45 45.4 39.2 51 32 51s-13-5.6-13-13.5C19 31.2 24 24 32 14z"
          fill="var(--color-primary)"
        />
        <path
          d="M26.5 36c0 4 2.7 7 6 7.7"
          stroke="var(--color-primary-bg)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
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

function LoggedOutWelcome() {
  const { signInWithGoogle } = useAuth();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const handleSignIn = async () => {
    setIsStarting(true);
    setError(null);
    // Batch 47: back to the page they were on (the shop home if none), and
    // this login page leaves the history so Back never returns to it.
    const back = `${window.location.origin}${loginReturnPath(location.state)}`;
    const { error: signInError } = await signInWithGoogle(back, { replace: true });
    if (signInError) {
      setError(signInError);
      setIsStarting(false);
    }
  };

  return (
    <div className="account-welcome">
      <BrandMark />
      <h1 className="account-welcome__title">Your account</h1>
      <p className="account-welcome__message">
        Save your address, check out faster, and track your orders.
      </p>
      {error && (
        <p className="login-sheet__error" role="alert">
          {error}
        </p>
      )}
      <GoogleSignInButton
        label="Continue with Google"
        onClick={handleSignIn}
        disabled={isStarting}
      />
    </div>
  );
}

function areaSummary(division: string | null, district: string | null, thana: string | null): string {
  return [thana, district, division].filter((v): v is string => Boolean(v)).join(', ');
}

/** Batch 60: the My Wallet card, right under the header (signed-in
 *  customers; hidden until migration-060 has been run). Batch 62: a closed
 *  wallet (invite only) shows the story line instead of a balance. */
function WalletCard() {
  const { wallet } = useMyStoreWallet();
  if (!wallet.available) return null;
  const waiting = wallet.waiting[0];
  return (
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
  );
}

function CustomerAccountView() {
  const { session, profile, signOut } = useAuth();
  const { settings } = useProducts();
  const { showToast } = useToast();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isLogoutOpen, setIsLogoutOpen] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [preordersOpen, setPreordersOpen] = useState(false);
  const { ids: wishIds, ready: wishReady } = useWishlist();
  const { products } = useProducts();
  // Hidden or deleted products are not counted (the Wishlist page drops them).
  const wishCount = wishReady ? wishIds.filter((id) => products.some((p) => p.id === id && p.is_active)).length : 0;

  if (!profile) return null;

  const name = profile.full_name || 'Skincare fan';
  const email = session?.user.email ?? '';
  const area = areaSummary(profile.division, profile.district, profile.thana);
  const hasAddress = area !== '' || Boolean(profile.address_line);
  const waLink = whatsAppUrl(settings.expert_whatsapp_url);

  const handleLogout = async () => {
    setIsSigningOut(true);
    await signOut();
    setIsSigningOut(false);
    setIsLogoutOpen(false);
    showToast('Signed out', 'info');
  };

  return (
    <div className="account-page account-page--glass">
      {/* Batch 53 Part 3: the soft peach / sage / lilac glow behind the page (decoration only). */}
      <div className="account-glow" aria-hidden="true">
        <span className="account-glow__blob account-glow__blob--peach" />
        <span className="account-glow__blob account-glow__blob--sage" />
        <span className="account-glow__blob account-glow__blob--lilac" />
      </div>
      <div className="account-header">
        {profile.photo_url && !photoFailed ? (
          <img
            src={profile.photo_url}
            alt=""
            className="account-header__avatar"
            onError={() => setPhotoFailed(true)}
          />
        ) : (
          <span className="account-header__avatar account-header__avatar--initials" aria-hidden="true">
            {initialsOf(name)}
          </span>
        )}
        <div className="account-header__info">
          <p className="account-header__name">{name}</p>
          {email !== '' && <p className="account-header__email">{email}</p>}
        </div>
      </div>

      <WalletCard />

      <section className="account-card">
        <div className="account-card__head">
          <h2 className="account-card__title">Delivery details</h2>
          <button type="button" className="account-card__edit" onClick={() => setIsEditOpen(true)}>
            Edit
          </button>
        </div>
        {hasAddress || profile.phone ? (
          <div className="account-card__body">
            {profile.phone && <p className="account-card__line">{profile.phone}</p>}
            {area !== '' && <p className="account-card__line">{area}</p>}
            {profile.address_line && (
              <p className="account-card__line account-card__line--muted">{profile.address_line}</p>
            )}
          </div>
        ) : (
          <p className="account-card__empty">
            No delivery details saved yet — add them for a faster checkout.
          </p>
        )}
      </section>

      {/* Batch 51: one glass list — My orders, Wishlist, Pre-orders and
          Need help? (every earlier row kept). */}
      <nav className="acct-glass" aria-label="Your account" data-testid="account-list">
        <Link to="/orders" className="acct-row">
          <RowIcon name="orders" />
          <span className="acct-row__text">
            <span className="acct-row__label">My Orders</span>
            <span className="acct-row__hint">Track and manage your orders</span>
          </span>
          <Chevron />
        </Link>
        <Link to="/wishlist" className="acct-row" data-testid="account-wishlist">
          <span className="acct-row__icon" aria-hidden="true">
            <HeartIcon filled={false} />
          </span>
          <span className="acct-row__text">
            <span className="acct-row__label">Wishlist</span>
          </span>
          {wishCount > 0 && <span className="acct-row__count" data-testid="account-wishlist-count">{wishCount}</span>}
          <Chevron />
        </Link>
        <button type="button" className="acct-row" onClick={() => setPreordersOpen(true)} data-testid="account-preorders">
          <RowIcon name="clock" />
          <span className="acct-row__text">
            <span className="acct-row__label">Pre-orders</span>
          </span>
          <span className="acct-soon">COMING SOON</span>
        </button>
        {waLink && (
          <button type="button" className="acct-row" onClick={() => openExternal(waLink)}>
            <RowIcon name="help" />
            <span className="acct-row__text">
              <span className="acct-row__label">Need help?</span>
            </span>
            <Chevron />
          </button>
        )}
      </nav>

      <PreordersSheet isOpen={preordersOpen} onClose={() => setPreordersOpen(false)} />

      <button
        type="button"
        className="account-logout"
        onClick={() => setIsLogoutOpen(true)}
      >
        Log out
      </button>

      <EditDeliveryDetailsSheet isOpen={isEditOpen} onClose={() => setIsEditOpen(false)} />

      <Modal isOpen={isLogoutOpen} onClose={() => setIsLogoutOpen(false)} title="Log out?">
        <p className="confirm-message">You can sign back in with Google any time.</p>
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
  useDocumentTitle("Account — NAEEM'S");
  const { session, profile, isLoading } = useAuth();
  // Role alone, not approval status — a wholesaler awaiting approval is
  // still a wholesaler, not a customer, and belongs on their own account
  // screen (which shows their pending status), not the customer view.
  const isStaff = profile?.role === 'wholesaler' || profile?.role === 'admin' || profile?.role === 'moderator';

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">Account</h1>
        <div className="detail-header__actions" />
      </header>

      <main className="detail-main">
        {isLoading ? (
          <AccountSkeleton />
        ) : !session ? (
          <LoggedOutWelcome />
        ) : isStaff ? (
          <StaffAccountView />
        ) : (
          <CustomerAccountView />
        )}
        <SiteFooter />
      </main>
    </div>
  );
}
