import { useMemo, useState } from 'react';
import { useUrlParam } from '../../hooks/useUrlParams';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../hooks/useToast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import type { WholesalerAccount, ProfileStatus } from '../../types';
import { AdminPageHeader, KebabMenu } from './ui/AdminUi';

interface WholesalerListProps {
  accounts: WholesalerAccount[];
  /** Re-fetch the list after a status change. */
  onReload: () => Promise<void> | void;
  /** Batch 24: a moderator with "View customers" sees the list but cannot
   *  approve, reject or revoke (the database refuses it too). */
  readOnly?: boolean;
}

type StatusFilter = 'pending' | 'approved' | 'all';
const STATUS_FILTERS: readonly StatusFilter[] = ['pending', 'approved', 'all'];

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

export function WholesalerList({ accounts, onReload, readOnly = false }: WholesalerListProps) {
  const { showToast } = useToast();
  // In the URL so it survives leaving the admin panel and coming Back.
  const [statusFilter, setStatusFilter] = useUrlParam<StatusFilter>('wstatus', 'pending', STATUS_FILTERS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<WholesalerAccount | null>(null);
  const [rejecting, setRejecting] = useState<WholesalerAccount | null>(null);

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
      <AdminPageHeader title="Wholesalers" />
      <div className="adm-filter-row adm-filter-row--end">
        <select
          className="adm-select admin-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="Filter wholesalers by status"
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="all">All</option>
        </select>
      </div>

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
                  {!readOnly && account.status === 'pending' && (
                    <>
                      <button
                        type="button"
                        className="button button--primary button--small"
                        onClick={() => handleApprove(account)}
                        disabled={isBusy}
                      >
                        {isBusy ? <span className="spinner" aria-hidden="true" /> : 'Approve'}
                      </button>
                      <KebabMenu
                        label={`More actions for ${account.business_name || 'this account'}`}
                        items={[
                          { label: 'Reject', icon: 'close', danger: true, disabled: isBusy, onSelect: () => setRejecting(account) },
                        ]}
                      />
                    </>
                  )}
                  {!readOnly && account.status === 'approved' && (
                    <KebabMenu
                      label={`More actions for ${account.business_name || 'this account'}`}
                      items={[
                        { label: 'Revoke Access', icon: 'close', danger: true, disabled: isBusy, onSelect: () => setRevoking(account) },
                      ]}
                    />
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

      <ConfirmDialog
        isOpen={rejecting !== null}
        title="Reject this request?"
        confirmLabel="Reject"
        message={
          rejecting
            ? `Reject the wholesale request from ${rejecting.business_name || 'this account'}? They will not see wholesale prices.`
            : ''
        }
        onConfirm={async () => {
          if (rejecting) await handleReject(rejecting);
          setRejecting(null);
        }}
        onClose={() => setRejecting(null)}
      />
    </section>
  );
}
