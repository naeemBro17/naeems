import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { logStaffEvent } from '../../lib/staff';
import {
  afterWrongCode,
  cleanCode,
  listDevices,
  readCodeCooldown,
  verifyAnyDevice,
  writeCodeCooldown,
} from '../../lib/mfa';
import { ThemeToggle } from './ThemeToggle';

/**
 * Batch 34 Part 1: the second step of signing in. Shown instead of the
 * admin whenever the account has an Authenticator app and this session has
 * only given the password. One field, number keyboard on the phone, fills
 * from a paste, sends itself at 6 digits. Five wrong codes → wait 60 s.
 */
export default function TwoStepCodeScreen() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);

  // Counts down the cool-down, if one is running on this device.
  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, Math.ceil((readCodeCooldown().until - Date.now()) / 1000));
      setWaitSeconds(left);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const submit = async (value: string) => {
    if (busy || value.length !== 6) return;
    const cooldown = readCodeCooldown();
    if (cooldown.until > Date.now()) return;
    setBusy(true);
    setError(null);
    const { devices } = await listDevices();
    const ok = devices.length > 0 && (await verifyAnyDevice(devices, value));
    if (ok) {
      writeCodeCooldown({ failures: 0, until: 0 });
      void logStaffEvent('staff.login');
      // The session is now at the 2-step level; AuthContext re-renders and
      // the admin opens in place of this screen.
      return;
    }
    const next = afterWrongCode(cooldown, Date.now());
    writeCodeCooldown(next);
    setBusy(false);
    setCode('');
    if (next.until > 0) {
      setWaitSeconds(Math.ceil((next.until - Date.now()) / 1000));
      setError('Too many wrong codes. Please wait a minute, then try again.');
    } else {
      setError('That code is not right. Check the app and try again.');
      inputRef.current?.focus();
    }
  };

  const onChange = (raw: string) => {
    const value = cleanCode(raw);
    setCode(value);
    if (value.length === 6) void submit(value);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(code);
  };

  const switchAccount = async () => {
    navigate('/admin-access', { replace: true });
    await signOut();
  };

  const waiting = waitSeconds > 0;

  return (
    <div className="viewer-shell access-shell two-step" data-testid="two-step-screen">
      <header className="access-header">
        <ThemeToggle />
      </header>
      <main className="access-main">
        <svg className="two-step__icon" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
          <path d="M10.5 18.5h3" />
          <path d="M9.5 10.5l2 2 3.5-3.5" />
        </svg>
        <h1 className="access-title">Enter your code</h1>
        <p className="two-step__hint">Open your Authenticator app and type the 6-digit code you see there.</p>
        <form onSubmit={onSubmit} className="form" noValidate>
          <div className="form-field">
            <label className="visually-hidden" htmlFor="two-step-code">
              6-digit code
            </label>
            <input
              ref={inputRef}
              id="two-step-code"
              className="form-input two-step__input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              autoFocus
              placeholder="000000"
              value={code}
              disabled={busy || waiting}
              onChange={(e) => onChange(e.target.value)}
              aria-invalid={error !== null}
              aria-describedby={error ? 'two-step-error' : undefined}
            />
          </div>
          {error && (
            <p id="two-step-error" className="form-error" role="alert">
              {error}
            </p>
          )}
          {waiting && (
            <p className="two-step__wait" aria-live="polite">
              You can try again in {waitSeconds} s.
            </p>
          )}
          <button
            type="submit"
            className="button button--primary button--full"
            disabled={busy || waiting || code.length !== 6}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : 'Continue'}
          </button>
        </form>
        <button type="button" className="two-step__other" onClick={() => void switchAccount()}>
          Use a different account
        </button>
      </main>
    </div>
  );
}
