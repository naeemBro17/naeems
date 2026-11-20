import { useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { amountToMatchKaarbar } from '../../../lib/kaarbar/merge';
import { correctionView } from '../../../lib/kaarbar/oldSales';
import { correctPreviousBalance } from '../../../lib/money/api';
import { moneyText } from '../../../lib/money/format';
import { confirmPassword } from '../../../lib/reports/api';
import { ConfirmSheet } from '../OrderActionCards';
import '../../../styles/kaarbarMerge.css';

/**
 * Batch 50's "Correct previous balance" sheet (customer page → TO RECEIVE
 * → Edit), as its own piece so Batch 54's Merge old data page opens the
 * very same sheet. From there it also shows what Kaarbar says, with
 * "Use this" (the previous balance that makes the Total due equal to it).
 */
export function CorrectBalanceSheet({
  isOpen,
  phone,
  previous,
  sitesDue,
  kaarbarDue = null,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  phone: string;
  /** The previous balance now. */
  previous: number;
  /** The site orders' due. */
  sitesDue: number;
  /** Batch 54: Kaarbar's due on the statement (only from Merge old data). */
  kaarbarDue?: number | null;
  onClose: () => void;
  onSaved: (value: number) => void | Promise<void>;
}) {
  const { session } = useAuth();
  const [newAmount, setNewAmount] = useState('');
  const [why, setWhy] = useState('');
  const [password, setPassword] = useState('');
  const [correctError, setCorrectError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setNewAmount('');
    setWhy('');
    setPassword('');
    setCorrectError(null);
  }, [isOpen]);

  const correction = correctionView(previous, newAmount, sitesDue);
  const useAmount = kaarbarDue === null ? null : amountToMatchKaarbar(kaarbarDue, sitesDue);

  const saveCorrection = async () => {
    setCorrectError(null);
    if (correction.value === null) {
      setCorrectError(correction.error ?? 'Type the correct amount.');
      return;
    }
    const wrong = await confirmPassword(session?.user.email, password);
    if (wrong) {
      setCorrectError(wrong);
      return;
    }
    const answer = await correctPreviousBalance(phone, correction.value, why);
    if (!answer.ok) {
      setCorrectError(answer.error ?? 'Could not save');
      return;
    }
    await onSaved(correction.value);
  };

  return (
    <ConfirmSheet isOpen={isOpen} title="Correct previous balance" keepLabel="Cancel" confirmLabel="Save" onConfirm={saveCorrection} onClose={onClose}>
      {kaarbarDue !== null && (
        <div className="km-hint-row" data-testid="correct-kaarbar">
          <span>
            Kaarbar says <b>{moneyText(kaarbarDue)}</b>
          </span>
          {useAmount !== null && (
            <button type="button" className="km-link km-link--small" onClick={() => setNewAmount(String(useAmount))} data-testid="correct-use-kaarbar">
              Use this
            </button>
          )}
        </div>
      )}
      <p className="adm-csheet__text">
        For a balance that was wrong when it was brought in. Money received is not this — use &quot;Record a payment&quot; for that.
      </p>
      <p className="money-correct__now">
        <span>Now</span>
        <b data-testid="correct-now">{moneyText(previous)}</b>
      </p>
      <label className="form-field">
        <span className="form-label">Correct amount</span>
        <input
          className="form-input"
          inputMode="decimal"
          value={newAmount}
          onChange={(e) => setNewAmount(e.target.value)}
          placeholder="৳"
          aria-label="Correct amount"
          data-testid="correct-amount"
        />
      </label>
      <label className="form-field">
        <span className="form-label">Why (optional)</span>
        <input className="form-input" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={300} aria-label="Why" data-testid="correct-why" />
      </label>
      <label className="adm-csheet__type">
        <span>Type your password to confirm</span>
        <input
          className="form-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="correct-password"
        />
      </label>
      <p className="money-correct__after" data-testid="correct-after">
        Total due becomes {moneyText(correction.totalDue)}. Cash and bKash do not change.
      </p>
      {(correctError ?? (newAmount.trim() !== '' ? correction.error : null)) && (
        <p className="inv-error" role="alert" data-testid="correct-error">
          {correctError ?? correction.error}
        </p>
      )}
    </ConfirmSheet>
  );
}
