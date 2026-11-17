import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { importExpenses, readKaarbarFile, undoExpenses, type KaarbarStatus, type KeptExpense } from '../../../lib/kaarbar/api';
import {
  accountDecreases,
  categoryKey,
  classifyExpenses,
  defaultProfitShareWho,
  expenseImportRows,
  newestFirst,
  readExpenses,
  totalsByCategory,
  totalsByMonth,
  type ExpensePreviewRow,
  type ExpenseRow,
  type ExpenseStatus,
} from '../../../lib/kaarbar/parse';
import { fetchAccounts, fetchCategories, fetchParties } from '../../../lib/money/api';
import { dayText, moneyText, monthText } from '../../../lib/money/format';
import type { MoneyAccount, MoneyCategory, Party } from '../../../lib/money/types';
import { ChipRow, type Chip } from '../ui/AdminUi';
import { importWhen, PasswordSheet } from './KaarbarImportTab';

const STATUSES: { id: ExpenseStatus; label: string }[] = [
  { id: 'new', label: 'New expenses' },
  { id: 'profitShare', label: 'PROFIT SHARE' },
  { id: 'already', label: 'Already imported' },
  { id: 'notExpense', label: 'Not an expense' },
  { id: 'locked', label: 'Month is locked' },
  { id: 'noAccount', label: 'No money account' },
  { id: 'bad', label: 'Can’t read' },
];

const PAGE = 50;

function sum(rows: readonly { amount: number | null }[]): number {
  return rows.reduce((s, r) => s + (r.amount ?? 0), 0);
}

export function KaarbarExpensesCard({ status, onChanged }: { status: KaarbarStatus; onChanged: () => Promise<void> }) {
  const { showToast } = useToast();
  const [accounts, setAccounts] = useState<MoneyAccount[]>([]);
  const [categories, setCategories] = useState<MoneyCategory[]>([]);
  const [investors, setInvestors] = useState<Party[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [expenses, setExpenses] = useState<ExpenseRow[] | null>(null);
  const [who, setWho] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState<'all' | ExpenseStatus>('all');
  const [shown, setShown] = useState(PAGE);
  const [sheet, setSheet] = useState<'import' | 'undo' | null>(null);
  const [kept, setKept] = useState<KeptExpense[] | null>(null);

  const loadMoney = async () => {
    const [a, c, p] = await Promise.all([fetchAccounts(), fetchCategories(), fetchParties()]);
    if (a.kind === 'ready') setAccounts(a.data);
    if (c.kind === 'ready') setCategories(c.data);
    if (p.kind === 'ready') setInvestors(p.data.filter((x) => x.kind === 'investor'));
  };

  useEffect(() => {
    void loadMoney();
  }, []);

  const startDate = status.startDate;
  const rows: ExpensePreviewRow[] | null = useMemo(() => {
    if (!expenses || !startDate) return null;
    return newestFirst(
      classifyExpenses(expenses, {
        startDate,
        today: status.today,
        lockedMonths: new Set(status.lockedMonths),
        billNos: new Set(status.billNos),
        accounts,
      })
    );
  }, [expenses, startDate, status, accounts]);

  // Who each PROFIT SHARE row was paid to: a guess from the note, else
  // the only investor, else "leave out" until it is picked.
  useEffect(() => {
    if (!rows) return;
    setWho((old) => {
      const next = new Map(old);
      for (const r of rows) if (r.status === 'profitShare' && !next.has(r.billNo)) next.set(r.billNo, defaultProfitShareWho(r.note, investors));
      return next;
    });
  }, [rows, investors]);

  const pick = async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setFileError(null);
    setExpenses(null);
    setKept(null);
    setWho(new Map());
    setReading(true);
    try {
      const sheets = await readKaarbarFile(file);
      let found: ExpenseRow[] | null = null;
      let firstError: string | null = null;
      for (const cells of sheets) {
        const read = readExpenses(cells);
        if (!read.error) {
          found = read.rows;
          break;
        }
        firstError ??= read.error;
      }
      if (!found) {
        setFileError(firstError ?? 'The file is empty.');
        return;
      }
      setFilter('all');
      setShown(PAGE);
      setExpenses(found);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'Could not read the file.');
    } finally {
      setReading(false);
    }
  };

  const byStatus = useMemo(() => {
    const map = new Map<ExpenseStatus, ExpensePreviewRow[]>();
    for (const r of rows ?? []) map.set(r.status, [...(map.get(r.status) ?? []), r]);
    return map;
  }, [rows]);

  const toImport = useMemo(() => (rows ? expenseImportRows(rows, who) : []), [rows, who]);
  const decreases = useMemo(() => (startDate ? accountDecreases(toImport, startDate, accounts) : []), [toImport, startDate, accounts]);
  const months = useMemo(() => (rows ? totalsByMonth(rows) : []), [rows]);
  const cats = useMemo(() => (rows ? totalsByCategory(rows) : []), [rows]);
  const known = useMemo(() => new Set(categories.map((c) => categoryKey(c.name))), [categories]);
  const newRows = byStatus.get('new') ?? [];
  const historyCount = newRows.filter((r) => r.history).length;
  const shareRows = byStatus.get('profitShare') ?? [];
  const sharesIn = toImport.filter((r) => r.kind !== 'expense').length;
  const visible = (rows ?? []).filter((r) => filter === 'all' || r.status === filter);

  const chips: Chip[] = [
    { id: 'all', label: 'All', count: rows?.length ?? 0 },
    ...STATUSES.filter((s) => (byStatus.get(s.id)?.length ?? 0) > 0).map((s) => ({ id: s.id, label: s.label, count: byStatus.get(s.id)?.length ?? 0 })),
  ];

  const whoOptions = [
    { value: '', label: 'Leave it out' },
    ...investors.map((p) => ({ value: `party:${p.id}`, label: `${p.name} — investor profit share` })),
    { value: 'owner', label: 'Me — owner withdrawal' },
  ];

  const setAllWho = (value: string) => setWho((old) => new Map([...old.keys()].map((k) => [k, value])));

  const doImport = async (): Promise<string | null> => {
    const answer = await importExpenses(toImport);
    if (!answer.ok) return answer.error;
    setSheet(null);
    showToast(`Imported ${answer.data.added} entr${answer.data.added === 1 ? 'y' : 'ies'} (${moneyText(answer.data.total)})`);
    await Promise.all([onChanged(), loadMoney()]);
    return null;
  };

  const doUndo = async (): Promise<string | null> => {
    const answer = await undoExpenses();
    if (!answer.ok) return answer.error;
    setSheet(null);
    setKept(answer.data.kept);
    showToast(`Removed ${answer.data.removed} imported entr${answer.data.removed === 1 ? 'y' : 'ies'}`);
    await Promise.all([onChanged(), loadMoney()]);
    return null;
  };

  const last = status.lastExpenses;

  return (
    <section className="adm-ocard kb-card" aria-label="Expenses" data-testid="kb-expenses">
      <h2 className="kb-card__title">Expenses</h2>
      <p className="inv-muted">From Kaarbar: Reports → Expense Report (all dates up to today) → Excel. Old sales and payments are not imported.</p>
      {!startDate ? (
        <p className="kb-notice" data-testid="kb-expenses-no-start">
          Confirm your opening balances first (Money → Opening balances). The import needs that start date to know which expenses already
          are in your account balances.
        </p>
      ) : (
        <>
          <p className="inv-muted">
            Expenses before <b>{dayText(startDate)}</b> are history only: they don&apos;t change any account balance (your opening balances
            already include them). From {dayText(startDate)} on, each expense comes out of its Cash / bKash account.
          </p>
          <label className="adm-btn kb-file">
            {reading ? 'Reading…' : fileName ? 'Pick another file' : 'Pick the Expense Report'}
            <input type="file" accept=".xlsx" hidden onChange={(e) => void pick(e.target.files?.[0] ?? null)} data-testid="kb-expenses-file" />
          </label>
        </>
      )}
      {fileName && <p className="inv-muted kb-filename">{fileName}</p>}
      {fileError && (
        <p className="inv-error" role="alert" data-testid="kb-expenses-error">
          {fileError}
        </p>
      )}

      {rows && startDate && (
        <div className="inv-stack" data-testid="kb-expenses-preview">
          <ul className="kb-counts" aria-label="What will happen">
            {STATUSES.map((s) => {
              const list = byStatus.get(s.id) ?? [];
              return (
                <li key={s.id} className="kb-counts__item" data-testid={`kb-count-${s.id}`}>
                  <span>
                    {s.label}
                    {s.id === 'new' && historyCount > 0 && <span className="inv-muted"> ({historyCount} history)</span>}
                  </span>
                  <b>
                    {list.length}
                    {list.length > 0 && (s.id === 'new' || s.id === 'profitShare') ? ` · ${moneyText(sum(list))}` : ''}
                  </b>
                </li>
              );
            })}
          </ul>

          <h3 className="kb-sub">Money accounts after the import</h3>
          {decreases.length === 0 ? (
            <p className="inv-muted" data-testid="kb-no-decrease">
              No account balance changes: everything to add is dated before {dayText(startDate)}.
            </p>
          ) : (
            <div className="inv-stack" data-testid="kb-decreases">
              {decreases.map((d) => (
                <div key={d.key} className="inv-line">
                  <span>
                    {d.label} goes down ({d.count})
                  </span>
                  <span>−{moneyText(d.amount)}</span>
                </div>
              ))}
            </div>
          )}

          {months.length > 0 && (
            <details className="kb-fold" open>
              <summary>New expenses by month</summary>
              <div className="inv-stack">
                {months.map((m) => (
                  <div key={m.key} className="inv-line">
                    <span>
                      {monthText(m.key)} <span className="inv-muted">({m.count})</span>
                    </span>
                    <span>{moneyText(m.amount)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {cats.length > 0 && (
            <details className="kb-fold" open>
              <summary>New expenses by category</summary>
              <div className="inv-stack" data-testid="kb-categories">
                {cats.map((c) => (
                  <div key={c.key} className="inv-line">
                    <span>
                      {c.label} <span className="inv-muted">({c.count})</span>
                      {!known.has(c.key) && <span className="kb-tag kb-tag--grey">new category</span>}
                    </span>
                    <span>{moneyText(c.amount)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {shareRows.length > 0 && (
            <div className="kb-share" data-testid="kb-profit-share">
              <h3 className="kb-sub">PROFIT SHARE ({shareRows.length} · {moneyText(sum(shareRows))})</h3>
              <p className="inv-muted">
                Never counted as an expense. Record each one as an investor&apos;s profit share or as your own withdrawal (Money already has
                both), or leave it out.
              </p>
              <label className="form-field">
                <span className="form-label">Set all to</span>
                <select className="form-input" value="-" onChange={(e) => e.target.value !== '-' && setAllWho(e.target.value)} data-testid="kb-share-all">
                  <option value="-">Choose…</option>
                  {whoOptions.map((o) => (
                    <option key={o.value || 'out'} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <ul className="kb-list">
                {shareRows.map((r) => (
                  <li key={r.billNo} className="kb-row kb-row--stack" data-testid="kb-share-row">
                    <span className="kb-row__main">
                      <span className="kb-row__name">
                        {r.date ? dayText(r.date) : r.dateText} · {moneyText(r.amount ?? 0)} · {r.mode}
                      </span>
                      {r.note && <span className="kb-note">{r.note}</span>}
                    </span>
                    <select
                      className="form-input"
                      value={who.get(r.billNo) ?? ''}
                      onChange={(e) => {
                        const value = e.target.value;
                        setWho((old) => new Map(old).set(r.billNo, value));
                      }}
                      aria-label={`Bill ${r.billNo} is`}
                    >
                      {whoOptions.map((o) => (
                        <option key={o.value || 'out'} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3 className="kb-sub">Every row, newest first</h3>
          <ChipRow chips={chips} active={filter} onSelect={(id) => { setFilter(id as 'all' | ExpenseStatus); setShown(PAGE); }} label="Show" />
          <ul className="kb-list" data-testid="kb-expenses-list">
            {visible.slice(0, shown).map((r) => (
              <li key={`${r.n}`} className="kb-row kb-row--stack" data-testid="kb-expense-row" data-status={r.status}>
                <span className="kb-exp">
                  <span className="kb-exp__top">
                    <span className="kb-row__name">{r.category || 'No category'}</span>
                    <b className="kb-exp__amount">{r.amount === null ? '—' : moneyText(r.amount)}</b>
                  </span>
                  <span className="kb-row__sub">
                    {r.date ? dayText(r.date) : r.dateText || 'No date'} · {r.mode || 'No payment mode'} · Bill {r.billNo || '—'}
                  </span>
                  {r.note && <span className="kb-note">{r.note}</span>}
                </span>
                <span className={`kb-tag kb-tag--${r.status}${r.status === 'new' && r.history ? ' kb-tag--history' : ''}`}>
                  {r.status === 'new' ? (r.history ? 'History' : 'New') : r.reason}
                </span>
              </li>
            ))}
          </ul>
          {visible.length > shown && (
            <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setShown((s) => s + PAGE)}>
              Show {Math.min(PAGE, visible.length - shown)} more
            </button>
          )}
        </div>
      )}

      {kept && kept.length > 0 && (
        <div className="kb-notice" data-testid="kb-expenses-kept">
          <b>Kept {kept.length} entr{kept.length === 1 ? 'y' : 'ies'} in locked months:</b>
          <ul>
            {kept.map((k) => (
              <li key={k.bill_no}>
                Bill {k.bill_no}, {dayText(k.date)}, {moneyText(Number(k.amount))}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="adm-careful kb-careful" aria-label="Careful actions" data-testid="kb-expenses-careful">
        <h3 className="adm-careful__title">Careful actions</h3>
        <p className="adm-ocard__muted">You will be asked for your password.</p>
        <ul className="adm-careful__list">
          <li className="adm-careful__row">
            <span className="adm-careful__text">
              <span className="adm-careful__name">Import {toImport.length} entries</span>
              <span className="adm-careful__explain">
                {toImport.length - sharesIn} expenses{sharesIn > 0 ? ` and ${sharesIn} profit share / withdrawals` : ''}. Skipped rows stay out.
              </span>
            </span>
            <button
              type="button"
              className="adm-btn adm-btn--sm kb-go"
              disabled={toImport.length === 0}
              onClick={() => setSheet('import')}
              data-testid="kb-expenses-import"
            >
              Import {toImport.length}…
            </button>
          </li>
          <li className="adm-careful__row">
            <span className="adm-careful__text">
              <span className="adm-careful__name">Undo last import</span>
              <span className="adm-careful__explain">
                {last ? `${importWhen(last.at)}: ${last.count} entries, ${moneyText(last.total)}. Their amounts go back to the accounts.` : 'No expense import yet.'}
              </span>
            </span>
            <button
              type="button"
              className="adm-btn adm-btn--sm adm-careful__btn adm-careful__btn--red"
              disabled={!last}
              onClick={() => setSheet('undo')}
              data-testid="kb-expenses-undo"
            >
              Undo…
            </button>
          </li>
        </ul>
      </section>

      <PasswordSheet
        isOpen={sheet === 'import'}
        title={`Import ${toImport.length} entries?`}
        text={`${moneyText(sum(toImport))} in all.${
          decreases.length > 0 ? ` ${decreases.map((d) => `${d.label} goes down ${moneyText(d.amount)}`).join(', ')}.` : ' No account balance changes.'
        }`}
        confirmLabel="Import"
        onConfirm={doImport}
        onClose={() => setSheet(null)}
      />
      <PasswordSheet
        isOpen={sheet === 'undo'}
        title="Undo the last expense import?"
        text={last ? `Removes the ${last.count} entries imported ${importWhen(last.at)} and gives their amounts back to the money accounts.` : ''}
        confirmLabel="Undo import"
        danger
        onConfirm={doUndo}
        onClose={() => setSheet(null)}
      />
    </section>
  );
}
