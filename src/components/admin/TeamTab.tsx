import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { PasswordField } from './PasswordField';
import { useToast } from '../../hooks/useToast';
import {
  STAFF_PASSWORD_MIN_LENGTH,
  STAFF_PERMISSIONS,
  USERNAME_PATTERN,
  createModerator,
  deleteModerator,
  fetchTeam,
  formatDhakaTime,
  resetModeratorPassword,
  togglePermission,
  updateModerator,
} from '../../lib/staff';
import type { StaffPermission, TeamMember } from '../../types';

/**
 * Admin → Team (Super Admin only, Batch 24 Part 1). Add moderators, choose
 * what each one may do, reset their password, switch them off, delete them.
 * Every change goes through the admin-team Edge Function and the database's
 * own checks — this page only shows the switches.
 */
export function TeamTab() {
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);

  const load = useCallback(async () => {
    setTeam(await fetchTeam());
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-label="Team">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Team</h2>
        <button type="button" className="button button--primary button--small" onClick={() => setIsAddOpen(true)}>
          Add moderator
        </button>
      </header>
      <p className="admin-panel__description team-intro">
        Moderators sign in on the admin login page with "Staff login" (username and password). They only see
        what you switch on for them. Team, Settings, Safety Locks, price edits and the Activity Log stay with
        you.
      </p>

      {isLoading ? (
        <div className="full-screen-center" style={{ minHeight: 120 }}>
          <span className="spinner spinner--large" aria-hidden="true" />
        </div>
      ) : team.length === 0 ? (
        <p className="admin-panel__description">No moderators yet.</p>
      ) : (
        <ul className="admin-list">
          {team.map((member) => (
            <li key={member.id}>
              <button type="button" className="admin-order-row" onClick={() => setEditing(member)}>
                <div className="admin-order-row__main">
                  <span className="admin-order-row__number">{member.username}</span>
                  <span className="admin-order-row__customer">
                    {member.full_name || 'No name'}
                    {member.phone ? ` · ${member.phone}` : ''}
                  </span>
                  <span className="admin-order-row__time">
                    {member.last_login ? `Last login ${formatDhakaTime(member.last_login)}` : 'Never signed in'}
                  </span>
                </div>
                <div className="admin-order-row__end">
                  <span className={`status-badge status-badge--${member.is_disabled ? 'danger' : 'success'}`}>
                    {member.is_disabled ? 'Disabled' : 'Active'}
                  </span>
                  <span className="admin-order-row__time">
                    {member.permissions.length} permission{member.permissions.length === 1 ? '' : 's'}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <AddModeratorSheet
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onCreated={async () => {
          setIsAddOpen(false);
          await load();
        }}
      />

      <EditModeratorSheet
        member={editing}
        onClose={() => setEditing(null)}
        onChanged={load}
      />
    </section>
  );
}

function AddModeratorSheet({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setUsername('');
      setFullName('');
      setPhone('');
      setPassword('');
      setError(null);
    }
  }, [isOpen]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanUsername = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(cleanUsername)) {
      setError('Username: 3–30 characters, lowercase letters, numbers, "." and "_" only.');
      return;
    }
    if (fullName.trim() === '') {
      setError('Enter their full name.');
      return;
    }
    if (password.length < STAFF_PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${STAFF_PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    setError(null);
    setIsSaving(true);
    const result = await createModerator({
      username: cleanUsername,
      fullName: fullName.trim(),
      phone: phone.trim(),
      password,
    });
    setIsSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    showToast(`Moderator "${cleanUsername}" added. All permissions start OFF.`);
    await onCreated();
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Add moderator">
      <form className="form team-form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label className="form-label" htmlFor="team-username">
            Username
          </label>
          <input
            id="team-username"
            className="form-input"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="form-hint">Their login ID. Lowercase letters, numbers, "." and "_".</p>
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="team-full-name">
            Full name
          </label>
          <input id="team-full-name" className="form-input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="team-phone">
            Phone
          </label>
          <input
            id="team-phone"
            className="form-input"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <PasswordField
          id="team-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={`At least ${STAFF_PASSWORD_MIN_LENGTH} characters.`}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button button--primary button--full" disabled={isSaving}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Add moderator'}
        </button>
      </form>
    </BottomSheet>
  );
}

function EditModeratorSheet({
  member,
  onClose,
  onChanged,
}: {
  member: TeamMember | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [permissions, setPermissions] = useState<StaffPermission[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!member) return;
    setFullName(member.full_name);
    setPhone(member.phone);
    setPermissions(member.permissions);
    setDisabled(member.is_disabled);
    setNewPassword('');
    setError(null);
    setDeleteStep(0);
  }, [member]);

  const handleSave = async () => {
    if (!member) return;
    setIsSaving(true);
    setError(null);
    const result = await updateModerator({
      userId: member.id,
      fullName: fullName.trim(),
      phone: phone.trim(),
      permissions,
      disabled,
    });
    setIsSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    showToast('Saved');
    await onChanged();
    onClose();
  };

  const handleResetPassword = async () => {
    if (!member) return;
    if (newPassword.length < STAFF_PASSWORD_MIN_LENGTH) {
      setError(`New password must be at least ${STAFF_PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    setIsResetting(true);
    setError(null);
    const result = await resetModeratorPassword(member.id, newPassword);
    setIsResetting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setNewPassword('');
    showToast('Password reset. Give them the new password.');
  };

  const handleDelete = async () => {
    if (!member) return;
    const result = await deleteModerator(member.id);
    setDeleteStep(0);
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast(`Moderator "${member.username}" deleted`);
    await onChanged();
    onClose();
  };

  return (
    <BottomSheet isOpen={member !== null} onClose={onClose} title={member ? `Moderator: ${member.username}` : 'Moderator'}>
      {member && (
        <div className="form team-form">
          <div className="form-field">
            <label className="form-label" htmlFor="team-edit-name">
              Full name
            </label>
            <input id="team-edit-name" className="form-input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="team-edit-phone">
              Phone
            </label>
            <input
              id="team-edit-phone"
              className="form-input"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>

          <h3 className="team-form__heading">What they can do</h3>
          <ul className="team-permissions">
            {STAFF_PERMISSIONS.map((perm) => {
              const isOn = permissions.includes(perm.id);
              return (
                <li key={perm.id} className="form-field form-field--toggle team-permissions__row">
                  <span className="team-permissions__text">
                    <span className="toggle-label">{perm.label}</span>
                    <span className="form-hint">{perm.hint}</span>
                  </span>
                  <button
                    type="button"
                    className={`toggle${isOn ? ' toggle--on' : ''}`}
                    role="switch"
                    aria-checked={isOn}
                    aria-label={perm.label}
                    onClick={() => setPermissions((current) => togglePermission(current, perm.id))}
                  >
                    <span className="toggle__thumb" />
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="form-field form-field--toggle team-permissions__row">
            <span className="team-permissions__text">
              <span className="toggle-label">Disabled</span>
              <span className="form-hint">Cannot sign in or do anything. History is kept.</span>
            </span>
            <button
              type="button"
              className={`toggle${disabled ? ' toggle--on' : ''}`}
              role="switch"
              aria-checked={disabled}
              aria-label="Disabled"
              onClick={() => setDisabled((d) => !d)}
            >
              <span className="toggle__thumb" />
            </button>
          </div>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <button type="button" className="button button--primary button--full" onClick={handleSave} disabled={isSaving}>
            {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
          </button>

          <h3 className="team-form__heading">Reset password</h3>
          <PasswordField
            id="team-reset-password"
            label="New password"
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
          />
          <button
            type="button"
            className="button button--secondary button--full"
            onClick={handleResetPassword}
            disabled={isResetting || newPassword === ''}
          >
            {isResetting ? <span className="spinner" aria-hidden="true" /> : 'Reset password'}
          </button>

          <button type="button" className="button button--danger-outline button--full" onClick={() => setDeleteStep(1)}>
            Delete moderator
          </button>
        </div>
      )}

      <ConfirmDialog
        isOpen={deleteStep === 1}
        title="Delete this moderator?"
        message={`"${member?.username ?? ''}" will no longer be able to sign in. Their past activity stays in the Activity Log. If you only want to stop them for now, use "Disabled" instead.`}
        confirmLabel="Yes, delete"
        cancelLabel="Keep"
        danger
        onConfirm={() => setDeleteStep(2)}
        onClose={() => setDeleteStep(0)}
      />
      <ConfirmDialog
        isOpen={deleteStep === 2}
        title="Are you sure?"
        message={`Last check: permanently delete moderator "${member?.username ?? ''}"? This cannot be undone.`}
        confirmLabel="Delete permanently"
        cancelLabel="Cancel"
        danger
        onConfirm={handleDelete}
        onClose={() => setDeleteStep(0)}
      />
    </BottomSheet>
  );
}
