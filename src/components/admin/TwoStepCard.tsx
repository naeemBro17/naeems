import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useToast } from '../../hooks/useToast';
import { copyToClipboard } from '../../lib/clipboard';
import {
  cancelEnrollment,
  cleanCode,
  listDevices,
  logTwoStepEvent,
  nextDeviceName,
  qrImageSrc,
  removeDevice,
  startEnrollment,
  verifyCode,
  type TwoStepDevice,
  type TwoStepEnrollment,
} from '../../lib/mfa';

type Mode =
  | { kind: 'idle' }
  | { kind: 'enroll'; name: string; enrollment: TwoStepEnrollment }
  | { kind: 'remove'; device: TwoStepDevice };

function formatAdded(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
}

/** One 6-digit field: numbers only, paste works, Enter or 6 digits sends. */
function CodeField({ id, value, onChange, disabled }: { id: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <div className="form-field">
      <label className="form-label" htmlFor={id}>
        6-digit code from the app
      </label>
      <input
        id={id}
        className="form-input two-step-card__code"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        placeholder="000000"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(cleanCode(e.target.value))}
      />
    </div>
  );
}

/**
 * Batch 34 Part 1: Admin → Settings → Security (and My Profile for staff).
 * Turns on two-step login with an Authenticator app, adds a backup phone,
 * removes a phone (only with a current code). Supabase keeps the keys; this
 * page never stores or logs them.
 */
export function TwoStepCard() {
  const { showToast } = useToast();
  const [devices, setDevices] = useState<TwoStepDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const res = await listDevices();
    setDevices(res.devices);
    setLoadError(res.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isOn = devices.length > 0;

  const resetForm = () => {
    setMode({ kind: 'idle' });
    setCode('');
    setError(null);
    setBusy(false);
  };

  const beginSetup = async () => {
    setBusy(true);
    setError(null);
    const name = nextDeviceName(devices.map((d) => d.name));
    const res = await startEnrollment(name);
    setBusy(false);
    if (!res.enrollment) {
      setError(res.error);
      return;
    }
    setCode('');
    setMode({ kind: 'enroll', name, enrollment: res.enrollment });
  };

  const cancelSetup = async () => {
    if (mode.kind === 'enroll') await cancelEnrollment(mode.enrollment.factorId);
    resetForm();
  };

  const confirmSetup = async (e?: FormEvent) => {
    e?.preventDefault();
    if (mode.kind !== 'enroll' || code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    const ok = await verifyCode(mode.enrollment.factorId, code);
    if (!ok) {
      setBusy(false);
      setCode('');
      setError('That code is not right. Check the time on the phone, then type the newest code.');
      return;
    }
    void logTwoStepEvent(isOn ? 'staff.mfa_device_added' : 'staff.mfa_on', mode.name);
    showToast(isOn ? `${mode.name} added` : 'Two-step login is on');
    resetForm();
    await reload();
  };

  const confirmRemove = async (e?: FormEvent) => {
    e?.preventDefault();
    if (mode.kind !== 'remove' || code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    // A current code proves it is really you: from a phone you keep, or
    // from this phone when it is the only one.
    const target = mode.device;
    const last = devices.length === 1;
    const keeping = last ? devices : devices.filter((d) => d.id !== target.id);
    let matched: TwoStepDevice | null = null;
    for (const d of keeping) {
      if (await verifyCode(d.id, code)) {
        matched = d;
        break;
      }
    }
    if (!matched) {
      setBusy(false);
      setCode('');
      setError(last ? 'That code is not right. Type the newest code from the app.' : 'That code is not right. Type the newest code from a phone you are keeping.');
      return;
    }
    const removed = await removeDevice(target.id);
    if (!removed) {
      setBusy(false);
      setError('Could not remove this phone. Please try again.');
      return;
    }
    // Supabase lowers the session to "password only" when a phone is
    // removed; the same code from the phone you keep restores it, so the
    // admin stays open.
    if (!last) await verifyCode(matched.id, code);
    void logTwoStepEvent(last ? 'staff.mfa_off' : 'staff.mfa_device_removed', target.name);
    showToast(last ? 'Two-step login is off' : `${target.name} removed`);
    resetForm();
    await reload();
  };

  const copyKey = async (secret: string) => {
    const ok = await copyToClipboard(secret);
    showToast(ok ? 'Key copied' : 'Could not copy. Please type it in.');
  };

  return (
    <div className="admin-panel two-step-card" data-testid="two-step-card">
      <div className="two-step-card__head">
        <h3 className="admin-panel__title">Two-step login</h3>
        {!loading && (
          <span className={`two-step-card__status${isOn ? ' two-step-card__status--on' : ''}`} data-testid="two-step-status">
            {isOn ? 'On' : 'Off'}
          </span>
        )}
      </div>
      <p className="admin-panel__description">
        After your password, you also type a 6-digit code from an Authenticator app on your phone (Google
        Authenticator or Microsoft Authenticator). Someone who learns your password still cannot get in.
      </p>

      {loading && <span className="spinner" aria-hidden="true" />}
      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}

      {!loading && devices.length > 0 && (
        <ul className="two-step-card__devices">
          {devices.map((d) => (
            <li key={d.id} className="two-step-card__device">
              <span>
                <strong>{d.name}</strong>
                <span className="two-step-card__added">Added {formatAdded(d.createdAt)}</span>
              </span>
              {mode.kind === 'idle' && (
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => {
                    setCode('');
                    setError(null);
                    setMode({ kind: 'remove', device: d });
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!loading && mode.kind === 'idle' && (
        <>
          {isOn && devices.length === 1 && (
            <p className="two-step-card__backup">
              Add a second phone as a backup, so you can still log in if you lose this one.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className={`button ${isOn ? 'button--secondary' : 'button--primary'}`}
            onClick={() => void beginSetup()}
            disabled={busy}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : isOn ? 'Add a backup phone' : 'Set up'}
          </button>
        </>
      )}

      {mode.kind === 'enroll' && (
        <form className="two-step-card__setup form" onSubmit={(e) => void confirmSetup(e)} noValidate>
          <ol className="two-step-card__steps">
            <li>Open the Authenticator app on the phone and tap the + button.</li>
            <li>Scan this QR code. Or choose “Enter a setup key” and type the key below.</li>
            <li>Type the 6-digit code the app shows.</li>
          </ol>
          <div className="two-step-card__qr" data-testid="two-step-qr">
            <img src={qrImageSrc(mode.enrollment.qrCode)} alt="QR code for the Authenticator app" width={176} height={176} />
          </div>
          <div className="two-step-card__key">
            <code data-testid="two-step-key">{mode.enrollment.secret}</code>
            <button type="button" className="button button--secondary button--small" onClick={() => void copyKey(mode.enrollment.secret)}>
              Copy
            </button>
          </div>
          <CodeField id="two-step-setup-code" value={code} onChange={setCode} disabled={busy} />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="two-step-card__actions">
            <button type="button" className="button button--secondary" onClick={() => void cancelSetup()} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="button button--primary" disabled={busy || code.length !== 6}>
              {busy ? <span className="spinner" aria-hidden="true" /> : 'Confirm'}
            </button>
          </div>
        </form>
      )}

      {mode.kind === 'remove' && (
        <form className="two-step-card__setup form" onSubmit={(e) => void confirmRemove(e)} noValidate>
          <p className="admin-panel__description">
            {devices.length === 1 ? (
              <>
                To remove <strong>{mode.device.name}</strong>, type its current code. This is your only phone, so
                two-step login turns off.
              </>
            ) : (
              <>
                To remove <strong>{mode.device.name}</strong>, type a current code from a phone you are keeping (
                {devices.filter((d) => d.id !== mode.device.id).map((d) => d.name).join(', ')}).
              </>
            )}
          </p>
          <CodeField id="two-step-remove-code" value={code} onChange={setCode} disabled={busy} />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="two-step-card__actions">
            <button type="button" className="button button--secondary" onClick={resetForm} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="button button--danger-outline" disabled={busy || code.length !== 6}>
              {busy ? <span className="spinner" aria-hidden="true" /> : 'Remove'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
