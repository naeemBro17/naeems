import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import { useToast } from '../../../hooks/useToast';
import { dhakaToday } from '../../../lib/inventory/api';
import type { LoadState } from '../../../lib/payouts';
import { fetchAccounts, fetchBalances, fetchBooks, fetchLedger, placePayout, saveAccount } from '../../../lib/money/api';
import { dayText, monthRange, monthText, moneyText, signedMoney, typeLabel } from '../../../lib/money/format';
import type { AccountBalance, LedgerRow, MoneyAccount } from '../../../lib/money/types';
import { AdminPageHeader, EmptyState, ListGroup, ListRow, SkeletonRows } from '../ui/AdminUi';
import type { MoneyOpen } from './moneyNav';

const ACCOUNT_KINDS: { id: MoneyAccount['kind']; label: string }[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'bkash', label: 'bKash' },
  { id: 'bank', label: 'Bank' },
  { id: 'nagad', label: 'Nagad' },
  { id: 'other', label: 'Other' },
];

const METHODS: { id: string; label: string }[] = [
  { id: '', label: 'None' },
  { id: 'cash', label: 'Cash' },
  { id: 'bkash', label: 'bKash' },
  { id: 'bank', label: 'Bank' },
  { id: 'nagad', label: 'Nagad' },
  { id: 'other', label: 'Other' },
];

/* -------------------------------------------------- payouts to place */

interface PayoutRow {
  id: string;
  paid_at: string | null;
  total_amount: number;
  parcel_count: number;
}

/**
 * Batch 41 Part 1.4: Steadfast payouts that arrived but are not in an
 * account yet. Choose once where each landed (the last account used is
 * offered). The fees inside it are already in each order's profit.
 */
export function PayoutsToPlace({ onPlaced }: { onPlaced?: () => void }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<PayoutRow[] | null>(null);
  const [accounts, setAccounts] = useState<MoneyAccount[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [books, acc, payouts, placed, last] = await Promise.all([
      fetchBooks(),
      fetchAccounts(),
      supabase.from('steadfast_payouts').select('id, paid_at, total_amount, parcel_count').gt('total_amount', 0).order('paid_at', { ascending: false }).limit(200),
      supabase.from('money_movements').select('payout_id').eq('type', 'steadfast_payout_in'),
      supabase.from('money_books').select('last_payout_account_id').eq('id', 1).maybeSingle(),
    ]);
    const usable = acc.kind === 'ready' ? acc.data.filter((a) => a.kind !== 'steadfast' && !a.archived) : [];
    setAccounts(usable);
    const taken = new Set(((placed.data ?? []) as { payout_id: string }[]).map((p) => p.payout_id));
    const start = books?.confirmed_at ? books.start_date : null;
    const list = ((payouts.data ?? []) as Record<string, unknown>[])
      .map((p) => ({ id: p.id as string, paid_at: (p.paid_at as string | null) ?? null, total_amount: Number(p.total_amount), parcel_count: Number(p.parcel_count) }))
      .filter((p) => !taken.has(p.id))
      // Before the start date a payout is part of the opening balances.
      .filter((p) => !start || (p.paid_at !== null && dhakaToday(new Date(p.paid_at)) >= start));
    setRows(start ? list : []);
    const lastId = (last.data as { last_payout_account_id: string | null } | null)?.last_payout_account_id ?? null;
    const fallback = usable.find((a) => a.id === lastId)?.id ?? usable.find((a) => a.kind === 'bank')?.id ?? usable[0]?.id ?? '';
    setPick(Object.fromEntries(list.map((p) => [p.id, fallback])));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!rows || rows.length === 0) return null;

  const place = async (row: PayoutRow) => {
    const accountId = pick[row.id];
    if (!accountId) return;
    setWorking(row.id);
    const answer = await placePayout(row.id, accountId);
    setWorking(null);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not save', 'error');
      return;
    }
    showToast(`Payout ${moneyText(row.total_amount)} placed in ${accounts.find((a) => a.id === accountId)?.name ?? 'the account'}`);
    await load();
    onPlaced?.();
  };

  return (
    <div className="adm-ocard inv-stack" data-testid="money-payouts-to-place">
      <p className="inv-mode__title">Steadfast payouts to place</p>
      <p className="inv-muted">Which account did each payout land in? Choose once. The fees inside it are already in each order&apos;s profit.</p>
      {rows.map((row) => (
        <div key={row.id} className="money-place">
          <span>
            <b>{moneyText(row.total_amount)}</b>
            <span className="inv-muted">
              {' '}
              · {row.paid_at ? dayText(dhakaToday(new Date(row.paid_at))) : '—'} · {row.parcel_count} parcel{row.parcel_count === 1 ? '' : 's'}
            </span>
          </span>
          <select
            className="form-input"
            value={pick[row.id] ?? ''}
            onChange={(e) => setPick((prev) => ({ ...prev, [row.id]: e.target.value }))}
            aria-label={`Account for the payout of ${moneyText(row.total_amount)}`}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="button" className="adm-btn" onClick={() => void place(row)} disabled={working === row.id} data-testid="money-place-payout">
            {working === row.id ? <span className="spinner" aria-hidden="true" /> : 'Place'}
          </button>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- accounts */

export function AccountsView({ onBack, onOpen }: { onBack: () => void; onOpen: MoneyOpen }) {
  const { showToast } = useToast();
  const [balances, setBalances] = useState<LoadState<AccountBalance[]> | null>(null);
  const [accounts, setAccounts] = useState<MoneyAccount[]>([]);
  const [editing, setEditing] = useState<MoneyAccount | 'new' | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<MoneyAccount['kind']>('cash');
  const [method, setMethod] = useState('');
  const [archived, setArchived] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [b, a] = await Promise.all([fetchBalances(), fetchAccounts()]);
    setBalances(b);
    setAccounts(a.kind === 'ready' ? a.data : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = (acc: MoneyAccount | 'new') => {
    setEditing(acc);
    setName(acc === 'new' ? '' : acc.name);
    setKind(acc === 'new' ? 'cash' : acc.kind);
    setMethod(acc === 'new' ? '' : (acc.payment_method ?? ''));
    setArchived(acc === 'new' ? false : acc.archived);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    const answer = await saveAccount({
      id: editing === 'new' ? null : editing.id,
      name,
      kind,
      paymentMethod: method || null,
      archived,
    });
    setSaving(false);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not save', 'error');
      return;
    }
    showToast('Account saved');
    setEditing(null);
    await load();
  };

  const list = balances?.kind === 'ready' ? balances.data : [];
  const total = list.reduce((s, a) => s + a.balance, 0);
  const isSteadfast = editing !== null && editing !== 'new' && editing.kind === 'steadfast';

  return (
    <section className="inv money" aria-label="Accounts">
      <AdminPageHeader title="Accounts" onBack={onBack} />
      {balances === null ? (
        <SkeletonRows rows={4} thumb={false} />
      ) : balances.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load" hint={balances.kind === 'error' ? balances.message : 'The Batch 41 database step has not been run.'} />
      ) : (
        <>
          <ListGroup title="BALANCES">
            {list.map((a) => (
              <ListRow
                key={a.account_id}
                label={`${a.name}${a.archived ? ' (archived)' : ''}`}
                detail={moneyText(a.balance)}
                onClick={() => onOpen('account', a.account_id)}
              />
            ))}
          </ListGroup>
          <p className="inv-muted money-total" data-testid="money-accounts-total">
            All accounts: <b>{moneyText(total)}</b>
          </p>
          <PayoutsToPlace onPlaced={() => void load()} />
          <ListGroup title="CHANGE">
            {accounts.map((a) => (
              <ListRow key={a.id} label={`Rename / edit ${a.name}`} onClick={() => startEdit(a)} />
            ))}
            <ListRow label="Add an account (e.g. Nagad, a second bank)" onClick={() => startEdit('new')} />
          </ListGroup>
        </>
      )}

      {editing && (
        <form className="adm-ocard inv-stack" onSubmit={save} noValidate data-testid="money-account-form">
          <p className="inv-mode__title">{editing === 'new' ? 'New account' : `Edit ${editing.name}`}</p>
          <label className="form-field">
            <span className="form-label">Name</span>
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Account name" />
          </label>
          {!isSteadfast && (
            <>
              <label className="form-field">
                <span className="form-label">Kind</span>
                <select className="form-input" value={kind} onChange={(e) => setKind(e.target.value as MoneyAccount['kind'])} aria-label="Account kind">
                  {ACCOUNT_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span className="form-label">Customer payments marked as</span>
                <select className="form-input" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Customer payments method">
                  {METHODS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <span className="inv-muted">A customer payment with this method lands in this account. A method no account takes goes to Cash.</span>
              </label>
              {editing !== 'new' && (
                <label className="inv-check">
                  <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived (no new entries)
                </label>
              )}
            </>
          )}
          {isSteadfast && <p className="inv-muted">"With Steadfast" is never typed into: it follows the COD money and the Steadfast payouts.</p>}
          <div className="inv-actions">
            <button type="button" className="adm-btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="adm-btn adm-btn--primary" disabled={saving}>
              {saving ? <span className="spinner" aria-hidden="true" /> : 'Save account'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/* --------------------------------------------------- one account */

function sourceTarget(row: LedgerRow): { kind: 'entry' | 'order' | null; id: string | null } {
  if (row.source === 'movement' || row.source === 'payout_out') return { kind: 'entry', id: row.source_id };
  if (row.source === 'payment' || row.source === 'payout_fees') return { kind: 'order', id: row.reference };
  return { kind: null, id: null };
}

/**
 * One account: every taka in and out (money entries, customer payments read
 * from the orders, Steadfast's side), newest first, with the balance after
 * each line. Month by month.
 */
export function AccountLedgerView({
  accountId,
  onBack,
  onOpen,
  onOpenOrder,
}: {
  accountId: string;
  onBack: () => void;
  onOpen: MoneyOpen;
  onOpenOrder: (orderNumber: string) => void;
}) {
  const today = dhakaToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [rows, setRows] = useState<LoadState<LedgerRow[]> | null>(null);
  const [balance, setBalance] = useState<AccountBalance | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    const { from } = monthRange(month);
    void Promise.all([fetchLedger(accountId, from, today), fetchBalances()]).then(([ledger, b]) => {
      if (!alive) return;
      setRows(ledger);
      setBalance(b.kind === 'ready' ? (b.data.find((x) => x.account_id === accountId) ?? null) : null);
    });
    return () => {
      alive = false;
    };
  }, [accountId, month, today]);

  // Balance after each line: from today's balance, backwards.
  const shown = useMemo(() => {
    if (!rows || rows.kind !== 'ready' || !balance) return [];
    const { to } = monthRange(month);
    let after = balance.balance;
    const out: (LedgerRow & { after: number })[] = [];
    for (const r of rows.data) {
      if (r.entry_date <= to) out.push({ ...r, after });
      after -= r.amount;
    }
    return out;
  }, [rows, balance, month]);

  const months = useMemo(() => {
    const list: string[] = [];
    const [y, m] = today.slice(0, 7).split('-').map(Number);
    for (let i = 0; i < 24; i += 1) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      list.push(d.toISOString().slice(0, 7));
    }
    return list;
  }, [today]);

  return (
    <section className="inv money" aria-label="Account">
      <AdminPageHeader title={balance?.name ?? 'Account'} subtitle={balance ? `Now ${moneyText(balance.balance)}` : undefined} onBack={onBack} />
      <label className="form-field">
        <span className="form-label">Month</span>
        <select className="form-input" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          {months.map((m) => (
            <option key={m} value={m}>
              {monthText(m)}
            </option>
          ))}
        </select>
      </label>
      {rows === null ? (
        <SkeletonRows rows={6} thumb={false} />
      ) : rows.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load" hint={rows.kind === 'error' ? rows.message : undefined} />
      ) : shown.length === 0 ? (
        <EmptyState icon="payouts" title="Nothing this month" />
      ) : (
        <div className="inv-list" data-testid="money-ledger">
          {shown.map((r) => {
            const target = sourceTarget(r);
            const clickable = target.kind !== null && target.id !== null;
            const content = (
              <>
                <span className="inv-lot__main">
                  <span className="inv-lot__title">{typeLabel(r.type)}</span>
                  <span className="inv-lot__sub">
                    {dayText(r.entry_date)}
                    {r.reference ? ` · ${r.reference}` : ''}
                    {r.note ? ` · ${r.note}` : ''}
                  </span>
                </span>
                <span className="inv-lot__side">
                  <b className={r.amount < 0 ? 'money-out' : 'money-in'}>{signedMoney(r.amount, true)}</b>
                  <span className="inv-muted">{moneyText(r.after)}</span>
                </span>
              </>
            );
            return clickable ? (
              <button
                key={`${r.source}:${r.source_id}`}
                type="button"
                className="inv-lot"
                onClick={() => (target.kind === 'entry' ? onOpen('entry', target.id ?? undefined) : onOpenOrder(target.id ?? ''))}
              >
                {content}
              </button>
            ) : (
              <div key={`${r.source}:${r.source_id}`} className="inv-lot">
                {content}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
