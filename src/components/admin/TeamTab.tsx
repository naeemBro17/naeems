import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { PasswordField } from './PasswordField';
import { useToast } from '../../hooks/useToast';
import { useUrlParam } from '../../hooks/useUrlParams';
import {
  STAFF_PASSWORD_MIN_LENGTH,
  STAFF_PERMISSIONS,
  USERNAME_PATTERN,
  createModerator,
  deleteModerator,
  deleteRole,
  fetchRoles,
  fetchTeam,
  formatDhakaTime,
  resetModeratorPassword,
  saveRole,
  setMemberRole,
  togglePermission,
  updateModerator,
} from '../../lib/staff';
import { AdminPageHeader, EmptyState, SkeletonRows } from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';
import type { StaffPermission, StaffRole, TeamMember } from '../../types';

type TeamView = 'staff' | 'roles';
const TEAM_VIEWS: readonly TeamView[] = ['staff', 'roles'];

function permissionLabels(perms: readonly StaffPermission[]): string[] {
  return STAFF_PERMISSIONS.filter((p) => perms.includes(p.id)).map((p) => p.label);
}

/**
 * Admin → Team (Super Admin only). Batch 24 added staff logins; Batch 25
 * Part 6 adds Roles: a role (Moderator, Manager, Accounts ...) holds the
 * permission switches, and each staff member gets one role. Changing a
 * role's switches changes everyone with it at once — checked inside the
 * database on every action (staff_can()), not only here.
 */
export function TeamTab() {
  const [view, setView] = useUrlParam<TeamView>('tview', 'staff', TEAM_VIEWS);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [editingRole, setEditingRole] = useState<StaffRole | 'new' | null>(null);

  const load = useCallback(async () => {
    const [members, roleList] = await Promise.all([fetchTeam(), fetchRoles()]);
    setTeam(members);
    setRoles(roleList);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const primary =
    view === 'staff' ? (
      <button type="button" className="adm-btn adm-btn--primary" onClick={() => setIsAddOpen(true)}>
        <AdminIcon name="plus" />
        Add staff member
      </button>
    ) : (
      <button type="button" className="adm-btn adm-btn--primary" onClick={() => setEditingRole('new')}>
        <AdminIcon name="plus" />
        Create role
      </button>
    );

  return (
    <section aria-label="Team" className="adm-team">
      <AdminPageHeader title="Team" primary={primary} />
      <div role="tablist" aria-label="Team" className="adm-segment">
        {TEAM_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            className={`adm-segment__tab${view === v ? ' adm-segment__tab--on' : ''}`}
            onClick={() => setView(v)}
          >
            {v === 'staff' ? `Staff (${team.length})` : `Roles (${roles.length})`}
          </button>
        ))}
      </div>

      {view === 'staff' ? (
        <>
          <p className="admin-panel__description team-intro">
            Staff sign in on the admin login page with "Staff login" (username and password). They only see what
            their role allows. Team, Settings, Safety Locks, price edits and the Activity Log stay with you.
          </p>
          {isLoading ? (
            <SkeletonRows rows={3} thumb={false} />
          ) : team.length === 0 ? (
            <EmptyState icon="team" title="No staff yet" hint="Create a role first, then add a staff member and pick their role." />
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
                      <span className="admin-order-row__time" data-testid="member-role">
                        {member.role_name ?? `Own switches (${member.permissions.length})`}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <p className="admin-panel__description team-intro">
            A role is a set of permission switches, e.g. Moderator, Manager, Accounts. Everyone with the role gets
            exactly those switches, and a change applies to all of them at once.
          </p>
          {isLoading ? (
            <SkeletonRows rows={3} thumb={false} />
          ) : roles.length === 0 ? (
            <EmptyState icon="shield" title="No roles yet" hint='Tap "Create role" to make your first one, e.g. "Moderator".' />
          ) : (
            <ul className="admin-list">
              {roles.map((role) => (
                <li key={role.id}>
                  <button type="button" className="admin-order-row" onClick={() => setEditingRole(role)}>
                    <div className="admin-order-row__main">
                      <span className="admin-order-row__number">{role.name}</span>
                      <span className="admin-order-row__customer">
                        {role.permissions.length === 0 ? 'No permissions yet' : permissionLabels(role.permissions).join(', ')}
                      </span>
                    </div>
                    <div className="admin-order-row__end">
                      <span className="admin-order-row__time">
                        {role.member_count} {role.member_count === 1 ? 'person' : 'people'}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <AddMemberSheet
        isOpen={isAddOpen}
        roles={roles}
        onClose={() => setIsAddOpen(false)}
        onCreateRole={() => {
          setIsAddOpen(false);
          setView('roles');
          setEditingRole('new');
        }}
        onCreated={async () => {
          setIsAddOpen(false);
          await load();
        }}
      />

      <EditMemberSheet member={editing} roles={roles} onClose={() => setEditing(null)} onChanged={load} />

      <RoleSheet role={editingRole} onClose={() => setEditingRole(null)} onChanged={load} />
    </section>
  );
}

function RoleSelect({
  id,
  roles,
  value,
  onChange,
}: {
  id: string;
  roles: StaffRole[];
  value: string;
  onChange: (roleId: string) => void;
}) {
  return (
    <select id={id} className="form-input form-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a role</option>
      {roles.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

function AddMemberSheet({
  isOpen,
  roles,
  onClose,
  onCreateRole,
  onCreated,
}: {
  isOpen: boolean;
  roles: StaffRole[];
  onClose: () => void;
  onCreateRole: () => void;
  onCreated: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setUsername('');
      setFullName('');
      setPhone('');
      setPassword('');
      setRoleId(roles.length === 1 ? roles[0].id : '');
      setError(null);
    }
  }, [isOpen, roles]);

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
    if (roleId === '') {
      setError('Choose their role.');
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
    if (result.error || !result.userId) {
      setIsSaving(false);
      setError(result.error ?? 'Could not add the staff member.');
      return;
    }
    const roleResult = await setMemberRole(result.userId, roleId);
    setIsSaving(false);
    const roleName = roles.find((r) => r.id === roleId)?.name ?? 'their role';
    if (roleResult.error) {
      // The login exists but has no permissions yet (safe). Say so plainly.
      showToast(`"${cleanUsername}" added, but the role could not be set. Open them and pick the role again.`, 'error');
    } else {
      showToast(`"${cleanUsername}" added as ${roleName}`);
    }
    await onCreated();
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Add staff member">
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
        <div className="form-field">
          <label className="form-label" htmlFor="team-role">
            Role
          </label>
          {roles.length === 0 ? (
            <p className="form-hint">
              There are no roles yet.{' '}
              <button type="button" className="adm-link" onClick={onCreateRole}>
                Create a role first
              </button>
            </p>
          ) : (
            <RoleSelect id="team-role" roles={roles} value={roleId} onChange={setRoleId} />
          )}
          <p className="form-hint">Their permissions come from the role.</p>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button button--primary button--full" disabled={isSaving || roles.length === 0}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Add staff member'}
        </button>
      </form>
    </BottomSheet>
  );
}

function EditMemberSheet({
  member,
  roles,
  onClose,
  onChanged,
}: {
  member: TeamMember | null;
  roles: StaffRole[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
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
    setRoleId(member.role_id ?? '');
    setDisabled(member.is_disabled);
    setNewPassword('');
    setError(null);
    setDeleteStep(0);
  }, [member]);

  const chosenRole = roles.find((r) => r.id === roleId) ?? null;
  const shownPermissions = chosenRole ? chosenRole.permissions : (member?.permissions ?? []);

  const handleSave = async () => {
    if (!member) return;
    setIsSaving(true);
    setError(null);
    // Name, phone and on/off go through the admin-team function as before,
    // with the permissions they have now, so nothing changes by accident.
    const result = await updateModerator({
      userId: member.id,
      fullName: fullName.trim(),
      phone: phone.trim(),
      permissions: member.permissions,
      disabled,
    });
    if (result.error) {
      setIsSaving(false);
      setError(result.error);
      return;
    }
    if (roleId !== '' && roleId !== member.role_id) {
      const roleResult = await setMemberRole(member.id, roleId);
      if (roleResult.error) {
        setIsSaving(false);
        setError(roleResult.error);
        return;
      }
    }
    setIsSaving(false);
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
    showToast(`"${member.username}" deleted`);
    await onChanged();
    onClose();
  };

  return (
    <BottomSheet isOpen={member !== null} onClose={onClose} title={member ? `Staff: ${member.username}` : 'Staff member'}>
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
          <div className="form-field">
            <label className="form-label" htmlFor="team-edit-role">
              Role
            </label>
            <RoleSelect id="team-edit-role" roles={roles} value={roleId} onChange={setRoleId} />
            {!member.role_id && (
              <p className="form-hint">
                They still have their own switches from before roles existed. Pick a role to move them onto it.
              </p>
            )}
          </div>

          <h3 className="team-form__heading">What they can do</h3>
          {shownPermissions.length === 0 ? (
            <p className="form-hint">Nothing is switched on for this role yet.</p>
          ) : (
            <ul className="adm-perm-list" aria-label="Permissions from their role">
              {permissionLabels(shownPermissions).map((label) => (
                <li key={label}>
                  <AdminIcon name="check" className="adm-icon--sm" />
                  {label}
                </li>
              ))}
            </ul>
          )}
          <p className="form-hint">To change these switches, edit the role in the Roles tab. Everyone with that role changes together.</p>

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
            Delete staff member
          </button>
        </div>
      )}

      <ConfirmDialog
        isOpen={deleteStep === 1}
        title="Delete this staff member?"
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
        message={`Last check: permanently delete "${member?.username ?? ''}"? This cannot be undone.`}
        confirmLabel="Delete permanently"
        cancelLabel="Cancel"
        danger
        onConfirm={handleDelete}
        onClose={() => setDeleteStep(0)}
      />
    </BottomSheet>
  );
}

function RoleSheet({
  role,
  onClose,
  onChanged,
}: {
  role: StaffRole | 'new' | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<StaffPermission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const existing = role !== null && role !== 'new' ? role : null;

  useEffect(() => {
    if (role === null) return;
    setName(existing?.name ?? '');
    setPermissions(existing?.permissions ?? []);
    setError(null);
    setConfirmDelete(false);
  }, [role, existing]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === '') {
      setError('Give the role a name, e.g. Manager.');
      return;
    }
    setIsSaving(true);
    setError(null);
    const result = await saveRole({ id: existing?.id ?? null, name, permissions });
    setIsSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    showToast(existing ? `Role "${name.trim()}" saved` : `Role "${name.trim()}" created`);
    await onChanged();
    onClose();
  };

  const handleDelete = async () => {
    if (!existing) return;
    const result = await deleteRole(existing.id);
    setConfirmDelete(false);
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast(`Role "${existing.name}" deleted`);
    await onChanged();
    onClose();
  };

  const title = existing ? `Role: ${existing.name}` : 'Create role';

  return (
    <BottomSheet isOpen={role !== null} onClose={onClose} title={title}>
      {role !== null && (
        <form className="form team-form" onSubmit={handleSave} noValidate>
          <div className="form-field">
            <label className="form-label" htmlFor="role-name">
              Role name
            </label>
            <input
              id="role-name"
              className="form-input"
              value={name}
              maxLength={40}
              placeholder="e.g. Manager"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <h3 className="team-form__heading">What this role can do</h3>
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
          {existing && existing.member_count > 0 && (
            <p className="form-hint">
              {existing.member_count} {existing.member_count === 1 ? 'person has' : 'people have'} this role. Saving
              changes what they can do straight away.
            </p>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="button button--primary button--full" disabled={isSaving}>
            {isSaving ? <span className="spinner" aria-hidden="true" /> : existing ? 'Save' : 'Create role'}
          </button>

          {existing && (
            <>
              <button
                type="button"
                className="button button--danger-outline button--full"
                disabled={existing.member_count > 0}
                onClick={() => setConfirmDelete(true)}
              >
                Delete role
              </button>
              {existing.member_count > 0 && (
                <p className="form-hint">A role can only be deleted when nobody has it. Move them to another role first.</p>
              )}
            </>
          )}
        </form>
      )}

      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete this role?"
        message={`Delete the role "${existing?.name ?? ''}"? This cannot be undone.`}
        confirmLabel="Delete role"
        danger
        onConfirm={handleDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </BottomSheet>
  );
}

