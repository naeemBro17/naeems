import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BackButton } from '../components/shared/BackButton';
import { Modal } from '../components/shared/Modal';
import { GoogleSignInButton } from '../components/shared/GoogleSignInButton';
import { EditDeliveryDetailsSheet } from '../components/account/EditDeliveryDetailsSheet';
import { useAuth } from '../contexts/AuthContext';
import { useProducts } from '../contexts/ProductContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { initialsOf } from '../lib/format';
import { openExternal, whatsAppUrl } from '../lib/expertLinks';

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
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const handleSignIn = async () => {
    setIsStarting(true);
    setError(null);
    const { error: signInError } = await signInWithGoogle();
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

function CustomerAccountView() {
  const { session, profile, signOut } = useAuth();
  const { settings } = useProducts();
  const { showToast } = useToast();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isLogoutOpen, setIsLogoutOpen] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

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
    <div className="account-page">
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

      <section className="account-card">
        <div className="account-card__head">
          <h2 className="account-card__title">My Orders</h2>
        </div>
        <p className="account-card__empty">আপনার অর্ডারগুলো এখানে দেখাবে — coming very soon.</p>
      </section>

      {waLink && (
        <button
          type="button"
          className="account-row"
          onClick={() => openExternal(waLink)}
        >
          <span>সাহায্য দরকার?</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="account-row__chevron">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      )}

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
  const { session, profile, isAdmin, signOut } = useAuth();
  const { showToast } = useToast();
  const [isLogoutOpen, setIsLogoutOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const label = isAdmin ? 'Admin' : 'Wholesaler account';
  const panelPath = isAdmin ? '/admin' : '/wholesaler-access';
  const panelLabel = isAdmin ? 'Open admin panel' : 'Open wholesaler account';

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
  useDocumentTitle("Account — Naeem's");
  const { session, profile, isLoading } = useAuth();
  // Role alone, not approval status — a wholesaler awaiting approval is
  // still a wholesaler, not a customer, and belongs on their own account
  // screen (which shows their pending status), not the customer view.
  const isStaff = profile?.role === 'wholesaler' || profile?.role === 'admin';

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
      </main>
    </div>
  );
}
