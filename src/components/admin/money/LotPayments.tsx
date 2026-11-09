import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { dhakaToday } from '../../../lib/inventory/api';
import { fetchAccounts, fetchLotPayments, saveLotPayments } from '../../../lib/money/api';
import { dayText, moneyText, parseAmount } from '../../../lib/money/format';
import type { LotPayments, MoneyAccount } from '../../../lib/money/types';

export interface PayDraft {
  key: number;
  accountId: string;
  amount: string;
  date: string;
}

let draftKey = 0;

export function newPayDraft(accountId: string, date: string): PayDraft {
  draftKey += 1;
  return { key: draftKey, accountId, amount: '', date };
}

/** The rows ready for the database; an error when one is not filled right. */
export function payRowsFrom(drafts: readonly PayDraft[]): { rows: { account_id: string; amount: number; date: string }[]; error: string | null } {
  const rows: { account_id: string; amount: number; date: string }[] = [];
  for (const d of drafts) {
    if (d.amount.trim() === '') continue;
    const amount = parseAmount(d.amount);
    if (amount === null || amount <= 0) return { rows: [], error: 'Each "Paid for this lot" row needs an amount above 0.' };
    if (!d.accountId) return { rows: [], error: 'Pick the account for each payment.' };
    rows.push({ account_id: d.accountId, amount, date: d.date });
  }
  return { rows, error: null };
}

/** The account list for the payment rows (no "With Steadfast"). */
export function usePayAccounts(): MoneyAccount[] {
  const [accounts, setAccounts] = useState<MoneyAccount[]>([]);
  useEffect(() => {
    void fetchAccounts().then((a) => setAccounts(a.kind === 'ready' ? a.data.filter((x) => x.kind !== 'steadfast' && !x.archived) : []));
  }, []);
  return accounts;
}

/**
 * Batch 41 Part 3.3: "Paid for this lot" — one or more rows of account +
 * amount + date. The unpaid rest (landed total − paid) is owed to the lot's
 * supplier; paying it later is a supplier payment (Add money → Pay what I
 * owe).
 */
export function LotPaymentRows({
  drafts,
  accounts,
  onChange,
  landed,
}: {
  drafts: PayDraft[];
  accounts: MoneyAccount[];
  onChange: (next: PayDraft[]) => void;
  /** The lot's landed total, when known (shows what is still owed). */
  landed: number | null;
}) {
  const paid = drafts.reduce((s, d) => s + (parseAmount(d.amount) ?? 0), 0);
  const set = (key: number, patch: Partial<PayDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  return (
    <div className="inv-stack" data-testid="lot-pay-rows">
      {drafts.map((d) => (
        <div key={d.key} className="money-payrow">
          <select className="form-input" value={d.accountId} onChange={(e) => set(d.key, { accountId: e.target.value })} aria-label="Paid from account">
            <option value="">Account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input className="form-input" inputMode="decimal" value={d.amount} onChange={(e) => set(d.key, { amount: e.target.value })} placeholder="৳" aria-label="Amount paid" />
          <input className="form-input" type="date" value={d.date} max={dhakaToday()} onChange={(e) => set(d.key, { date: e.target.value })} aria-label="Date paid" />
          <button type="button" className="adm-btn adm-btn--ghost" onClick={() => onChange(drafts.filter((x) => x.key !== d.key))} aria-label="Remove this payment">
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="adm-btn adm-btn--ghost"
        onClick={() => onChange([...drafts, newPayDraft(accounts.find((a) => a.kind === 'bank')?.id ?? accounts[0]?.id ?? '', dhakaToday())])}
        data-testid="lot-pay-add"
      >
        + Add a payment
      </button>
      {landed !== null && (
        <p className="inv-muted" data-testid="lot-pay-owed">
          Paid {moneyText(paid)} of {moneyText(landed)} — {landed - paid > 0.004 ? `${moneyText(landed - paid)} owed to the supplier` : 'fully paid'}
        </p>
      )}
    </div>
  );
}

/** The lot page: what was paid, what is still owed, and changing it. */
export function LotPaymentsCard({ lotId, isOpening }: { lotId: string; isOpening: boolean }) {
  const { showToast } = useToast();
  const accounts = usePayAccounts();
  const [data, setData] = useState<LotPayments | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<PayDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const answer = await fetchLotPayments(lotId);
    if (answer.kind === 'ready') setData(answer.data);
    else setFailed(true);
  }, [lotId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed || !data) return null;

  if (isOpening) {
    return (
      <div className="adm-ocard inv-stack" data-testid="lot-payments">
        <h2 className="adm-ocard__title">Paid for this lot</h2>
        <p className="inv-muted">The opening stock was paid before the start date — nothing is owed for it.</p>
      </div>
    );
  }

  const start = () => {
    setDrafts(
      data.rows.length > 0
        ? data.rows.map((r) => ({ ...newPayDraft(r.account_id, r.date), amount: String(r.amount) }))
        : [newPayDraft(accounts.find((a) => a.kind === 'bank')?.id ?? accounts[0]?.id ?? '', dhakaToday())]
    );
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const { rows, error: rowError } = payRowsFrom(drafts);
    if (rowError) {
      setError(rowError);
      return;
    }
    setSaving(true);
    const answer = await saveLotPayments(lotId, rows);
    setSaving(false);
    if (!answer.ok || !answer.data) {
      setError(answer.error ?? 'Could not save.');
      return;
    }
    setData(answer.data);
    setEditing(false);
    showToast('Payments saved');
  };

  return (
    <div className="adm-ocard inv-stack" data-testid="lot-payments">
      <h2 className="adm-ocard__title">Paid for this lot</h2>
      {!editing && (
        <>
          {data.rows.length === 0 ? (
            <p className="inv-muted">No payments recorded for this lot.</p>
          ) : (
            data.rows.map((r) => (
              <div key={r.id} className="inv-line">
                <span>
                  {r.account} · {dayText(r.date)}
                </span>
                <span>{moneyText(r.amount)}</span>
              </div>
            ))
          )}
          <div className="inv-line inv-line--total">
            <span>Still owed to the supplier</span>
            <b data-testid="lot-owed">{moneyText(data.owed)}</b>
          </div>
          {data.rows.length === 0 && data.owed === 0 && (
            <p className="inv-muted">A lot from before your start date with no payments counts as paid before the start date.</p>
          )}
          <button type="button" className="adm-btn" onClick={start} data-testid="lot-pay-change">
            {data.rows.length === 0 ? 'Add payments' : 'Change payments'}
          </button>
        </>
      )}
      {editing && (
        <>
          <LotPaymentRows drafts={drafts} accounts={accounts} onChange={setDrafts} landed={data.landed} />
          {error && (
            <p className="inv-error" role="alert">
              {error}
            </p>
          )}
          <div className="inv-actions">
            <button type="button" className="adm-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="adm-btn" onClick={() => void save()} disabled={saving} data-testid="lot-pay-save">
              {saving ? <span className="spinner" aria-hidden="true" /> : 'Save payments'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
