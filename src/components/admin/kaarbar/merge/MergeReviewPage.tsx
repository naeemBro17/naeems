import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../../contexts/AuthContext';
import { useToast } from '../../../../hooks/useToast';
import { fetchCustomersV3, type CustomerRow } from '../../../../lib/adminData';
import {
  chipTexts,
  dueBox,
  itemsByKey,
  mergeRows,
  receiptStatus,
  reviewCounts,
  wrongCustomer,
  type MatchContext,
} from '../../../../lib/kaarbar/merge';
import { setMergeDraft, useMergeDraft } from '../../../../lib/kaarbar/mergeStore';
import { fetchOldSalesStatus, mergeCustomer, type OldSalesStatus } from '../../../../lib/kaarbar/oldSalesApi';
import { fetchCustomerDues, fetchCustomerHistory } from '../../../../lib/money/api';
import { dayText, moneyText } from '../../../../lib/money/format';
import { AdminFormPage } from '../../AdminFormPage';
import { useLeaveGuard } from '../../LeaveGuard';
import { CorrectBalanceSheet } from '../../money/CorrectBalanceSheet';
import { SkeletonRows } from '../../ui/AdminUi';
import { AdminIcon } from '../../ui/AdminIcon';
import { PasswordSheet } from '../KaarbarImportTab';
import { ReceiptCard } from './ReceiptCard';
import '../../../../styles/kaarbarMerge.css';

interface SiteDue {
  ordersDue: number;
  previous: number;
  phoneKey: string | null;
}

/**
 * Batch 54, mockup screen 2: /admin/customers/:key/merge — the receipts of
 * the uploaded statement (up to the cut-off), Kaarbar's due next to the
 * site's, and Merge (Super Admin, password). The statement lives only in
 * this tab's memory; leaving asks first.
 */
export function MergeReviewPage({
  customerKey,
  onBack,
  onOpenReceipt,
  onMerged,
}: {
  customerKey: string;
  onBack: () => void;
  onOpenReceipt: (bill: string) => void;
  onMerged: () => void;
}) {
  const { isAdmin } = useAuth();
  const { showToast } = useToast();
  const { markDirty } = useLeaveGuard();
  const [draft] = useMergeDraft(customerKey);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [status, setStatus] = useState<OldSalesStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [site, setSite] = useState<SiteDue | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [finished, setFinished] = useState(false);

  const loadDue = useCallback(async (c: CustomerRow) => {
    const [dues, history] = await Promise.all([fetchCustomerDues(), fetchCustomerHistory(c.key, c.phone)]);
    setSite({
      ordersDue: dues.get(c.key)?.order_due ?? c.total_due ?? 0,
      previous: history?.previous_left ?? 0,
      phoneKey: history?.phone_key ?? null,
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchCustomersV3(), fetchOldSalesStatus()]).then(([customers, st]) => {
      if (!alive) return;
      const found = customers.rows.find((r) => r.key === customerKey) ?? null;
      setCustomer(found);
      if (st.ok) setStatus(st.data);
      else setLoadError(st.error);
      if (found) void loadDue(found);
    });
    return () => {
      alive = false;
    };
  }, [customerKey, loadDue]);

  // After Merge: back to the customer once the password sheet has closed
  // (it takes its own history entry off first; leaving in the same moment
  // would step back twice).
  const onMergedRef = useRef(onMerged);
  onMergedRef.current = onMerged;
  useEffect(() => {
    if (!finished) return;
    const go = () => onMergedRef.current();
    if ((window.history.state as { modalBackCloseId?: string } | null)?.modalBackCloseId) {
      window.addEventListener('popstate', go, { once: true });
      return () => window.removeEventListener('popstate', go);
    }
    go();
  }, [finished]);

  // Nothing is saved until Merge: leaving this page asks first.
  useEffect(() => {
    if (draft) markDirty();
  }, [draft, markDirty]);

  const ctx: MatchContext | null = useMemo(
    () => (status && draft ? { items: itemsByKey(status.items), edits: draft.edits, choices: status.choices } : null),
    [status, draft]
  );
  const done = useMemo(() => new Set(status?.billKeys ?? []), [status]);
  const statuses = useMemo(() => (draft && ctx ? draft.receipts.map((r) => receiptStatus(r, ctx, done)) : []), [draft, ctx, done]);

  if (!draft) {
    return (
      <AdminFormPage title="Merge old data" backLabel="Back to the customer" onBack={onBack} testId="merge-review" guard={false}>
        {finished ? (
          <SkeletonRows rows={3} thumb={false} />
        ) : (
          <p className="adm-fpage__notice" data-testid="merge-gone">
            The statement is not open any more. Go back to the customer and upload the PDF again.
          </p>
        )}
      </AdminFormPage>
    );
  }

  const s = draft.statement;
  const name = customer ? customer.full_name || customer.phone : '';
  const wrong = customer ? wrongCustomer(s, { name: customer.full_name, phone: customer.phone }) : null;
  const counts = reviewCounts(statuses);
  const marked = counts.needs + counts.bad;
  const rows = ctx ? mergeRows(draft, ctx, done) : null;
  const canMerge = rows !== null && wrong === null && customer !== null;
  const kaarbarDue = s.totalReceivables ?? 0;
  const siteDue = site ? Math.round((site.ordersDue + site.previous) * 100) / 100 : null;
  const box = siteDue === null ? null : dueBox(kaarbarDue, siteDue);
  const canEdit = isAdmin === true && site !== null && site.phoneKey !== null;

  const merge = async (): Promise<string | null> => {
    if (!rows || !customer) return 'Fix the marked receipts first.';
    const answer = await mergeCustomer(customerKey, customer.phone, rows);
    if (!answer.ok) return answer.error;
    setConfirming(false);
    setFinished(true);
    setMergeDraft(customerKey, null);
    showToast(`Merged ${answer.data.added} receipt${answer.data.added === 1 ? '' : 's'}`);
    return null;
  };

  return (
    <AdminFormPage title="Merge old data" backLabel="Back to the customer" onBack={onBack} testId="merge-review">
      <div className="km-page">
        <p className="km-sub" data-testid="merge-sub">
          {name} · statement of {s.reportDate ? dayText(s.reportDate) : 'unknown date'}
        </p>
        {wrong && (
          <p className="km-check km-check--bad" role="alert" data-testid="merge-wrong-customer">
            {wrong}
          </p>
        )}
        {loadError && (
          <p className="km-check km-check--bad" role="alert">
            {loadError}
          </p>
        )}

        <div className="km-card" data-testid="merge-due">
          <div className="km-row">
            <b>Due</b>
            {box && (
              <span className={`km-chip km-chip--${box.tone}`} data-testid="merge-due-chip">
                {box.same && <AdminIcon name="check" className="km-icon" />}
                {box.text}
              </span>
            )}
          </div>
          <div className="km-dues">
            <div className="km-due">
              <span className="km-due__label">Kaarbar</span>
              <b className="km-due__amount" data-testid="merge-due-kaarbar">
                {moneyText(kaarbarDue)}
              </b>
            </div>
            <div className="km-due">
              <span className="km-due__label">On the site</span>
              <b className="km-due__amount" data-testid="merge-due-site">
                {siteDue === null ? '…' : moneyText(siteDue)}
              </b>
              {canEdit && (
                <button type="button" className="km-link km-link--small" onClick={() => setCorrecting(true)} data-testid="merge-due-edit">
                  Edit
                </button>
              )}
            </div>
          </div>
          {box?.differs && <p className="km-note">Fix the receipts, or edit the site&apos;s due, until they match.</p>}
          {site !== null && site.phoneKey === null && <p className="km-note">This customer has no phone, so the site&apos;s due can&apos;t be edited here.</p>}
        </div>

        {ctx ? (
          <div className="km-chips" data-testid="merge-chips">
            {chipTexts(counts).map((c) => (
              <span key={c.text} className={`km-chip km-chip--${c.tone}`}>
                {c.text}
              </span>
            ))}
          </div>
        ) : (
          !loadError && <SkeletonRows rows={3} thumb={false} />
        )}
        {draft.later > 0 && (
          <p className="km-note" data-testid="merge-later">
            {draft.later} later bill{draft.later === 1 ? ' is' : 's are'} already on the site and {draft.later === 1 ? 'is' : 'are'} left out.
          </p>
        )}
        {draft.receivablesNote && <p className="km-note">{draft.receivablesNote}</p>}
        {draft.receipts.length === 0 && <p className="km-note">This statement has no bills up to the cut-off.</p>}

        {ctx &&
          draft.receipts.map((r, i) => (
            <ReceiptCard
              key={r.key}
              kind={r.kind}
              billNo={r.billNo}
              date={r.date}
              total={r.kaarbarTotal}
              note={r.note}
              paid={r.paid !== null && r.due !== null ? { paid: r.paid, due: r.due } : null}
              status={statuses[i]}
              onOpen={() => onOpenReceipt(r.key)}
            />
          ))}
      </div>

      <div className="km-bar">
        <button type="button" className="km-btn km-btn--orange" disabled={!canMerge} onClick={() => setConfirming(true)} data-testid="merge-go">
          Merge {counts.toMerge} receipt{counts.toMerge === 1 ? '' : 's'}
        </button>
        {!canMerge && marked > 0 && (
          <p className="km-note" data-testid="merge-go-note">
            Fix the {marked} marked receipt{marked === 1 ? '' : 's'} first
          </p>
        )}
      </div>

      <PasswordSheet
        isOpen={confirming}
        title={`Merge ${counts.toMerge} receipt${counts.toMerge === 1 ? '' : 's'}?`}
        text={`They are added to ${name}'s old purchases as history. Stock, money and dues do not change.`}
        confirmLabel="Merge"
        onConfirm={merge}
        onClose={() => setConfirming(false)}
      />
      {customer && site && (
        <CorrectBalanceSheet
          isOpen={correcting}
          phone={customer.phone}
          previous={site.previous}
          sitesDue={site.ordersDue}
          kaarbarDue={kaarbarDue}
          onClose={() => setCorrecting(false)}
          onSaved={async (value) => {
            setCorrecting(false);
            showToast(`Previous balance corrected to ${moneyText(value)}`);
            await loadDue(customer);
          }}
        />
      )}
    </AdminFormPage>
  );
}
