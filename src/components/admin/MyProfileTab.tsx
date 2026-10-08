import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';
import { PasswordField } from './PasswordField';
import { STAFF_PASSWORD_MIN_LENGTH, STAFF_PERMISSIONS, logStaffEvent } from '../../lib/staff';
import { AdminPageHeader } from './ui/AdminUi';
import { TwoStepCard } from './TwoStepCard';

/** A moderator's own page (Batch 24): who they are, what they may do,
 *  change their own password, sign out. */
export function MyProfileTab() {
  const { staff, signOut } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  if (!staff) return null;

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < STAFF_PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${STAFF_PASSWORD_MIN_LENGTH} characters`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setIsSaving(true);
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setIsSaving(false);
    if (updateError) {
      setError('Could not change the password. Please try again.');
      return;
    }
    void logStaffEvent('staff.password_changed');
    setNewPassword('');
    setConfirmPassword('');
    showToast('Password changed');
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);
    navigate('/');
    await signOut();
  };

  const allowed = STAFF_PERMISSIONS.filter((p) => staff.permissions.includes(p.id));

  return (
    <section aria-label="My Profile">
      <AdminPageHeader title="My Profile" />

      <div className="admin-panel">
        <div className="checkout-summary-card__row profile-row">
          <span>Username</span>
          <strong>{staff.username}</strong>
        </div>
        <div className="checkout-summary-card__row profile-row">
          <span>Name</span>
          <strong>{staff.full_name || '—'}</strong>
        </div>
        <div className="checkout-summary-card__row profile-row">
          <span>Phone</span>
          <strong>{staff.phone || '—'}</strong>
        </div>
        <p className="admin-panel__description">To change your name or phone, ask Naeem.</p>
      </div>

      <div className="admin-panel">
        <h3 className="admin-panel__title">What you can do</h3>
        {allowed.length === 0 ? (
          <p className="admin-panel__description">Nothing is switched on for you yet. Ask Naeem.</p>
        ) : (
          <ul className="profile-permissions">
            {allowed.map((p) => (
              <li key={p.id}>{p.label}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="admin-panel">
        <h3 className="admin-panel__title">Change password</h3>
        <form onSubmit={handleChangePassword} className="form" noValidate>
          <PasswordField
            id="profile-new-password"
            label="New password"
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
          />
          <PasswordField
            id="profile-confirm-password"
            label="Confirm new password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="button button--primary"
            disabled={isSaving || newPassword === '' || confirmPassword === ''}
          >
            {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Change password'}
          </button>
        </form>
      </div>

      {/* Batch 34: optional for staff — the same card as Settings → Security. */}
      <TwoStepCard />

      <div className="admin-panel">
        <h3 className="admin-panel__title">Sign out</h3>
        <button
          type="button"
          className="button button--danger-outline"
          onClick={handleSignOut}
          disabled={isSigningOut}
        >
          {isSigningOut ? <span className="spinner" aria-hidden="true" /> : 'Sign out'}
        </button>
      </div>
    </section>
  );
}
