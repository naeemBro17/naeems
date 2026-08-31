import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ThemeToggle } from '../components/shared/ThemeToggle';

/**
 * Admin sign-in on an unlisted route (/admin-access). Nothing in the public UI
 * links here — the owner reaches it by bookmark. An already-signed-in admin is
 * sent straight through to the panel.
 */
export function AdminAccessPage() {
  const { signIn, isAdmin, isLoading } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && isAdmin) navigate('/admin', { replace: true });
  }, [isLoading, isAdmin, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const { error: signInError, profile } = await signIn(email, password);
    setIsSubmitting(false);
    if (signInError) {
      setError(signInError);
      return;
    }
    if (profile?.role === 'admin' && profile.status === 'approved') {
      navigate('/admin');
    } else {
      setError('This account does not have admin access.');
    }
  };

  return (
    <div className="viewer-shell access-shell">
      <header className="access-header">
        <ThemeToggle />
      </header>

      <main className="access-main">
        <h1 className="access-title">Admin Sign In</h1>
        <form onSubmit={handleSubmit} className="form" noValidate>
          <div className="form-field">
            <label className="form-label" htmlFor="admin-access-email">
              Email
            </label>
            <input
              id="admin-access-email"
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="admin-access-password">
              Password
            </label>
            <input
              id="admin-access-password"
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
            {isSubmitting ? <span className="spinner" aria-hidden="true" /> : 'Sign In'}
          </button>
        </form>
      </main>
    </div>
  );
}
