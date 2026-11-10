import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useToast } from '../../../hooks/useToast';
import { dhakaToday } from '../../../lib/inventory/api';
import type { LoadState } from '../../../lib/payouts';
import {
  billPhotoUrl,
  deleteEntry,
  fetchAccounts,
  fetchCategories,
  fetchMovement,
  fetchParties,
  fetchSuppliers,
  fetchTransferPair,
  updateEntry,
} from '../../../lib/money/api';
import { dayText, moneyText, parseAmount, signedMoney, typeLabel } from '../../../lib/money/format';
import type { MoneyAccount, MoneyCategory, MoneyMovement, Party, SupplierRef } from '../../../lib/money/types';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { CarefulActionsCard, ConfirmSheet } from '../OrderActionCards';

/** Kinds changed in their own place (not here). */
const NOT_EDITABLE_HERE: readonly MoneyMovement['type'][] = ['opening_balance', 'steadfast_payout_in', 'lot_payment'];

const WHERE_CHANGED: Partial<Record<MoneyMovement['type'], string>> = {
  opening_balance: 'Opening balances change only by undoing the opening (Money → Opening balances).',
  steadfast_payout_in: 'Change the account of a payout with the list "Steadfast payouts to place" — or delete it here and place it again.',
  lot_payment: 'Change a lot payment on the lot (Inventory → the lot → Paid for this lot).',
};

/**
 * Batch 41: one money entry — what it is, change it (written to the
 * Activity Log with before and after), or delete it (Careful actions: type
 * the amount). A move between accounts shows and changes both sides.
 */
export function EntryView({ entryId, onBack }: { entryId: string; onBack: () => void }) {
  const { showToast } = useToast();
  const [state, setState] = useState<LoadState<MoneyMovement | null> | null>(null);
  const [pair, setPair] = useState<MoneyMovement[]>([]);
  const [accounts, setAccounts] = useState<MoneyAccount[]>([]);
  const [categories, setCategories] = useState<MoneyCategory[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRef[]>([]);
  const [bill, setBill] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [payee, setPayee] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, acc, cats, people, sups] = await Promise.all([fetchMovement(entryId), fetchAccounts(), fetchCategories(), fetchParties(), fetchSuppliers()]);
    setState(m);
    setAccounts(acc.kind === 'ready' ? acc.data : []);
    setCategories(cats.kind === 'ready' ? cats.data : []);
    setParties(people.kind === 'ready' ? people.data : []);
    setSuppliers(sups);
    const row = m.kind === 'ready' ? m.data : null;
    setPair(row?.transfer_id ? await fetchTransferPair(row.transfer_id) : []);
    setBill(row?.bill_path ? await billPhotoUrl(row.bill_path) : null);
  }, [entryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const row = state?.kind === 'ready' ? state.data : null;
  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? '—';
  const other = pair.find((p) => p.id !== row?.id) ?? null;

  const startEdit = () => {
    if (!row) return;
    setAmount(String(row.type === 'adjustment' ? row.amount : Math.abs(row.amount)));
    setAccountId(row.account_id);
    setToAccountId(other?.account_id ?? '');
    setDate(row.entry_date);
    setNote(row.note ?? '');
    setCategoryId(row.category_id ?? '');
    setPartyId(row.party_id ?? '');
    setPayee(row.supplier_id ? `supplier:${row.supplier_id}` : row.party_id ? `party:${row.party_id}` : '');
    setError(null);
    setEditing(true);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!row) return;
    const value = parseAmount(amount);
    if (value === null || value === 0 || (row.type !== 'adjustment' && value < 0)) {
      setError('Type an amount above 0.');
      return;
    }
    const [payeeKind, payeeId] = payee.split(':');
    setSaving(true);
    const answer = await updateEntry(row.id, {
      amount: value,
      accountId,
      date,
      note,
      categoryId: row.type === 'expense' ? categoryId : null,
      partyId: row.type === 'supplier_payment' ? (payeeKind === 'party' ? payeeId : null) : partyId || null,
      supplierId: row.type === 'supplier_payment' && payeeKind === 'supplier' ? payeeId : null,
      toAccountId: other ? toAccountId : null,
    });
    setSaving(false);
    if (!answer.ok) {
      setError(answer.error ?? 'Could not save.');
      return;
    }
    showToast('Saved — the change is in the Activity Log');
    setEditing(false);
    await load();
  };

  const remove = async () => {
    if (!row) return;
    const answer = await deleteEntry(row.id, Math.round(Math.abs(row.amount)));
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not delete', 'error');
      return;
    }
    setDeleteOpen(false);
    showToast('Entry deleted — written to the Activity Log');
    onBack();
  };

  if (state === null) {
    return (
      <section className="inv money" aria-label="Money entry">
        <AdminPageHeader title="Money entry" onBack={onBack} />
        <SkeletonRows rows={4} thumb={false} />
      </section>
    );
  }
  if (!row) {
    return (
      <section className="inv money" aria-label="Money entry">
        <AdminPageHeader title="Money entry" onBack={onBack} />
        <EmptyState icon="alert" title="This entry was not found" hint={state.kind === 'error' ? state.message : 'It may have been deleted.'} />
      </section>
    );
  }

  const editable = !NOT_EDITABLE_HERE.includes(row.type);
  const deletable = row.type !== 'opening_balance';
  const isInvestor = row.type === 'investor_in' || row.type === 'investor_profit_share' || row.type === 'investor_capital_back';
  const usable = accounts.filter((a) => a.kind !== 'steadfast' && (!a.archived || a.id === row.account_id));
  const whole = Math.round(Math.abs(row.amount));

  return (
    <section className="inv money" aria-label="Money entry">
      <AdminPageHeader
        title={typeLabel(row.type)}
        onBack={onBack}
        menu={editable ? [{ label: 'Change', onSelect: startEdit }] : undefined}
      />
      <div className="adm-ocard inv-stack" data-testid="money-entry">
        <div className="inv-line inv-line--total">
          <span>Amount</span>
          <b className={row.amount < 0 ? 'money-out' : 'money-in'}>{signedMoney(row.amount, true)}</b>
        </div>
        <div className="inv-line">
          <span>{row.amount < 0 ? 'From' : 'Into'}</span>
          <span>{accountName(row.account_id)}</span>
        </div>
        {other && (
          <div className="inv-line">
            <span>{other.amount < 0 ? 'From' : 'Into'}</span>
            <span>{accountName(other.account_id)}</span>
          </div>
        )}
        <div className="inv-line">
          <span>Date</span>
          <span>{dayText(row.entry_date)}</span>
        </div>
        {row.category_id && (
          <div className="inv-line">
            <span>Category</span>
            <span>{categories.find((c) => c.id === row.category_id)?.name ?? '—'}</span>
          </div>
        )}
        {row.party_id && (
          <div className="inv-line">
            <span>{isInvestor ? 'Investor' : 'Paid to'}</span>
            <span>{parties.find((p) => p.id === row.party_id)?.name ?? '—'}</span>
          </div>
        )}
        {row.supplier_id && (
          <div className="inv-line">
            <span>Supplier</span>
            <span>{suppliers.find((s) => s.id === row.supplier_id)?.name ?? '—'}</span>
          </div>
        )}
        {row.reference && (
          <div className="inv-line">
            <span>Reference</span>
            <span>{row.reference}</span>
          </div>
        )}
        {row.note && <p className="inv-muted">{row.note}</p>}
        <p className="inv-muted">
          Added by {row.created_by_username ?? '—'}
          {row.updated_by_username ? ` · changed by ${row.updated_by_username}` : ''}
        </p>
        {bill && <img src={bill} alt="Bill photo" className="money-bill" loading="lazy" />}
        {WHERE_CHANGED[row.type] && <p className="inv-muted">{WHERE_CHANGED[row.type]}</p>}
        {editable && !editing && (
          <button type="button" className="adm-btn" onClick={startEdit} data-testid="money-entry-edit">
            Change
          </button>
        )}
      </div>

      {editing && (
        <form className="adm-ocard inv-stack" onSubmit={save} noValidate data-testid="money-entry-form">
          <label className="form-field">
            <span className="form-label">{row.type === 'adjustment' ? 'Amount (− for less money)' : 'Amount (৳)'}</span>
            <input className="form-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" />
          </label>
          <label className="form-field">
            <span className="form-label">{other ? 'This side' : 'Account'}</span>
            <select className="form-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Account">
              {usable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {other && (
            <label className="form-field">
              <span className="form-label">Other side</span>
              <select className="form-input" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)} aria-label="Other account">
                {usable.filter((a) => a.id !== accountId).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {row.type === 'expense' && (
            <label className="form-field">
              <span className="form-label">Category</span>
              <select className="form-input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category">
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {isInvestor && (
            <label className="form-field">
              <span className="form-label">Investor</span>
              <select className="form-input" value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Investor">
                {parties.filter((p) => p.kind === 'investor').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {row.type === 'supplier_payment' && (
            <label className="form-field">
              <span className="form-label">Paid to</span>
              <select className="form-input" value={payee} onChange={(e) => setPayee(e.target.value)} aria-label="Paid to">
                {suppliers.map((s) => (
                  <option key={s.id} value={`supplier:${s.id}`}>
                    {s.name}
                  </option>
                ))}
                {parties.filter((p) => p.kind === 'other').map((p) => (
                  <option key={p.id} value={`party:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="inv-fields">
            <label className="form-field">
              <span className="form-label">Date</span>
              <input className="form-input" type="date" value={date} max={dhakaToday()} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
            </label>
            <label className="form-field">
              <span className="form-label">Note</span>
              <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
            </label>
          </div>
          {error && (
            <p className="inv-error" role="alert">
              {error}
            </p>
          )}
          <div className="inv-actions">
            <button type="button" className="adm-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="adm-btn adm-btn--primary" disabled={saving} data-testid="money-entry-save">
              {saving ? <span className="spinner" aria-hidden="true" /> : 'Save change'}
            </button>
          </div>
        </form>
      )}

      {deletable && (
        <CarefulActionsCard
          actions={[
            {
              key: 'delete-money',
              title: 'Delete this entry',
              explain: other ? 'Both sides of the move are deleted. Written to the Activity Log.' : 'Written to the Activity Log.',
              button: 'Delete…',
              onOpen: () => setDeleteOpen(true),
            },
          ]}
        />
      )}
      <ConfirmSheet
        isOpen={deleteOpen}
        title={`Delete ${typeLabel(row.type).toLowerCase()} of ${moneyText(Math.abs(row.amount))}?`}
        typeToConfirm={String(whole)}
        keepLabel="Keep"
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onClose={() => setDeleteOpen(false)}
      >
        <p className="adm-csheet__text">The account balance and the Money page change at once. This can&apos;t be undone.</p>
      </ConfirmSheet>
    </section>
  );
}
