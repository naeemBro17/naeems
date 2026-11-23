import { useEffect, useState, type FormEvent } from 'react';
import { BottomSheet } from '../../shared/BottomSheet';
import { useToast } from '../../../hooks/useToast';
import { dhakaToday } from '../../../lib/inventory/api';
import { recordCourierBill } from '../../../lib/money/api';
import { moneyText } from '../../../lib/money/format';
import { usePayAccounts } from './LotPayments';

/**
 * Batch 58: a Steadfast delivery bill paid outside a payout (by bKash, for
 * example) counts as courier cost, but no account went down for it. This
 * sheet records the payment: a money movement out of the chosen account.
 * Deleting that movement (Money → the entry) makes the bill owed again.
 */
export function CourierBillSheet({
  isOpen,
  orderId,
  amount,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  orderId: string;
  /** The bill still owed (read-only). */
  amount: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { showToast } = useToast();
  const accounts = usePayAccounts();
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(dhakaToday());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  useEffect(() => {
    if (isOpen) setDate(dhakaToday());
  }, [isOpen]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!accountId) {
      showToast('Pick an account', 'error');
      return;
    }
    setSaving(true);
    const answer = await recordCourierBill({ orderId, accountId, date });
    setSaving(false);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not save', 'error');
      return;
    }
    showToast('Bill payment recorded');
    onSaved();
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Steadfast bill paid outside the payout">
      <form className="form order-pay__form" onSubmit={save} data-testid="order-bill-sheet">
        <div className="form-field">
          <label className="form-label" htmlFor="bill-amount">
            Amount
          </label>
          <input id="bill-amount" type="text" className="form-input" value={moneyText(amount)} readOnly data-testid="order-bill-amount" />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="bill-account">
            Paid from
          </label>
          <select id="bill-account" className="form-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} data-testid="order-bill-account">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="bill-date">
            Date
          </label>
          <input id="bill-date" type="date" className="form-input" value={date} max={dhakaToday()} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="edit-sheet__footer">
          <button type="button" className="edit-sheet__cancel" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="edit-sheet__save" disabled={saving || !accountId} data-testid="order-bill-save">
            {saving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
