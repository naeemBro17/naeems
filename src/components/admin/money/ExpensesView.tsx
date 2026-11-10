import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useToast } from '../../../hooks/useToast';
import { dhakaToday } from '../../../lib/inventory/api';
import type { LoadState } from '../../../lib/payouts';
import { fetchAccounts, fetchCategories, fetchMovements, saveCategory } from '../../../lib/money/api';
import { categoryShares, dayText, monthRange, monthText, moneyText } from '../../../lib/money/format';
import type { MoneyAccount, MoneyCategory, MoneyMovement } from '../../../lib/money/types';
import { AdminPageHeader, EmptyState, ListGroup, ListRow, SkeletonRows } from '../ui/AdminUi';
import type { MoneyOpen } from './moneyNav';

function lastMonths(today: string, count: number): string[] {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
}

/**
 * Batch 41 Part 2.2: expenses for a month, by category: the total at the
 * top, each category's share, then every expense (tap to change or
 * delete it).
 */
export function ExpensesView({ onBack, onOpen }: { onBack: () => void; onOpen: MoneyOpen }) {
  const today = dhakaToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [categoryId, setCategoryId] = useState('');
  const [rows, setRows] = useState<LoadState<MoneyMovement[]> | null>(null);
  const [categories, setCategories] = useState<MoneyCategory[]>([]);
  const [accounts, setAccounts] = useState<MoneyAccount[]>([]);

  useEffect(() => {
    void Promise.all([fetchCategories(), fetchAccounts()]).then(([c, a]) => {
      setCategories(c.kind === 'ready' ? c.data : []);
      setAccounts(a.kind === 'ready' ? a.data : []);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    setRows(null);
    const { from, to } = monthRange(month);
    void fetchMovements({ from, to, types: ['expense'] }).then((answer) => {
      if (alive) setRows(answer);
    });
    return () => {
      alive = false;
    };
  }, [month]);

  const all = rows?.kind === 'ready' ? rows.data : [];
  const shown = categoryId ? all.filter((r) => r.category_id === categoryId) : all;
  const total = shown.reduce((s, r) => s - r.amount, 0);
  const shares = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const r of all) byCat.set(r.category_id ?? '', (byCat.get(r.category_id ?? '') ?? 0) - r.amount);
    const list = [...byCat.entries()].map(([id, amount]) => ({ id, name: categories.find((c) => c.id === id)?.name ?? '—', amount }));
    list.sort((a, b) => b.amount - a.amount);
    return categoryShares(list);
  }, [all, categories]);
  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '—';
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '—';

  return (
    <section className="inv money" aria-label="Expenses">
      <AdminPageHeader title="Expenses" onBack={onBack} menu={[{ label: 'Add an expense', onSelect: () => onOpen('add', 'expense') }]} />
      <div className="inv-fields">
        <label className="form-field">
          <span className="form-label">Month</span>
          <select className="form-input" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            {lastMonths(today, 24).map((m) => (
              <option key={m} value={m}>
                {monthText(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span className="form-label">Category</span>
          <select className="form-input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category filter">
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {rows === null ? (
        <SkeletonRows rows={5} thumb={false} />
      ) : rows.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load" hint={rows.kind === 'error' ? rows.message : 'The Batch 41 database step has not been run.'} />
      ) : (
        <>
          <div className="adm-ocard inv-stack" data-testid="money-expenses-total">
            <div className="inv-line inv-line--total">
              <span>
                {categoryId ? catName(categoryId) : 'All expenses'} · {monthText(month)}
              </span>
              <b>{moneyText(total)}</b>
            </div>
            {!categoryId &&
              shares.map((s) => (
                <div key={s.id} className="money-share">
                  <span className="money-share__label">
                    {s.name} <span className="inv-muted">{s.percent}%</span>
                  </span>
                  <span>{moneyText(s.amount)}</span>
                  <span className="money-share__bar" aria-hidden="true">
                    <span style={{ transform: `scaleX(${s.percent / 100})` }} />
                  </span>
                </div>
              ))}
          </div>
          {shown.length === 0 ? (
            <EmptyState icon="receipt" title="No expenses" hint="Tap Add an expense, or Money → Add money." />
          ) : (
            <div className="inv-list" data-testid="money-expenses">
              {shown.map((r) => (
                <button key={r.id} type="button" className="inv-lot" onClick={() => onOpen('entry', r.id)}>
                  <span className="inv-lot__main">
                    <span className="inv-lot__title">
                      {catName(r.category_id)}
                      {r.bill_path && <span className="inv-badge inv-badge--grey">Bill</span>}
                    </span>
                    <span className="inv-lot__sub">
                      {dayText(r.entry_date)} · {accName(r.account_id)}
                      {r.note ? ` · ${r.note}` : ''}
                    </span>
                  </span>
                  <span className="inv-lot__side">
                    <b>{moneyText(-r.amount)}</b>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Batch 41 Part 2.1: the expense categories — rename, add, archive (an
 * archived category keeps its old expenses). Profit share, courier and
 * weight / cargo can't be categories (the database refuses them too).
 */
export function CategoriesView({ onBack }: { onBack: () => void }) {
  const { showToast } = useToast();
  const [list, setList] = useState<MoneyCategory[] | null>(null);
  const [editing, setEditing] = useState<MoneyCategory | 'new' | null>(null);
  const [name, setName] = useState('');
  const [archived, setArchived] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const answer = await fetchCategories();
    setList(answer.kind === 'ready' ? answer.data : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const start = (c: MoneyCategory | 'new') => {
    setEditing(c);
    setName(c === 'new' ? '' : c.name);
    setArchived(c === 'new' ? false : c.archived);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    const answer = await saveCategory(editing === 'new' ? null : editing.id, name, archived);
    setSaving(false);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not save', 'error');
      return;
    }
    showToast('Category saved');
    setEditing(null);
    await load();
  };

  return (
    <section className="inv money" aria-label="Expense categories">
      <AdminPageHeader title="Expense categories" onBack={onBack} />
      {list === null ? (
        <SkeletonRows rows={6} thumb={false} />
      ) : (
        <ListGroup>
          {list.map((c) => (
            <ListRow key={c.id} label={`${c.name}${c.archived ? ' (archived)' : ''}`} onClick={() => start(c)} />
          ))}
          <ListRow label="Add a category" onClick={() => start('new')} />
        </ListGroup>
      )}
      <p className="inv-muted">
        Not categories on purpose: courier and COD fees (they are in each order&apos;s profit), weight / cargo and trip costs (they belong to
        the lot), investor profit share and your withdrawals (not expenses).
      </p>
      {editing && (
        <form className="adm-ocard inv-stack" onSubmit={save} noValidate>
          <label className="form-field">
            <span className="form-label">Name</span>
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Category name" />
          </label>
          {editing !== 'new' && (
            <label className="inv-check">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived (not offered for new expenses)
            </label>
          )}
          <div className="inv-actions">
            <button type="button" className="adm-btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="adm-btn adm-btn--primary" disabled={saving}>
              {saving ? <span className="spinner" aria-hidden="true" /> : 'Save category'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
