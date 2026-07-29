import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../hooks/useToast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import type { WholesalerAccount, ProfileStatus } from '../../types';

interface WholesalerListProps {
  accounts: WholesalerAccount[];
  /** Re-fetch the list after a status change. */
  onReload: () => Promise<void> | void;
}

type StatusFilter = 'pending' | 'approved' | 'all';

const STATUS_META: Record<ProfileStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'status-badge status-badge--pending' },
  approved: { label: 'Approved', className: 'status-badge status-badge--approved' },
  rejected: { label: 'Rejected', className: 'status-badge status-badge--rejected' },
  revoked: { label: 'Revoked', className: 'status-badge status-badge--revoked' },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function WholesalerList({ accounts, onReload }: WholesalerListProps) {
  const { showToast } = useToast();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<WholesalerAccount | null>(null);

  // Only wholesaler accounts appear here (admins are managed via Supabase).
  const wholesalers = useMemo(
    () => accounts.filter((a) => a.role === 'wholesaler'),
    [accounts]
  );

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return wholesalers;
    return wholesalers.filter((a) => a.status === statusFilter);
  }, [wholesalers, statusFilter]);

  const updateStatus = async (
    account: WholesalerAccount,
    status: ProfileStatus,
    successMessage: string
  ) => {
    setBusyId(account.id);
    const patch: { status: ProfileStatus; approved_at?: string } = { status };
    if (status === 'approved') {
      patch.approved_at = new Date().toISOString();
    }
    const { error } = await supabase.from('profiles').update(patch).eq('id', account.id);
    setBusyId(null);
    if (error) {
      showToast('Could not update the account. Please try again.', 'error');
      return;
    }
    await onReload();
    showToast(successMessage);
  };

  const handleApprove = (account: WholesalerAccount) =>
    updateStatus(account, 'approved', `${account.business_name || 'Account'} approved`);

  const handleReject = (account: WholesalerAccount) =>
    updateStatus(account, 'rejected', `${account.business_name || 'Account'} rejected`);

  const confirmRevoke = async () => {
    if (!revoking) return;
    const account = revoking;
    setRevoking(null);
    await updateStatus(account, 'revoked', `${account.business_name || 'Account'} revoked`);
  };

  return (
    <section aria-label="Wholesalers">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Wholesalers</h2>
        <select
          className="form-input form-select admin-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="Filter wholesalers by status"
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="all">All</option>
        </select>
      </header>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state__message">
            {statusFilter === 'pending'
              ? 'No pending requests'
              : 'No wholesaler accounts to show'}
          </p>
        </div>
      ) : (
        <ul className="admin-wholesaler-list">
          {filtered.map((account) => {
            const meta = STATUS_META[account.status];
            const isBusy = busyId === account.id;
            return (
              <li key={account.id} className="admin-wholesaler-row">
                <div className="admin-wholesaler-row__info">
                  <p className="admin-wholesaler-row__name">
                    {account.business_name || '(no business name)'}
                  </p>
                  <p className="admin-wholesaler-row__meta">
                    {account.email ?? '—'}
                    {account.phone ? ` · ${account.phone}` : ''}
                  </p>
                  <p className="admin-wholesaler-row__date">
                    Signed up {formatDate(account.created_at)}
                  </p>
                  <span className={meta.className}>{meta.label}</span>
                </div>

                <div className="admin-wholesaler-row__actions">
                  {account.status === 'pending' && (
                    <>
                      <button
                        type="button"
                        className="button button--primary button--small"
                        onClick={() => handleApprove(account)}
                        disabled={isBusy}
                      >
                        {isBusy ? <span className="spinner" aria-hidden="true" /> : 'Approve'}
                      </button>
                      <button
                        type="button"
                        className="button button--danger-outline button--small"
                        onClick={() => handleReject(account)}
                        disabled={isBusy}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {account.status === 'approved' && (
                    <button
                      type="button"
                      className="button button--danger-outline button--small"
                      onClick={() => setRevoking(account)}
                      disabled={isBusy}
                    >
                      Revoke Access
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        isOpen={revoking !== null}
        title="Revoke Access"
        confirmLabel="Revoke Access"
        message={
          revoking
            ? `Revoke wholesale access for ${revoking.business_name || 'this account'}? They will need to be re-approved to see wholesale prices again.`
            : ''
        }
        onConfirm={confirmRevoke}
        onClose={() => setRevoking(null)}
      />
    </section>
  );
}
