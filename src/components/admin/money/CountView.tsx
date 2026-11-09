import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { dhakaToday } from '../../../lib/inventory/api';
import { addEntry, fetchBalances } from '../../../lib/money/api';
import { moneyText, parseAmount, signedMoney } from '../../../lib/money/format';
import type { AccountBalance } from '../../../lib/money/types';
import { AdminPageHeader, SkeletonRows } from '../ui/AdminUi';

/**
 * Batch 41 Part 7.5: end-of-day count (never required). Type what you
 * counted in Cash or bKash; the difference to the books shows, and "Record
 * difference" saves it as a count difference with a note.
 */
export function CountView({ onBack }: { onBack: () => void }) {
  const { showToast } = useToast();
  const [balances, setBalances] = useState<AccountBalance[] | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    const answer = await fetchBalances();
    setBalances(answer.kind === 'ready' ? answer.data.filter((a) => a.kind !== 'steadfast' && !a.archived) : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const record = async (a: AccountBalance, difference: number) => {
    setWorking(a.account_id);
    const answer = await addEntry({
      kind: 'adjustment',
      amount: difference,
      accountId: a.account_id,
      date: dhakaToday(),
      note: (notes[a.account_id] ?? '').trim() || `Counted ${moneyText(parseAmount(counted[a.account_id] ?? '') ?? 0)} at the end of the day`,
    });
    setWorking(null);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not save', 'error');
      return;
    }
    showToast(`${a.name}: difference ${signedMoney(difference, true)} recorded`);
    setCounted((prev) => ({ ...prev, [a.account_id]: '' }));
    setNotes((prev) => ({ ...prev, [a.account_id]: '' }));
    await load();
  };

  return (
    <section className="inv money" aria-label="End-of-day count">
      <AdminPageHeader title="End-of-day count" onBack={onBack} />
      <p className="inv-muted">Optional. Count the money, type it, and see if the books agree.</p>
      {balances === null ? (
        <SkeletonRows rows={3} thumb={false} />
      ) : (
        balances.map((a) => {
          const typed = parseAmount(counted[a.account_id] ?? '');
          const difference = typed === null ? null : Math.round((typed - a.balance) * 100) / 100;
          return (
            <div key={a.account_id} className="adm-ocard inv-stack" data-testid="money-count">
              <div className="inv-line">
                <span>{a.name} in the books</span>
                <b>{moneyText(a.balance)}</b>
              </div>
              <label className="form-field">
                <span className="form-label">Counted</span>
                <input
                  className="form-input"
                  inputMode="decimal"
                  value={counted[a.account_id] ?? ''}
                  onChange={(e) => setCounted((prev) => ({ ...prev, [a.account_id]: e.target.value }))}
                  aria-label={`Counted ${a.name}`}
                />
              </label>
              {difference !== null && (
                <>
                  <p className={difference === 0 ? 'inv-ok' : 'inv-bad'} data-testid="money-count-difference">
                    {difference === 0 ? 'Same as the books' : `Difference ${signedMoney(difference, true)}`}
                  </p>
                  {difference !== 0 && (
                    <>
                      <input
                        className="form-input"
                        value={notes[a.account_id] ?? ''}
                        onChange={(e) => setNotes((prev) => ({ ...prev, [a.account_id]: e.target.value }))}
                        placeholder="Note (why, if you know)"
                        aria-label={`Note for ${a.name}`}
                      />
                      <button type="button" className="adm-btn" onClick={() => void record(a, difference)} disabled={working === a.account_id}>
                        {working === a.account_id ? <span className="spinner" aria-hidden="true" /> : 'Record difference'}
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
