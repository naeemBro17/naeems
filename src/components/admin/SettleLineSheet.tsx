import { useEffect, useState } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { SETTLE_REASONS, settlePayoutLine, takaExact, takaWhole, type PayoutItem, type SettleReason } from '../../lib/payouts';
import { toPaisa } from '../../../supabase/functions/_shared/steadfastPayouts';

interface SettleLineSheetProps {
  item: PayoutItem | null;
  onClose: () => void;
  onSettled: () => Promise<void> | void;
}

/**
 * Batch 47 Task 12: settle a payout line that does not match, from the
 * payout screen — the same thing Batch 46's SQL did for NM-3315 and
 * NM-1721. No amount changes, so the payout still adds up. The database
 * decides how the money is booked and refuses a reason that does not fit
 * (e.g. "Returned" when Steadfast collected money).
 */
export function SettleLineSheet({ item, onClose, onSettled }: SettleLineSheetProps) {
  const [reason, setReason] = useState<SettleReason | null>(null);
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason(null);
    setNote('');
    setError(null);
  }, [item]);

  const label = item ? item.invoice ?? (item.consignment_id ? `Parcel ${item.consignment_id}` : 'this line') : '';
  const linked = item?.order_id !== null && item?.order_id !== undefined;
  // A line still linked to its order is booked through that order.
  const choices = SETTLE_REASONS.filter((r) => !linked || (r.id !== 'not_shop_sale' && r.id !== 'order_deleted'));
  const needsNote = reason === 'other' && note.trim() === '';

  const save = async () => {
    if (!item || !reason || needsNote || working) return;
    setWorking(true);
    setError(null);
    const result = await settlePayoutLine(item.id, reason, note);
    setWorking(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    await onSettled();
  };

  return (
    <BottomSheet isOpen={item !== null} onClose={onClose} title={`Settle ${label}`} panelClassName="adm-csheet">
      {item && (
        <div className="adm-csheet__body" data-testid="settle-sheet">
          <p className="adm-ocard__muted">
            COD {takaWhole(toPaisa(item.cod_collected))} · you got <span title={takaExact(toPaisa(item.net_paid))}>{takaWhole(toPaisa(item.net_paid))}</span>.
            Settling changes no amount — the payout still adds up.
          </p>
          <ul className="adm-settle__list" role="radiogroup" aria-label="Reason">
            {choices.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={reason === r.id}
                  className={`adm-settle__row${reason === r.id ? ' adm-settle__row--on' : ''}`}
                  onClick={() => setReason(r.id)}
                  data-testid="settle-reason"
                >
                  <span className="adm-settle__name">{r.label}</span>
                  <span className="adm-settle__hint">{r.hint}</span>
                </button>
              </li>
            ))}
          </ul>
          <label className="form-label" htmlFor="settle-note">
            Note{reason === 'other' ? '' : ' (optional)'}
          </label>
          <input
            id="settle-note"
            className="form-input"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder={reason === 'other' ? 'What was this parcel?' : 'Anything to remember'}
            data-testid="settle-note"
          />
          {error && (
            <p className="form-error" role="alert" data-testid="settle-error">
              {error}
            </p>
          )}
          <div className="adm-csheet__actions">
            <button type="button" className="adm-btn" onClick={onClose} disabled={working}>
              Cancel
            </button>
            <button
              type="button"
              className="adm-btn adm-btn--primary"
              onClick={() => void save()}
              disabled={reason === null || needsNote || working}
              data-testid="settle-confirm"
            >
              {working ? <span className="spinner" aria-hidden="true" /> : 'Settle line'}
            </button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
