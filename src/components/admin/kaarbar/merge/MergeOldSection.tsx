import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../../../contexts/AuthContext';
import { useToast } from '../../../../hooks/useToast';
import { adminPath } from '../../../../lib/adminPages';
import { dhakaToday } from '../../../../lib/inventory/api';
import { buildDraft, OLD_SALES_CUTOFF } from '../../../../lib/kaarbar/merge';
import { setMergeDraft } from '../../../../lib/kaarbar/mergeStore';
import { readStatement } from '../../../../lib/kaarbar/oldSales';
import { fetchOldSalesStatus, undoCustomerMerge } from '../../../../lib/kaarbar/oldSalesApi';
import { readPdfText } from '../../../../lib/kaarbar/statementPdf';
import { dayText, moneyText } from '../../../../lib/money/format';
import { fetchOldPurchases, type OldPurchase } from '../../../../lib/money/oldPurchases';
import { AdminIcon } from '../../ui/AdminIcon';
import { PasswordSheet } from '../KaarbarImportTab';
import { ReceiptCard } from './ReceiptCard';
import '../../../../styles/kaarbarMerge.css';

const FIRST = 3;

/**
 * Batch 54 on the customer page, right after TO RECEIVE:
 *  - no old bills yet (Super Admin): "MERGE OLD DATA" — upload this
 *    customer's Kaarbar party statement (read here, never uploaded);
 *  - old bills: "OLD PURCHASES (KAARBAR)" — the receipts as Kaarbar shows
 *    them (replaces Batch 50's list), and "Undo this merge".
 * History only: not counted in the orders, total spent or due.
 */
export function MergeOldSection({ customerKey, name, phone }: { customerKey: string; name: string; phone: string }) {
  const { isAdmin } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [bills, setBills] = useState<OldPurchase[] | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [undoing, setUndoing] = useState(false);

  const load = useCallback(async () => {
    setBills(await fetchOldPurchases(customerKey, phone));
  }, [customerKey, phone]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickFile = () => fileRef.current?.click();

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileError(null);
    setReading(true);
    try {
      const result = readStatement(await readPdfText(file));
      if (!result.statement) {
        setFileError(result.error ?? 'This PDF could not be read.');
        return;
      }
      const status = await fetchOldSalesStatus();
      if (!status.ok) {
        setFileError(status.error);
        return;
      }
      setMergeDraft(customerKey, buildDraft(file.name, result.statement, status.data.cutoff || OLD_SALES_CUTOFF));
      navigate(adminPath.mergeOld(customerKey), { state: { fromList: true } });
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'This PDF could not be read.');
    } finally {
      setReading(false);
    }
  };

  if (bills === null) return null;

  if (bills.length === 0) {
    if (!isAdmin) return null;
    return (
      <section className="km-section" aria-label="Merge old data">
        <h3 className="km-title">MERGE OLD DATA</h3>
        <div className="km-card" data-testid="merge-old-card">
          <div className="km-card__head">Bring in this customer&apos;s Kaarbar history</div>
          <p className="km-card__text">
            Upload the party statement PDF from Kaarbar. Bills up to {dayText(OLD_SALES_CUTOFF)} are shown here first. Nothing is saved until you press Merge.
          </p>
          <button type="button" className="km-btn km-btn--dark" onClick={pickFile} disabled={reading} data-testid="merge-old-upload">
            {reading ? <span className="spinner" aria-hidden="true" /> : <AdminIcon name="upload" />} Upload Kaarbar PDF
          </button>
          <input ref={fileRef} className="km-file" type="file" accept="application/pdf,.pdf" onChange={(e) => void onFile(e)} data-testid="merge-old-file" />
          {fileError && (
            <p className="km-check km-check--bad" role="alert" data-testid="merge-old-error">
              {fileError}
            </p>
          )}
        </div>
      </section>
    );
  }

  const total = bills.reduce((s, b) => s + (b.kind === 'return' ? -b.bill_total : b.bill_total), 0);
  const merged = bills.filter((b) => b.from_merge);
  const lastAt = bills.map((b) => b.merged_at).filter((d): d is string => d !== null).sort().pop() ?? null;
  const shown = showAll ? bills : bills.slice(0, FIRST);
  const rest = bills.length - shown.length;

  const undo = async (): Promise<string | null> => {
    const answer = await undoCustomerMerge(customerKey);
    if (!answer.ok) return answer.error;
    setUndoing(false);
    const kept = answer.data.kept;
    showToast(
      kept.length > 0
        ? `Removed ${answer.data.removed} receipts. Kept ${kept.length} in locked months: ${kept.map((k) => k.bill_no).join(', ')}`
        : `Removed ${answer.data.removed} receipts`
    );
    await load();
    return null;
  };

  return (
    <section className="km-section" aria-label="Old purchases (Kaarbar)" data-testid="customer-old-purchases">
      <h3 className="km-title">OLD PURCHASES (KAARBAR)</h3>
      <div className="km-card km-row" data-testid="merge-summary">
        <div>
          <div className="km-card__head">
            {bills.length} receipt{bills.length === 1 ? '' : 's'} · {moneyText(total)}
          </div>
          {lastAt && <div className="km-receipt__muted">Merged {dayText(dhakaToday(new Date(lastAt)))}</div>}
        </div>
        <span className="km-chip km-chip--ok">
          <AdminIcon name="check" className="km-icon" />
          Merged
        </span>
      </div>
      {shown.map((b) => (
        <ReceiptCard
          key={b.id}
          kind={b.kind}
          billNo={b.bill_no}
          date={b.date}
          total={b.bill_total}
          note={b.note}
          paid={b.kind === 'sale' && b.paid_amount !== null && b.due_amount !== null ? { paid: b.paid_amount, due: b.due_amount } : null}
          onOpen={() => navigate(adminPath.oldReceipt(customerKey, b.id), { state: { fromList: true } })}
        />
      ))}
      {rest > 0 && (
        <button type="button" className="km-link km-link--small" onClick={() => setShowAll(true)} data-testid="merge-more">
          + {rest} more
        </button>
      )}
      {isAdmin && merged.length > 0 && (
        <button type="button" className="km-card km-row" onClick={() => setUndoing(true)} data-testid="merge-undo">
          <span className="km-danger-row">Undo this merge</span>
          <AdminIcon name="chevron-right" />
        </button>
      )}
      <p className="admin-panel__description">From Kaarbar, before the site. Not counted in the orders, total spent or due above.</p>
      <PasswordSheet
        isOpen={undoing}
        title="Undo this merge?"
        text={`Removes these ${merged.length} receipts from ${name || 'this customer'}'s old purchases. Products and buying prices stay.`}
        confirmLabel="Undo"
        danger
        onConfirm={undo}
        onClose={() => setUndoing(false)}
      />
    </section>
  );
}
