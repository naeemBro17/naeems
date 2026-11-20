import { paidChip, type PaidDue, type ReceiptStatus } from '../../../../lib/kaarbar/merge';
import { dayText, moneyText } from '../../../../lib/money/format';
import { AdminIcon } from '../../ui/AdminIcon';
import '../../../../styles/kaarbarMerge.css';

/**
 * Batch 54: one old receipt as the Kaarbar app shows it — bill number and
 * amount; the Remarks line (else the date) with Paid / Part paid / Unpaid;
 * the date (when Remarks took its place) with "Bal". The review page adds
 * a status line under it. Bills with no paid / due stored (the bulk
 * Step 2) show no chip and no Bal.
 */
export function ReceiptCard({
  kind,
  billNo,
  date,
  total,
  note,
  paid,
  status,
  onOpen,
}: {
  kind: 'sale' | 'return';
  billNo: string;
  date: string;
  total: number;
  note: string | null;
  paid: PaidDue | null;
  status?: ReceiptStatus;
  onOpen: () => void;
}) {
  const chip = paid ? paidChip(paid) : null;
  const dateText = dayText(date);
  const hasNote = note !== null && note.trim() !== '';
  return (
    <button type="button" className={`km-receipt${status?.flag ? ' km-receipt--flag' : ''}`} onClick={onOpen} data-testid="merge-receipt" data-bill={billNo}>
      <div className="km-row">
        <span className="km-receipt__no">
          {kind === 'return' ? 'Return' : 'Sale'} #{billNo}
        </span>
        <span className="km-receipt__amount">{kind === 'return' ? `−${moneyText(total)}` : moneyText(total)}</span>
      </div>
      <div className="km-row">
        <span className="km-receipt__muted">{hasNote ? note : dateText}</span>
        {chip && (
          <span className={`km-chip km-chip--${chip.tone}`} data-testid="merge-paid-chip">
            {chip.text}
          </span>
        )}
      </div>
      {(hasNote || paid) && (
        <div className="km-row">
          <span className="km-receipt__muted">{hasNote ? dateText : ''}</span>
          {paid && <span className="km-bal">Bal: {moneyText(paid.due)}</span>}
        </div>
      )}
      {status && (
        <div className={`km-status km-status--${status.tone}`} data-testid="merge-receipt-status">
          {status.ready && <AdminIcon name="check" className="km-icon" />}
          {status.text}
        </div>
      )}
    </button>
  );
}
