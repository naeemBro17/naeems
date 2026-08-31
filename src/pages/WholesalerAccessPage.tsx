import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useProducts } from '../contexts/ProductContext';
import { useToast } from '../hooks/useToast';
import { ThemeToggle } from '../components/shared/ThemeToggle';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Not approved',
  revoked: 'Access revoked',
};

/**
 * Wholesaler sign-in / sign-up on an unlisted route (/wholesaler-access). The
 * owner shares this URL directly; nothing in the public UI links to it. When a
 * wholesaler is already signed in it becomes their account screen, which is
 * also the only place they can sign out from.
 */
export function WholesalerAccessPage() {
  const { signIn, signUpWholesaler, signOut, session, profile } = useAuth();
  const { refetch } = useProducts();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signupSuccessName, setSignupSuccessName] = useState<string | null>(null);

  // Clear transient form state whenever the reader switches tabs.
  useEffect(() => {
    setError(null);
    setIsSubmitting(false);
    setSignupSuccessName(null);
  }, [mode]);

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const { error: signInError, profile: p } = await signIn(email, password);
    setIsSubmitting(false);
    if (signInError) {
      setError(signInError);
      return;
    }
    if (p?.status === 'approved') {
      void refetch();
      showToast('Signed in');
    } else {
      showToast('Your account is awaiting approval');
    }
  };

  const handleSignUp = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setIsSubmitting(true);
    const trimmedName = businessName.trim();
    const { error: signUpError } = await signUpWholesaler(
      email,
      password,
      trimmedName,
      phone.trim()
    );
    setIsSubmitting(false);
    if (signUpError) {
      setError(signUpError);
      return;
    }
    setSignupSuccessName(trimmedName);
  };

  const handleSignOut = async () => {
    setIsSubmitting(true);
    await signOut();
    setIsSubmitting(false);
    showToast('Signed out');
  };

  const signedIn = session !== null;

  return (
    <div className="viewer-shell access-shell">
      <header className="access-header">
        <ThemeToggle />
      </header>

      <main className="access-main">
        {signedIn ? (
          <>
            <h1 className="access-title">Your Account</h1>
            <div className="auth-status">
              <p className="auth-status__line">
                <span className="auth-status__label">Business</span>
                <span className="auth-status__value">
                  {profile?.business_name || '—'}
                </span>
              </p>
              <p className="auth-status__line">
                <span className="auth-status__label">Status</span>
                <span
                  className={`status-badge status-badge--${profile?.status ?? 'pending'}`}
                >
                  {STATUS_LABEL[profile?.status ?? 'pending'] ?? 'Awaiting approval'}
                </span>
              </p>
              <button
                type="button"
                className="button button--secondary button--full"
                onClick={() => navigate('/')}
              >
                Browse Products
              </button>
              <button
                type="button"
                className="button button--danger-outline button--full"
                onClick={handleSignOut}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  'Sign Out'
                )}
              </button>
            </div>
          </>
        ) : signupSuccessName !== null ? (
          <div className="auth-success">
            <div className="auth-success__icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <p className="auth-success__message">
              Account created — pending approval.
              {signupSuccessName !== ''
                ? ` ${signupSuccessName} will be notified once approved.`
                : ' You will be notified once approved.'}
            </p>
            <button
              type="button"
              className="button button--primary button--full"
              onClick={() => navigate('/')}
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <h1 className="access-title">Wholesaler Access</h1>
            <div
              className="auth-toggle"
              role="tablist"
              aria-label="Wholesaler sign in or new account"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signin'}
                className={`auth-toggle__tab${
                  mode === 'signin' ? ' auth-toggle__tab--active' : ''
                }`}
                onClick={() => setMode('signin')}
              >
                Sign In
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signup'}
                className={`auth-toggle__tab${
                  mode === 'signup' ? ' auth-toggle__tab--active' : ''
                }`}
                onClick={() => setMode('signup')}
              >
                New Account
              </button>
            </div>

            {mode === 'signin' ? (
              <form onSubmit={handleSignIn} className="form" noValidate>
                <div className="form-field">
                  <label className="form-label" htmlFor="ws-access-email">
                    Email
                  </label>
                  <input
                    id="ws-access-email"
                    type="email"
                    className="form-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="ws-access-password">
                    Password
                  </label>
                  <input
                    id="ws-access-password"
                    type="password"
                    className="form-input"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </div>
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  className="button button--primary button--full"
                  disabled={isSubmitting || email === '' || password === ''}
                >
                  {isSubmitting ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : (
                    'Sign In'
                  )}
                </button>
              </form>
            ) : (
              <form onSubmit={handleSignUp} className="form" noValidate>
                <div className="form-field">
                  <label className="form-label" htmlFor="ws-signup-email">
                    Email
                  </label>
                  <input
                    id="ws-signup-email"
                    type="email"
                    className="form-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="ws-signup-password">
                    Password
                  </label>
                  <input
                    id="ws-signup-password"
                    type="password"
                    className="form-input"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="ws-signup-confirm">
                    Confirm password
                  </label>
                  <input
                    id="ws-signup-confirm"
                    type="password"
                    className="form-input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="ws-signup-business">
                    Business / Shop Name{' '}
                    <span className="form-required" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <input
                    id="ws-signup-business"
                    type="text"
                    className="form-input"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    required
                  />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="ws-signup-phone">
                    Phone Number{' '}
                    <span className="form-required" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <input
                    id="ws-signup-phone"
                    type="tel"
                    className="form-input"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                    required
                  />
                </div>
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  className="button button--primary button--full"
                  disabled={
                    isSubmitting ||
                    email === '' ||
                    password === '' ||
                    confirmPassword === '' ||
                    businessName.trim() === '' ||
                    phone.trim() === ''
                  }
                >
                  {isSubmitting ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : (
                    'Create Account'
                  )}
                </button>
              </form>
            )}
          </>
        )}
      </main>
    </div>
  );
}
