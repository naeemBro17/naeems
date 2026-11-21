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
import { phoneText, type NumberOwner } from '../../../../lib/customerNumbers';
import { addCustomerNumber, fetchCustomerNumbers } from '../../../../lib/customerNumbersApi';
import '../../../../styles/kaarbarMerge.css';
import '../../../../styles/customerTools.css';

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
  onWrongCustomer,
  onOpenJoin,
}: {
  customerKey: string;
  onBack: () => void;
  onOpenReceipt: (bill: string) => void;
  onMerged: () => void;
  /** Batch 55: "No, wrong customer" — back to the customer, nothing merged. */
  onWrongCustomer: () => void;
  /** Batch 55: Merge with another customer, with that customer picked. */
  onOpenJoin: (pickKey: string) => void;
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
  // Batch 55: all the customer's numbers (main + extra), and the answer to
  // "The numbers are different".
  const [numbers, setNumbers] = useState<string[] | null>(null);
  const [owner, setOwner] = useState<NumberOwner | null>(null);
  const [saving, setSaving] = useState(false);
  const [samePerson, setSamePerson] = useState(false);

  const loadNumbers = useCallback(async () => {
    const answer = await fetchCustomerNumbers(customerKey);
    setNumbers(answer.ok ? answer.data.map((n) => n.phone_key) : []);
  }, [customerKey]);

  useEffect(() => {
    void loadNumbers();
  }, [loadNumbers]);

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
  const wrong = customer && numbers !== null ? wrongCustomer(s, { name: customer.full_name, phone: customer.phone, numbers }) : null;
  const asking = wrong !== null && !samePerson;
  const counts = reviewCounts(statuses);
  const marked = counts.needs + counts.bad;
  const rows = ctx ? mergeRows(draft, ctx, done) : null;
  const canMerge = rows !== null && !asking && numbers !== null && customer !== null;
  const kaarbarDue = s.totalReceivables ?? 0;
  const siteDue = site ? Math.round((site.ordersDue + site.previous) * 100) / 100 : null;
  const box = siteDue === null ? null : dueBox(kaarbarDue, siteDue);
  const canEdit = isAdmin === true && site !== null && site.phoneKey !== null;

  // "Yes, same person": the PDF's number becomes this customer's old
  // number. With no number in the PDF nothing is saved; merging is allowed
  // for this page only.
  const sameYes = async () => {
    if (!s.phoneKey) {
      setSamePerson(true);
      return;
    }
    setSaving(true);
    const answer = await addCustomerNumber(customerKey, s.phoneKey, 'kaarbar');
    setSaving(false);
    if (!answer.ok) {
      showToast(answer.error, 'error');
      return;
    }
    if (answer.data.kind === 'owner') {
      setOwner(answer.data.owner);
      return;
    }
    showToast(`Saved ${phoneText(s.phoneKey)} as ${name}'s old number`);
    await loadNumbers();
  };

  const sameNo = () => {
    setMergeDraft(customerKey, null);
    showToast('Nothing was merged.');
    onWrongCustomer();
  };

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
        {asking && customer && (
          <>
            <div className="ct-warn" role="alert" data-testid="merge-number-question">
              <b className="ct-warn__title">The numbers are different</b>
              <dl className="ct-vs">
                <dt>Kaarbar</dt>
                <dd>{`${s.partyName || 'No name'} · ${s.phone ? phoneText(s.phone) : 'no number'}`}</dd>
                <dt>This customer</dt>
                <dd>{`${name} · ${phoneText(customer.phone)}`}</dd>
              </dl>
              {owner ? (
                <>
                  <p className="ct-warn__text">{`${phoneText(s.phone)} belongs to ${owner.name} (${owner.orders} orders). Merge that customer into this one first.`}</p>
                  <button type="button" className="km-btn km-btn--dark" onClick={() => onOpenJoin(owner.key)} data-testid="merge-number-join">
                    {`Merge ${owner.name} into ${name}`}
                  </button>
                </>
              ) : (
                <>
                  <p className="ct-warn__text">Is this the same person with an old number?</p>
                  <button type="button" className="km-btn km-btn--dark" onClick={() => void sameYes()} disabled={saving} data-testid="merge-number-yes">
                    Yes, same person
                  </button>
                  <button type="button" className="km-btn ct-warn__ghost" onClick={sameNo} data-testid="merge-number-no">
                    No, wrong customer
                  </button>
                </>
              )}
            </div>
            {!owner && s.phone && (
              <p className="km-note ct-pad">{`If you say yes, ${phoneText(s.phone)} is saved as ${name}'s old number, and the receipts below can be merged.`}</p>
            )}
          </>
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

        {ctx && (
          <div className={`ct-receipts${asking ? ' ct-dim' : ''}`} data-testid="merge-receipts">
            {draft.receipts.map((r, i) => (
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
        )}
      </div>

      <div className="km-bar">
        <button type="button" className="km-btn km-btn--orange" disabled={!canMerge} onClick={() => setConfirming(true)} data-testid="merge-go">
          Merge {counts.toMerge} receipt{counts.toMerge === 1 ? '' : 's'}
        </button>
        {asking ? (
          <p className="km-note" data-testid="merge-go-note">
            Answer the question above first
          </p>
        ) : (
          !canMerge &&
          marked > 0 && (
            <p className="km-note" data-testid="merge-go-note">
              Fix the {marked} marked receipt{marked === 1 ? '' : 's'} first
            </p>
          )
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
