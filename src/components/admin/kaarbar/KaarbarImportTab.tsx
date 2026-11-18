import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { fetchKaarbarStatus, NEEDS_UPDATE, type KaarbarStatus } from '../../../lib/kaarbar/api';
import { confirmPassword } from '../../../lib/reports/api';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { ConfirmSheet } from '../OrderActionCards';
import { KaarbarCustomersCard } from './KaarbarCustomersCard';
import { KaarbarExpensesCard } from './KaarbarExpensesCard';
import { KaarbarProductsCard } from './KaarbarProductsCard';
import { KaarbarSalesCard } from './KaarbarSalesCard';
import { fetchOldSalesStatus, type OldSalesStatus } from '../../../lib/kaarbar/oldSalesApi';
import '../../../styles/adminInventory.css';
import '../../../styles/kaarbar.css';

/**
 * Batch 49: Admin → Import from Kaarbar. Two cards — Customers and
 * Expenses. Batch 50 adds Step 1 · Old products and Step 2 · Old sales. Each reads a Kaarbar Excel report here in the browser, shows
 * what will happen to every row, and saves nothing until the Super Admin
 * confirms with the password. Undo is under Careful actions.
 */
export function KaarbarImportTab() {
  const [status, setStatus] = useState<KaarbarStatus | null>(null);
  const [error, setError] = useState<{ text: string; needsUpdate: boolean } | null>(null);
  const [oldStatus, setOldStatus] = useState<OldSalesStatus | null>(null);
  const [oldError, setOldError] = useState<{ text: string; needsUpdate: boolean } | null>(null);

  const load = useCallback(async () => {
    const answer = await fetchKaarbarStatus();
    if (answer.ok) {
      setStatus(answer.data);
      setError(null);
    } else {
      setError({ text: answer.error, needsUpdate: answer.needsUpdate });
    }
  }, []);

  const loadOld = useCallback(async () => {
    const answer = await fetchOldSalesStatus();
    if (answer.ok) {
      setOldStatus(answer.data);
      setOldError(null);
    } else {
      setOldError({ text: answer.error, needsUpdate: answer.needsUpdate });
    }
  }, []);

  useEffect(() => {
    void load();
    void loadOld();
  }, [load, loadOld]);

  return (
    <section className="inv kb" aria-label="Import from Kaarbar">
      <AdminPageHeader title="Import from Kaarbar" subtitle="Customers, expenses and old sales from your Kaarbar reports" />
      <p className="inv-muted">
        Pick a report you exported from Kaarbar (Excel, or PDF for the party statements). The file is read on this phone and is never uploaded. Nothing is saved until you
        press Import and type your password. No message is sent to anyone.
      </p>
      {error ? (
        error.needsUpdate ? (
          <div className="kb-notice" role="alert" data-testid="kb-needs-update">
            <b>{NEEDS_UPDATE.replace('This needs', 'This screen needs')}</b>
            <span>Run the SQL from the Batch 49 report in the Supabase SQL Editor, then open this page again.</span>
          </div>
        ) : (
          <EmptyState icon="alert" title="Could not load" hint={error.text} />
        )
      ) : !status ? (
        <SkeletonRows rows={4} thumb={false} />
      ) : (
        <>
          <KaarbarCustomersCard status={status} onChanged={load} />
          <KaarbarExpensesCard status={status} onChanged={load} />
          {oldError ? (
            <div className="kb-notice" role="alert" data-testid="kb-old-needs-update">
              <b>{oldError.needsUpdate ? 'Old products and old sales need the Batch 50 database update (migration-051).' : oldError.text}</b>
              {oldError.needsUpdate && <span>Run the SQL from the Batch 50 report in the Supabase SQL Editor, then open this page again.</span>}
            </div>
          ) : !oldStatus ? (
            <SkeletonRows rows={2} thumb={false} />
          ) : (
            <>
              <KaarbarProductsCard status={oldStatus} onChanged={loadOld} />
              <KaarbarSalesCard status={oldStatus} onChanged={loadOld} />
            </>
          )}
        </>
      )}
    </section>
  );
}

/** The Careful actions confirmation, with the password (the same pattern
 *  as locking a month). onConfirm returns an error to show, or null. */
export function PasswordSheet({
  isOpen,
  title,
  text,
  warning,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
  children,
}: {
  isOpen: boolean;
  title: string;
  text: string;
  warning?: string | null;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { session } = useAuth();
  const [password, setPassword] = useState('');
  const [sheetError, setSheetError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPassword('');
      setSheetError(null);
    }
  }, [isOpen]);

  const confirm = async () => {
    setSheetError(null);
    const wrong = await confirmPassword(session?.user.email, password);
    if (wrong) {
      setSheetError(wrong);
      return;
    }
    const failed = await onConfirm();
    if (failed) setSheetError(failed);
  };

  return (
    <ConfirmSheet
      isOpen={isOpen}
      title={title}
      warning={warning ?? null}
      keepLabel="Cancel"
      confirmLabel={confirmLabel}
      danger={danger}
      onConfirm={confirm}
      onClose={onClose}
    >
      <p className="adm-csheet__text">{text}</p>
      {children}
      <label className="adm-csheet__type">
        <span>Type your password to confirm</span>
        <input
          className="form-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="kb-password"
        />
      </label>
      {sheetError && (
        <p className="inv-error" role="alert" data-testid="kb-sheet-error">
          {sheetError}
        </p>
      )}
    </ConfirmSheet>
  );
}

/** "18 Nov 2026, 10:42" in Dhaka time. */
export function importWhen(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
