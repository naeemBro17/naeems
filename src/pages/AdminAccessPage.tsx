import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { safeAdminNext } from '../lib/adminPages';
import { useAuth } from '../contexts/AuthContext';
import { ThemeToggle } from '../components/shared/ThemeToggle';
import { PasswordField } from '../components/admin/PasswordField';

type LoginMode = 'admin' | 'staff';

/** After this many wrong tries in a row, this device waits a minute before
 *  trying again. Supabase also limits sign-in attempts per IP address on
 *  its side; this just stops casual guessing on the page itself. */
const MAX_FAILED_TRIES = 5;
const COOLDOWN_MS = 60_000;
const COOLDOWN_KEY = 'naeems-staff-login-cooldown';

function readCooldown(): { failures: number; until: number } {
  try {
    const raw = window.localStorage.getItem(COOLDOWN_KEY);
    if (!raw) return { failures: 0, until: 0 };
    const parsed = JSON.parse(raw) as { failures?: number; until?: number };
    return { failures: parsed.failures ?? 0, until: parsed.until ?? 0 };
  } catch {
    return { failures: 0, until: 0 };
  }
}

function writeCooldown(value: { failures: number; until: number }): void {
  try {
    window.localStorage.setItem(COOLDOWN_KEY, JSON.stringify(value));
  } catch {
    // Private mode / blocked storage: the server-side limit still applies.
  }
}

/**
 * Admin sign-in on an unlisted route (/admin-access). Nothing in the public UI
 * links here — the owner reaches it by bookmark. An already-signed-in admin
 * (or moderator) is sent straight through to the panel.
 *
 * Batch 24: two tabs. "Admin" is Naeem's own email login, unchanged. "Staff
 * login" is username + password for moderators.
 */
export function AdminAccessPage() {
  const { signIn, signInStaff, isStaff, isLoading, mfaPending } = useAuth();
  const navigate = useNavigate();
  // Batch 32: back to the admin page whose link was opened (only ever a
  // page inside the admin).
  const [searchParams] = useSearchParams();
  const next = safeAdminNext(searchParams.get('next'));

  const [mode, setMode] = useState<LoginMode>('admin');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    // Batch 34: a session still waiting for its 6-digit code goes on too —
    // the admin shows the code screen first.
    if (!isLoading && (isStaff || mfaPending)) navigate(next, { replace: true });
  }, [isLoading, isStaff, mfaPending, navigate, next]);

  const switchMode = (next: LoginMode) => {
    setMode(next);
    setError(null);
    setPassword('');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const cooldown = readCooldown();
    if (cooldown.until > Date.now()) {
      const seconds = Math.ceil((cooldown.until - Date.now()) / 1000);
      setError(`Too many wrong tries. Please wait ${seconds} seconds and try again.`);
      return;
    }

    setIsSubmitting(true);
    if (mode === 'staff') {
      const { error: signInError } = await signInStaff(username, password);
      setIsSubmitting(false);
      if (signInError) {
        const failures = cooldown.failures + 1;
        writeCooldown({
          failures: failures >= MAX_FAILED_TRIES ? 0 : failures,
          until: failures >= MAX_FAILED_TRIES ? Date.now() + COOLDOWN_MS : 0,
        });
        setError(signInError);
        return;
      }
      writeCooldown({ failures: 0, until: 0 });
      navigate(next);
      return;
    }

    const { error: signInError, profile } = await signIn(email, password);
    setIsSubmitting(false);
    if (signInError) {
      setError(signInError);
      return;
    }
    if (profile?.role === 'admin' && profile.status === 'approved') {
      navigate(next);
    } else {
      setError('This account does not have admin access.');
    }
  };

  const canSubmit = password !== '' && (mode === 'admin' ? email !== '' : username !== '');

  return (
    <div className="viewer-shell access-shell">
      <header className="access-header">
        <ThemeToggle />
      </header>

      <main className="access-main">
        <h1 className="access-title">Admin Sign In</h1>
        <div className="auth-toggle" role="tablist" aria-label="Admin or staff login">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'admin'}
            className={`auth-toggle__tab${mode === 'admin' ? ' auth-toggle__tab--active' : ''}`}
            onClick={() => switchMode('admin')}
          >
            Admin
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'staff'}
            className={`auth-toggle__tab${mode === 'staff' ? ' auth-toggle__tab--active' : ''}`}
            onClick={() => switchMode('staff')}
          >
            Staff login
          </button>
        </div>
        <form onSubmit={handleSubmit} className="form" noValidate>
          {mode === 'admin' ? (
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
          ) : (
            <div className="form-field">
              <label className="form-label" htmlFor="admin-access-username">
                Username
              </label>
              <input
                id="admin-access-username"
                type="text"
                className="form-input"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </div>
          )}
          {mode === 'admin' ? (
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
          ) : (
            <PasswordField
              id="admin-access-staff-password"
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
            />
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="button button--primary button--full"
            disabled={isSubmitting || !canSubmit}
          >
            {isSubmitting ? <span className="spinner" aria-hidden="true" /> : 'Sign In'}
          </button>
        </form>
      </main>
    </div>
  );
}
