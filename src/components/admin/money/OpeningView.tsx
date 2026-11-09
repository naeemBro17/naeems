import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { useAuth } from '../../../contexts/AuthContext';
import { useSafetyLock } from '../../../contexts/SafetyLockContext';
import { supabase } from '../../../lib/supabase';
import { dhakaToday } from '../../../lib/inventory/api';
import { saveBlob } from '../../../lib/inventory/xlsx';
import {
  confirmOpening,
  fetchAccounts,
  fetchBooks,
  fetchOpeningLotDate,
  fetchOpeningRows,
  previewOpeningDues,
  undoOpening,
} from '../../../lib/money/api';
import { dayText, moneyText, openingDueAmount, parseAmount, readDueRows } from '../../../lib/money/format';
import { buildDuesTemplate, readDuesFile } from '../../../lib/money/xlsx';
import type { DueChoice, MoneyAccount, OpeningPayableInput, OpeningPreview } from '../../../lib/money/types';
import { AdminPageHeader, SkeletonRows } from '../ui/AdminUi';
import { CarefulActionsCard, ConfirmSheet } from '../OrderActionCards';

const CHOICES: { id: DueChoice; label: string }[] = [
  { id: 'keep_site', label: 'Keep the site due' },
  { id: 'kaarbar', label: 'Use the Kaarbar due' },
  { id: 'both', label: 'Add both' },
];

function emptyPayable(): OpeningPayableInput {
  return { kind: 'investor', name: '', phone: '', amount: '', note: '' };
}

/**
 * Batch 41 Part 6: opening balances — one screen, used once on the start
 * date (the same date as the opening stock L-000). Accounts as counted,
 * "With Steadfast" from Steadfast, customer dues from a Kaarbar file
 * (preview first: nothing is saved until Confirm), and what is owed.
 * Confirm once; undo only with Careful actions and the Safety Lock.
 */
export function OpeningView({ onBack }: { onBack: () => void }) {
  const { showToast } = useToast();
  const { isAdmin } = useAuth();
  const { openUntil } = useSafetyLock();
  const [books, setBooks] = useState<Awaited<ReturnType<typeof fetchBooks>> | undefined>(undefined);
  const [accounts, setAccounts] = useState<MoneyAccount[]>([]);
  const [lotDate, setLotDate] = useState<string | null>(null);
  const [start, setStart] = useState(dhakaToday());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [steadfast, setSteadfast] = useState<number | null>(null);
  const [preview, setPreview] = useState<OpeningPreview | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<number, DueChoice>>({});
  const [payables, setPayables] = useState<OpeningPayableInput[]>([emptyPayable()]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoText, setUndoText] = useState('');
  const [saved, setSaved] = useState<Awaited<ReturnType<typeof fetchOpeningRows>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [b, acc, date, sf] = await Promise.all([
      fetchBooks(),
      fetchAccounts(),
      fetchOpeningLotDate(),
      supabase.from('steadfast_sync_state').select('current_balance').eq('id', 1).maybeSingle(),
    ]);
    setBooks(b);
    setAccounts(acc.kind === 'ready' ? acc.data.filter((a) => a.kind !== 'steadfast' && !a.archived) : []);
    setLotDate(date);
    if (date) setStart(date);
    setSteadfast(sf.data ? Number((sf.data as { current_balance: number | null }).current_balance ?? 0) : null);
    if (b?.confirmed_at) setSaved(await fetchOpeningRows());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = preview?.rows ?? [];
  const good = rows.filter((r) => !r.problem && r.due !== null);
  const bad = rows.filter((r) => r.problem);
  const clash = good.filter((r) => r.site_due > 0);
  const fresh = good.filter((r) => !r.known);
  const fileTotal = good.reduce((s, r) => s + (r.due ?? 0), 0);
  const saveTotal = useMemo(
    () => good.reduce((s, r) => s + openingDueAmount(r.due ?? 0, r.site_due, choices[r.n] ?? 'kaarbar'), 0),
    [good, choices]
  );
  const accountsTotal = accounts.reduce((s, a) => s + (parseAmount(amounts[a.id] ?? '') ?? 0), 0);
  const payTotal = payables.reduce((s, p) => s + (parseAmount(p.amount) ?? 0), 0);

  const upload = async (file: File | null) => {
    setFileError(null);
    setPreview(null);
    if (!file) return;
    setFileName(file.name);
    try {
      const cells = await readDuesFile(file);
      const { rows: dueRows, error: readError } = readDueRows(cells);
      if (readError) {
        setFileError(readError);
        return;
      }
      const answer = await previewOpeningDues(dueRows);
      if (!answer.ok || !answer.data) {
        setFileError(answer.error ?? 'Could not check the file.');
        return;
      }
      setPreview(answer.data);
      setChoices(Object.fromEntries(answer.data.rows.filter((r) => r.site_due > 0).map((r) => [r.n, 'kaarbar' as DueChoice])));
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Could not read the file.');
    }
  };

  const confirm = async () => {
    setError(null);
    if (bad.length > 0) {
      setError('Fix the rows with a problem in the file, then upload it again.');
      setConfirmOpen(false);
      return;
    }
    for (const p of payables) {
      if (p.amount.trim() !== '' && (parseAmount(p.amount) === null || p.name.trim() === '')) {
        setError('Each row of "What I owe" needs a name and an amount.');
        setConfirmOpen(false);
        return;
      }
    }
    const answer = await confirmOpening({
      start,
      accounts: accounts.map((a) => ({ account_id: a.id, amount: parseAmount(amounts[a.id] ?? '') ?? 0 })).filter((a) => a.amount !== 0),
      dues: good.map((r) => ({ phone: r.phone, name: r.name, due: r.due ?? 0, choice: choices[r.n] ?? 'kaarbar' })),
      payables: payables
        .filter((p) => p.amount.trim() !== '')
        .map((p) => ({ ...p, amount: String(parseAmount(p.amount) ?? 0) })),
    });
    setConfirmOpen(false);
    if (!answer.ok) {
      setError(answer.error ?? 'Could not confirm.');
      return;
    }
    showToast('Opening balances confirmed');
    setPreview(null);
    await load();
  };

  const undo = async () => {
    const answer = await undoOpening(undoText);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not undo', 'error');
      return;
    }
    setUndoOpen(false);
    setUndoText('');
    setSaved(null);
    showToast('Opening balances undone');
    await load();
  };

  if (books === undefined) {
    return (
      <section className="inv money" aria-label="Opening balances">
        <AdminPageHeader title="Opening balances" onBack={onBack} />
        <SkeletonRows rows={5} thumb={false} />
      </section>
    );
  }

  if (books?.confirmed_at && saved) {
    const accName = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'With Steadfast';
    return (
      <section className="inv money" aria-label="Opening balances">
        <AdminPageHeader title="Opening balances" subtitle={`Start date ${dayText(books.start_date)}`} onBack={onBack} />
        <div className="adm-ocard inv-stack" data-testid="opening-saved">
          <p className="inv-ok">
            <b>Confirmed</b> by {books.confirmed_by_username ?? '—'}
          </p>
          {saved.accounts.map((a) => (
            <div key={a.account_id} className="inv-line">
              <span>{accName(a.account_id)}</span>
              <span>{moneyText(a.amount)}</span>
            </div>
          ))}
          <div className="inv-line">
            <span>Customer dues (previous balances): {saved.dues.length}</span>
            <span>{moneyText(saved.dues.reduce((s, d) => s + d.amount, 0))}</span>
          </div>
          <div className="inv-line">
            <span>What I owed: {saved.payables.length}</span>
            <span>{moneyText(saved.payables.reduce((s, d) => s + d.amount, 0))}</span>
          </div>
        </div>
        {isAdmin && (
          <CarefulActionsCard
            actions={[
              {
                key: 'undo-opening',
                title: 'Undo the opening balances',
                explain: openUntil ? 'Removes everything typed here. The money entries since then stay.' : 'Open the Safety Lock first (Settings → Safety Locks).',
                button: 'Undo…',
                disabled: !openUntil,
                onOpen: () => setUndoOpen(true),
              },
            ]}
          />
        )}
        <ConfirmSheet
          isOpen={undoOpen}
          title="Undo the opening balances?"
          keepLabel="Keep"
          confirmLabel="Undo"
          danger
          onConfirm={undo}
          onClose={() => setUndoOpen(false)}
        >
          <p className="adm-csheet__text">The account balances, previous balances and what you owed on the start date are removed. Type UNDO.</p>
          <input className="form-input" value={undoText} onChange={(e) => setUndoText(e.target.value)} aria-label="Type UNDO" data-testid="opening-undo-input" />
        </ConfirmSheet>
      </section>
    );
  }

  const confirmButton = isAdmin ? (
    <button type="button" className="adm-btn adm-btn--primary" onClick={() => setConfirmOpen(true)} disabled={fileError !== null} data-testid="opening-confirm">
      Confirm
    </button>
  ) : undefined;

  return (
    <section className="inv money" aria-label="Opening balances">
      <AdminPageHeader title="Opening balances" onBack={onBack} primary={confirmButton} />
      <p className="inv-muted">Used once, on your start date. Nothing is saved until you tap Confirm.</p>

      <div className="adm-ocard inv-stack">
        <h2 className="adm-ocard__title">1. Start date</h2>
        {lotDate ? (
          <p className="inv-muted">
            <b>{dayText(lotDate)}</b> — the date of your opening stock (L-000). Everything uses this one date.
          </p>
        ) : (
          <>
            <input className="form-input" type="date" value={start} max={dhakaToday()} onChange={(e) => setStart(e.target.value)} aria-label="Start date" />
            <p className="inv-muted">The opening stock (L-000) is not uploaded yet. Use the same date for it later.</p>
          </>
        )}
      </div>

      <div className="adm-ocard inv-stack" data-testid="opening-accounts">
        <h2 className="adm-ocard__title">2. Accounts (as counted on the start date)</h2>
        {accounts.map((a) => (
          <label key={a.id} className="form-field">
            <span className="form-label">{a.name}</span>
            <input
              className="form-input"
              inputMode="decimal"
              value={amounts[a.id] ?? ''}
              onChange={(e) => setAmounts((prev) => ({ ...prev, [a.id]: e.target.value }))}
              placeholder="0"
              aria-label={`Opening balance of ${a.name}`}
            />
          </label>
        ))}
        <p className="inv-muted">
          With Steadfast: {steadfast === null ? 'not known yet' : moneyText(steadfast)} — taken from Steadfast&apos;s own balance when you confirm.
        </p>
        <div className="inv-line inv-line--total">
          <span>Accounts total</span>
          <b>{moneyText(accountsTotal)}</b>
        </div>
      </div>

      <div className="adm-ocard inv-stack" data-testid="opening-dues">
        <h2 className="adm-ocard__title">3. Customer dues (from Kaarbar)</h2>
        <p className="inv-muted">Download the template, fill it from Kaarbar (phone, name, due amount), upload it and check the preview.</p>
        <div className="inv-actions">
          <button type="button" className="adm-btn" onClick={() => void buildDuesTemplate().then((b) => saveBlob(b, 'opening-dues.xlsx'))} data-testid="opening-template">
            Download template
          </button>
          <label className="adm-btn">
            Upload filled file
            <input type="file" accept=".xlsx" hidden onChange={(e) => void upload(e.target.files?.[0] ?? null)} data-testid="opening-file" />
          </label>
        </div>
        {fileName && <p className="inv-muted">{fileName}</p>}
        {fileError && (
          <p className="inv-error" role="alert" data-testid="opening-file-error">
            {fileError}
          </p>
        )}
        {preview && (
          <div className="inv-stack" data-testid="opening-preview">
            <div className="inv-line">
              <span>Rows in the file</span>
              <span>{rows.length}</span>
            </div>
            <div className="inv-line">
              <span>Total in the file (match it with Kaarbar&apos;s "To Receive")</span>
              <b data-testid="opening-file-total">{moneyText(fileTotal)}</b>
            </div>
            <div className="inv-line">
              <span>Will be saved as previous balances</span>
              <b data-testid="opening-save-total">{moneyText(saveTotal)}</b>
            </div>
            <div className="inv-line">
              <span>Due on site orders now (all customers)</span>
              <span>{moneyText(preview.site_total_due)}</span>
            </div>

            {bad.length > 0 && (
              <div className="inv-issues inv-issues--bad" data-testid="opening-problems">
                <p>
                  <b>{bad.length} row{bad.length === 1 ? '' : 's'} with a problem</b> (fix the file and upload again)
                </p>
                {bad.map((r) => (
                  <p key={r.n}>
                    Row {r.n + 1}: {r.phone || '(no phone)'} — {r.problem}
                  </p>
                ))}
              </div>
            )}

            {clash.length > 0 && (
              <div className="inv-issues inv-issues--warn" data-testid="opening-clash">
                <p>
                  <b>Already has a due on the site ({clash.length})</b> — you may have entered some orders in both Kaarbar and the site. Choose per
                  row:
                </p>
                {clash.map((r) => (
                  <div key={r.n} className="inv-stack money-clash">
                    <p>
                      {r.name || r.site_name || r.phone} · {r.phone_key} — Kaarbar {moneyText(r.due ?? 0)}, site {moneyText(r.site_due)}
                    </p>
                    <select
                      className="form-input"
                      value={choices[r.n] ?? 'kaarbar'}
                      onChange={(e) => setChoices((prev) => ({ ...prev, [r.n]: e.target.value as DueChoice }))}
                      aria-label={`What to do with the due of ${r.phone_key}`}
                    >
                      {CHOICES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <p className="inv-muted">
                      Total due after confirming: {moneyText(r.site_due + openingDueAmount(r.due ?? 0, r.site_due, choices[r.n] ?? 'kaarbar'))}
                    </p>
                  </div>
                ))}
              </div>
            )}

            <p className="inv-muted">
              Matched to existing customers by phone: {good.length - fresh.length}. New customers (added to the Customers list): {fresh.length}.
            </p>
            {fresh.length > 0 && (
              <div className="inv-stack" data-testid="opening-new">
                {fresh.map((r) => (
                  <div key={r.n} className="inv-line">
                    <span>
                      New: {r.name || '(no name)'} · {r.phone_key}
                    </span>
                    <span>{moneyText(r.due ?? 0)}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="inv-muted">Customers will see only one line, "Previous balance ৳X" — no invoices, items or prices behind it.</p>
          </div>
        )}
      </div>

      <div className="adm-ocard inv-stack" data-testid="opening-payables">
        <h2 className="adm-ocard__title">4. What I owe (on the start date)</h2>
        {payables.map((p, i) => (
          <div key={i} className="inv-stack money-payable">
            <div className="inv-fields">
              <select
                className="form-input"
                value={p.kind}
                onChange={(e) => setPayables((list) => list.map((x, j) => (j === i ? { ...x, kind: e.target.value as OpeningPayableInput['kind'] } : x)))}
                aria-label="Owed to"
              >
                <option value="investor">Investor</option>
                <option value="supplier">Supplier</option>
                <option value="other">Other</option>
              </select>
              <input
                className="form-input"
                value={p.name}
                onChange={(e) => setPayables((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                placeholder="Name"
                aria-label="Name"
              />
            </div>
            <div className="inv-fields">
              <input
                className="form-input"
                inputMode="decimal"
                value={p.amount}
                onChange={(e) => setPayables((list) => list.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                placeholder="৳ amount"
                aria-label="Amount owed"
              />
              <input
                className="form-input"
                value={p.note}
                onChange={(e) => setPayables((list) => list.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                placeholder="Note"
                aria-label="Note"
              />
            </div>
          </div>
        ))}
        <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setPayables((list) => [...list, emptyPayable()])}>
          + Add a row
        </button>
        <div className="inv-line inv-line--total">
          <span>Total I owe (match it with Kaarbar&apos;s "To Give")</span>
          <b data-testid="opening-pay-total">{moneyText(payTotal)}</b>
        </div>
      </div>

      {error && (
        <p className="inv-error" role="alert" data-testid="opening-error">
          {error}
        </p>
      )}
      {!isAdmin && <p className="inv-muted">Only the Super Admin can confirm the opening balances.</p>}

      <ConfirmSheet
        isOpen={confirmOpen}
        title={`Confirm the opening balances for ${dayText(start)}?`}
        keepLabel="Not yet"
        confirmLabel="Confirm"
        onConfirm={confirm}
        onClose={() => setConfirmOpen(false)}
      >
        <p className="adm-csheet__text">
          Accounts {moneyText(accountsTotal)} · previous balances {moneyText(saveTotal)} ({good.length} customers) · I owe {moneyText(payTotal)}. This is
          done once; undoing it needs the Safety Lock.
        </p>
      </ConfirmSheet>
    </section>
  );
}
