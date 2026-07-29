import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { Modal } from './Modal';

/** Which screen the auth modal is showing. */
export type AuthModalView = 'choice' | 'admin' | 'wholesaler' | 'status';

interface AuthModalProps {
  view: AuthModalView;
  onSetView: (view: AuthModalView) => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Not approved',
  revoked: 'Access revoked',
};

const TITLES: Record<AuthModalView, string> = {
  choice: 'Sign In',
  admin: 'Admin Sign In',
  wholesaler: 'Wholesaler Access',
  status: 'Your Account',
};

export function AuthModal({ view, onSetView, onClose }: AuthModalProps) {
  const { signIn, signUpWholesaler, signOut, profile } = useAuth();
  const { refetch } = useProducts();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [wholesalerMode, setWholesalerMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signupSuccessName, setSignupSuccessName] = useState<string | null>(null);

  // Clear transient form state whenever the screen changes.
  useEffect(() => {
    setError(null);
    setIsSubmitting(false);
    setSignupSuccessName(null);
  }, [view, wholesalerMode]);

  const handleAdminSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const { error: signInError, profile: p } = await signIn(email, password);
    setIsSubmitting(false);
    if (signInError) {
      setError(signInError);
      return;
    }
    if (p?.role === 'admin' && p.status === 'approved') {
      onClose();
      navigate('/admin');
    } else {
      setError('This account does not have admin access.');
    }
  };

  const finishWholesalerLogin = (status: string | undefined) => {
    onClose();
    if (status === 'approved') {
      void refetch();
      showToast('Signed in');
    } else {
      showToast('Your account is awaiting approval');
    }
  };

  const handleWholesalerSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const { error: signInError, profile: p } = await signIn(email, password);
    setIsSubmitting(false);
    if (signInError) {
      setError(signInError);
      return;
    }
    finishWholesalerLogin(p?.status);
  };

  const handleWholesalerSignUp = async (e: FormEvent) => {
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
    // Keep the modal open on a confirmation screen rather than redirecting.
    setSignupSuccessName(trimmedName);
  };

  const handleSignOut = async () => {
    setIsSubmitting(true);
    await signOut();
    setIsSubmitting(false);
    onClose();
    showToast('Signed out');
  };

  const backToChoice = (
    <button
      type="button"
      className="auth-back"
      onClick={() => onSetView('choice')}
    >
      ← Back
    </button>
  );

  return (
    <Modal isOpen onClose={onClose} title={TITLES[view]}>
      {view === 'choice' && (
        <div className="auth-choice">
          <p className="auth-choice__intro">How would you like to sign in?</p>
          <button
            type="button"
            className="button button--primary button--full auth-choice__button"
            onClick={() => onSetView('admin')}
          >
            Login as Admin
          </button>
          <button
            type="button"
            className="button button--secondary button--full auth-choice__button"
            onClick={() => onSetView('wholesaler')}
          >
            Login as Wholesaler
          </button>
        </div>
      )}

      {view === 'admin' && (
        <form onSubmit={handleAdminSignIn} className="form" noValidate>
          {backToChoice}
          <div className="form-field">
            <label className="form-label" htmlFor="auth-admin-email">Email</label>
            <input
              id="auth-admin-email"
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="auth-admin-password">Password</label>
            <input
              id="auth-admin-password"
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button
            type="submit"
            className="button button--primary button--full"
            disabled={isSubmitting || email === '' || password === ''}
          >
            {isSubmitting ? <span className="spinner" aria-hidden="true" /> : 'Sign In'}
          </button>
        </form>
      )}

      {view === 'wholesaler' && signupSuccessName !== null && (
        <div className="auth-success">
          <div className="auth-success__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
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
            onClick={onClose}
          >
            Done
          </button>
        </div>
      )}

      {view === 'wholesaler' && signupSuccessName === null && (
        <div className="auth-wholesaler">
          {backToChoice}
          <div className="auth-toggle" role="tablist" aria-label="Wholesaler sign in or new account">
            <button
              type="button"
              role="tab"
              aria-selected={wholesalerMode === 'signin'}
              className={`auth-toggle__tab${wholesalerMode === 'signin' ? ' auth-toggle__tab--active' : ''}`}
              onClick={() => setWholesalerMode('signin')}
            >
              Sign In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={wholesalerMode === 'signup'}
              className={`auth-toggle__tab${wholesalerMode === 'signup' ? ' auth-toggle__tab--active' : ''}`}
              onClick={() => setWholesalerMode('signup')}
            >
              New Account
            </button>
          </div>

          {wholesalerMode === 'signin' ? (
            <form onSubmit={handleWholesalerSignIn} className="form" noValidate>
              <div className="form-field">
                <label className="form-label" htmlFor="auth-ws-email">Email</label>
                <input
                  id="auth-ws-email"
                  type="email"
                  className="form-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="auth-ws-password">Password</label>
                <input
                  id="auth-ws-password"
                  type="password"
                  className="form-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button
                type="submit"
                className="button button--primary button--full"
                disabled={isSubmitting || email === '' || password === ''}
              >
                {isSubmitting ? <span className="spinner" aria-hidden="true" /> : 'Sign In'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleWholesalerSignUp} className="form" noValidate>
              <div className="form-field">
                <label className="form-label" htmlFor="auth-signup-email">Email</label>
                <input
                  id="auth-signup-email"
                  type="email"
                  className="form-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="auth-signup-password">Password</label>
                <input
                  id="auth-signup-password"
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
                <label className="form-label" htmlFor="auth-signup-confirm">Confirm password</label>
                <input
                  id="auth-signup-confirm"
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
                <label className="form-label" htmlFor="auth-signup-business">
                  Business / Shop Name <span className="form-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="auth-signup-business"
                  type="text"
                  className="form-input"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  required
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="auth-signup-phone">
                  Phone Number <span className="form-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="auth-signup-phone"
                  type="tel"
                  className="form-input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoComplete="tel"
                  required
                />
              </div>
              {error && <p className="form-error" role="alert">{error}</p>}
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
                {isSubmitting ? <span className="spinner" aria-hidden="true" /> : 'Create Account'}
              </button>
            </form>
          )}
        </div>
      )}

      {view === 'status' && (
        <div className="auth-status">
          <p className="auth-status__line">
            <span className="auth-status__label">Business</span>
            <span className="auth-status__value">
              {profile?.business_name || '—'}
            </span>
          </p>
          <p className="auth-status__line">
            <span className="auth-status__label">Status</span>
            <span className={`status-badge status-badge--${profile?.status ?? 'pending'}`}>
              {STATUS_LABEL[profile?.status ?? 'pending'] ?? 'Awaiting approval'}
            </span>
          </p>
          <button
            type="button"
            className="button button--danger-outline button--full"
            onClick={handleSignOut}
            disabled={isSubmitting}
          >
            {isSubmitting ? <span className="spinner" aria-hidden="true" /> : 'Sign Out'}
          </button>
        </div>
      )}
    </Modal>
  );
}
