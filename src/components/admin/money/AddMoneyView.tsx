import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../hooks/useToast';
import { dhakaToday } from '../../../lib/inventory/api';
import { addEntry, fetchAccounts, fetchCategories, fetchParties, fetchSuppliers, saveParty } from '../../../lib/money/api';
import { uploadBillPhoto } from '../../../lib/money/bills';
import { KIND_GROUPS, kindIsIn, moneyText, parseAmount, type KindGroup } from '../../../lib/money/format';
import type { EntryKind, MoneyAccount, MoneyCategory, Party, SupplierRef } from '../../../lib/money/types';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';

/* Per-phone conveniences only (the last account and category used); the
   form works the same without them. */
function remembered(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private window or storage blocked: nothing to remember.
  }
}

const LAST_ACCOUNT = 'money.lastAccount';
const LAST_CATEGORY = 'money.lastCategory';

/**
 * Batch 41 Part 1.5: "Add money" — one form, the kind picked at the top
 * with big plain buttons: Expense · Move money · Investor · Me · Not shop
 * money · Pay what I owe. Amount, account, date (today), note. Saving keeps
 * the kind and account, so the next entry is quick.
 * With only "Add money entries" a staff member sees Expense and Move money.
 */
export function AddMoneyView({ onBack, startKind }: { onBack?: () => void; startKind?: EntryKind | null }) {
  const { can } = useAuth();
  const { showToast } = useToast();
  const canView = can('view_profit_costs');
  const groups = useMemo(() => KIND_GROUPS.filter((g) => canView || !g.profitOnly), [canView]);
  const [accounts, setAccounts] = useState<MoneyAccount[] | null>(null);
  const [categories, setCategories] = useState<MoneyCategory[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRef[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const initialGroup = groups.find((g) => g.choices.some((c) => c.kind === startKind)) ?? groups[0];
  const [group, setGroup] = useState<KindGroup>(initialGroup);
  const [kind, setKind] = useState<EntryKind>(startKind && initialGroup.choices.some((c) => c.kind === startKind) ? startKind : initialGroup.choices[0].kind);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [payee, setPayee] = useState('');
  const [date, setDate] = useState(dhakaToday());
  const [note, setNote] = useState('');
  const [bill, setBill] = useState<File | null>(null);
  const [newInvestor, setNewInvestor] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchAccounts(), fetchCategories(), canView ? fetchParties() : Promise.resolve(null), canView ? fetchSuppliers() : Promise.resolve([])]).then(
      ([acc, cats, people, sups]) => {
        if (!alive) return;
        if (acc.kind !== 'ready') {
          setLoadError(acc.kind === 'error' ? acc.message : 'The Batch 41 database step has not been run.');
          setAccounts([]);
          return;
        }
        const usable = acc.data.filter((a) => a.kind !== 'steadfast' && !a.archived);
        setAccounts(usable);
        const last = remembered(LAST_ACCOUNT);
        const first = usable.some((a) => a.id === last) ? last : (usable[0]?.id ?? '');
        setAccountId(first);
        setToAccountId(usable.find((a) => a.id !== first)?.id ?? '');
        if (cats.kind === 'ready') {
          const open = cats.data.filter((c) => !c.archived);
          setCategories(open);
          const lastCat = remembered(LAST_CATEGORY);
          setCategoryId(open.some((c) => c.id === lastCat) ? lastCat : (open[0]?.id ?? ''));
        }
        if (people && people.kind === 'ready') setParties(people.data);
        setSuppliers(sups);
      }
    );
    return () => {
      alive = false;
    };
  }, [canView]);

  // The amount box is ready to type in as soon as the form shows.
  const ready = accounts !== null && accounts.length > 0;
  useEffect(() => {
    if (ready) amountRef.current?.focus();
  }, [kind, ready]);

  const investors = parties.filter((p) => p.kind === 'investor');
  const others = parties.filter((p) => p.kind === 'other');
  const isInvestor = kind === 'investor_in' || kind === 'investor_profit_share' || kind === 'investor_capital_back';
  const direction = kindIsIn(kind);

  const pickGroup = (g: KindGroup) => {
    setGroup(g);
    setKind(g.choices[0].kind);
    setError(null);
  };

  const addInvestor = async () => {
    const name = newInvestor.trim();
    if (!name) return;
    const answer = await saveParty({ id: null, name, phone: '', kind: 'investor', note: '' });
    if (!answer.ok || !answer.data) {
      showToast(answer.error ?? 'Could not add', 'error');
      return;
    }
    const created: Party = { id: answer.data, name, phone: null, kind: 'investor', note: null };
    setParties((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
    setPartyId(created.id);
    setNewInvestor('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = parseAmount(amount);
    if (value === null || value <= 0) {
      setError('Type an amount above 0.');
      return;
    }
    if (!accountId) {
      setError('Pick an account.');
      return;
    }
    if (kind === 'transfer' && (!toAccountId || toAccountId === accountId)) {
      setError('Pick two different accounts.');
      return;
    }
    if (kind === 'expense' && !categoryId) {
      setError('Pick a category.');
      return;
    }
    if (isInvestor && !partyId) {
      setError('Pick the investor.');
      return;
    }
    if (kind === 'supplier_payment' && !payee) {
      setError('Pick who you paid.');
      return;
    }
    setIsSaving(true);
    let billPath: string | null = null;
    if (kind === 'expense' && bill) {
      const uploaded = await uploadBillPhoto(bill, date);
      if (uploaded.error) {
        setIsSaving(false);
        setError(uploaded.error);
        return;
      }
      billPath = uploaded.path;
    }
    const [payeeKind, payeeId] = payee.split(':');
    const answer = await addEntry({
      kind,
      amount: value,
      accountId,
      date,
      note,
      categoryId: kind === 'expense' ? categoryId : null,
      partyId: isInvestor ? partyId : kind === 'supplier_payment' && payeeKind === 'party' ? payeeId : null,
      supplierId: kind === 'supplier_payment' && payeeKind === 'supplier' ? payeeId : null,
      toAccountId: kind === 'transfer' ? toAccountId : null,
      billPath,
    });
    setIsSaving(false);
    if (!answer.ok) {
      setError(answer.error ?? 'Could not save.');
      return;
    }
    remember(LAST_ACCOUNT, accountId);
    if (kind === 'expense') remember(LAST_CATEGORY, categoryId);
    showToast(`Saved: ${group.label} ${moneyText(value)}`);
    setAmount('');
    setNote('');
    setBill(null);
    if (fileRef.current) fileRef.current.value = '';
    amountRef.current?.focus();
  };

  if (accounts === null) {
    return (
      <section className="inv money" aria-label="Add money">
        <AdminPageHeader title="Add money" onBack={onBack} />
        <SkeletonRows rows={5} thumb={false} />
      </section>
    );
  }
  if (loadError || accounts.length === 0) {
    return (
      <section className="inv money" aria-label="Add money">
        <AdminPageHeader title="Add money" onBack={onBack} />
        <EmptyState icon="alert" title="Can't add money yet" hint={loadError ?? 'There is no account to add money to.'} />
      </section>
    );
  }

  return (
    <section className="inv money" aria-label="Add money">
      <AdminPageHeader title="Add money" onBack={onBack} />
      <form className="adm-ocard inv-stack" onSubmit={submit} noValidate data-testid="money-add-form">
        <div className="money-kinds" role="group" aria-label="What kind of money">
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`money-kind${g.id === group.id ? ' money-kind--on' : ''}`}
              aria-pressed={g.id === group.id}
              onClick={() => pickGroup(g)}
              data-testid={`money-kind-${g.id}`}
            >
              {g.label}
            </button>
          ))}
        </div>
        {group.choices.length > 1 && (
          <div className="adm-chips" role="group" aria-label={group.label}>
            {group.choices.map((c) => (
              <button
                key={c.kind}
                type="button"
                className={`adm-chip${c.kind === kind ? ' adm-chip--on' : ''}`}
                aria-pressed={c.kind === kind}
                onClick={() => setKind(c.kind)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        <label className="form-field">
          <span className="form-label">Amount (৳)</span>
          <input
            ref={amountRef}
            className="form-input money-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            aria-label="Amount"
            data-testid="money-amount"
          />
        </label>

        {kind === 'transfer' ? (
          <div className="inv-fields">
            <label className="form-field">
              <span className="form-label">From</span>
              <select className="form-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="From account">
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span className="form-label">To</span>
              <select className="form-input" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)} aria-label="To account">
                <option value="">Pick…</option>
                {accounts.filter((a) => a.id !== accountId).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <label className="form-field">
            <span className="form-label">{direction === true ? 'Into account' : 'From account'}</span>
            <select className="form-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Account" data-testid="money-account">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {kind === 'expense' && (
          <label className="form-field">
            <span className="form-label">Category</span>
            <select className="form-input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category" data-testid="money-category">
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {isInvestor && (
          <>
            <label className="form-field">
              <span className="form-label">Investor</span>
              <select className="form-input" value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Investor" data-testid="money-investor">
                <option value="">Pick…</option>
                {investors.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="money-inline">
              <input
                className="form-input"
                value={newInvestor}
                onChange={(e) => setNewInvestor(e.target.value)}
                placeholder="New investor's name"
                aria-label="New investor's name"
              />
              <button type="button" className="adm-btn" onClick={() => void addInvestor()} disabled={newInvestor.trim() === ''}>
                Add investor
              </button>
            </div>
          </>
        )}

        {kind === 'supplier_payment' && (
          <label className="form-field">
            <span className="form-label">Paid to</span>
            <select className="form-input" value={payee} onChange={(e) => setPayee(e.target.value)} aria-label="Paid to" data-testid="money-payee">
              <option value="">Pick…</option>
              {suppliers.length > 0 && (
                <optgroup label="Suppliers">
                  {suppliers.map((s) => (
                    <option key={s.id} value={`supplier:${s.id}`}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {others.length > 0 && (
                <optgroup label="Other people">
                  {others.map((p) => (
                    <option key={p.id} value={`party:${p.id}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
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
            <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" aria-label="Note" data-testid="money-note" />
          </label>
        </div>

        {kind === 'expense' && (
          <label className="form-field">
            <span className="form-label">Bill photo (optional)</span>
            <input
              ref={fileRef}
              className="form-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setBill(e.target.files?.[0] ?? null)}
              aria-label="Bill photo"
            />
            <span className="inv-muted">Made small on this phone (under 150 KB) before it is saved.</span>
          </label>
        )}

        {kind === 'non_business_in' || kind === 'non_business_out' ? (
          <p className="inv-muted">Money that is not the shop&apos;s (for example your consultancy). It changes the account, never the shop&apos;s profit.</p>
        ) : kind === 'owner_withdrawal' || kind === 'owner_money_in' ? (
          <p className="inv-muted">Your own money. It is not an expense and never lowers the shop&apos;s profit.</p>
        ) : isInvestor ? (
          <p className="inv-muted">Investor money in and out is not an expense. The profit share shows under net profit on the Money page.</p>
        ) : kind === 'transfer' ? (
          <p className="inv-muted">Moving money between your own accounts. Saved as a pair: out of one, into the other.</p>
        ) : null}

        {error && (
          <p className="inv-error" role="alert" data-testid="money-error">
            {error}
          </p>
        )}
        <button type="submit" className="adm-btn adm-btn--primary money-save" disabled={isSaving} data-testid="money-save">
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
        </button>
      </form>
    </section>
  );
}
