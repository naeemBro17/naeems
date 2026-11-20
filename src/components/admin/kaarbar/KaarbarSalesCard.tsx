import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { checkCustomers } from '../../../lib/kaarbar/api';
import type { SiteMatch } from '../../../lib/kaarbar/parse';
import {
  billCounts,
  billImportRows,
  billKey,
  previewStatements,
  readStatement,
  spreadDiscount,
  unitNeeds,
  unitWord,
  type BillPreview,
  type SavedItem,
  type Statement,
} from '../../../lib/kaarbar/oldSales';
import { importSales, setUnitCosts, undoSales, type KeptBill, type OldSalesStatus } from '../../../lib/kaarbar/oldSalesApi';
import { readPdfText } from '../../../lib/kaarbar/statementPdf';
import { dayText, moneyText } from '../../../lib/money/format';
import { AdminIcon } from '../ui/AdminIcon';
import { importWhen, PasswordSheet } from './KaarbarImportTab';

interface LoadedFile {
  id: number;
  fileName: string;
  statement: Statement | null;
  error: string | null;
}

const BILLS_PAGE = 40;

function money2(n: number): string {
  return moneyText(Math.round(n * 100) / 100);
}

function qtyText(quantity: number, unit: string | null): string {
  return unit ? `${quantity} ${unit.toUpperCase()}` : String(quantity);
}

/**
 * Batch 50 Step 2: Kaarbar party statements (PDF, one per customer) →
 * old bills, history only. Nothing but the old-bill tables is written:
 * stock, lots, money accounts and dues stay exactly as they are.
 */
export function KaarbarSalesCard({ status, onChanged }: { status: OldSalesStatus; onChanged: () => Promise<void> }) {
  const { showToast } = useToast();
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [reading, setReading] = useState(0);
  const [site, setSite] = useState<Map<number, SiteMatch>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(BILLS_PAGE);
  const [unitInput, setUnitInput] = useState<Record<string, string>>({});
  const [savingUnits, setSavingUnits] = useState(false);
  const [sheet, setSheet] = useState<'import' | 'undo' | null>(null);
  const [kept, setKept] = useState<KeptBill[] | null>(null);
  const nextId = useRef(1);

  const locked = status.items.length === 0;
  const items = useMemo(() => new Map<string, SavedItem>(status.items.map((i) => [i.key, i])), [status.items]);
  const good = useMemo(() => files.filter((f): f is LoadedFile & { statement: Statement } => f.statement !== null), [files]);

  const previews = useMemo(
    () =>
      previewStatements(
        good.map((f) => ({ fileName: f.fileName, statement: f.statement })),
        { cutoff: status.cutoff, done: new Set(status.billKeys), items }
      ),
    [good, status.cutoff, status.billKeys, items]
  );
  const counts = useMemo(() => billCounts(previews), [previews]);
  const allBills = useMemo(() => previews.flatMap((p) => p.bills), [previews]);
  const needs = useMemo(() => unitNeeds(allBills, items, status.choices), [allBills, items, status.choices]);
  const unknownNames = useMemo(() => [...new Set(allBills.flatMap((b) => b.unknown))].sort(), [allBills]);
  const mismatched = previews.filter((p) => !p.matches);
  const customers = useMemo(() => new Map(previews.map((p) => [p.file, site.get(good[p.file]?.id ?? -1)?.siteKey ?? null])), [previews, site, good]);
  const toImport = useMemo(() => billImportRows(previews, items, customers), [previews, items, customers]);
  const importTotal = toImport.reduce((s, b) => s + (b.kind === 'return' ? -b.bill_total : b.bill_total), 0);

  // Worked-out prices per piece / per ml start in the boxes.
  useEffect(() => {
    setUnitInput((old) => {
      const next = { ...old };
      for (const n of needs) {
        const k = `${n.itemId}:${n.unit}`;
        if (next[k] === undefined && n.suggested !== null) next[k] = String(n.suggested);
      }
      return next;
    });
  }, [needs]);

  // Who each statement is on the site (same phone / name rule as Batch 49).
  useEffect(() => {
    const ask = good.filter((f) => !site.has(f.id));
    if (ask.length === 0) return;
    let alive = true;
    void checkCustomers(ask.map((f) => ({ n: f.id, phone_key: f.statement.phoneKey, name: f.statement.partyName }))).then((answer) => {
      if (!alive || !answer.ok) return;
      setSite((old) => {
        const next = new Map(old);
        for (const f of ask) next.set(f.id, answer.data.get(f.id) ?? { siteKey: null, siteName: null, siteDue: 0 });
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [good, site]);

  const add = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setKept(null);
    const picked = Array.from(list);
    setReading(picked.length);
    const read: LoadedFile[] = [];
    for (const file of picked) {
      const id = nextId.current++;
      try {
        const result = readStatement(await readPdfText(file));
        read.push({ id, fileName: file.name, statement: result.statement, error: result.error });
      } catch (e) {
        read.push({ id, fileName: file.name, statement: null, error: e instanceof Error ? e.message : 'Could not read the file.' });
      }
      setReading((n) => n - 1);
    }
    setFiles((old) => [...old, ...read]);
    setReading(0);
  };

  const remove = (id: number) => setFiles((old) => old.filter((f) => f.id !== id));

  const unitRows = needs.map((n) => {
    const raw = (unitInput[`${n.itemId}:${n.unit}`] ?? '').replace(/[৳,\s]/g, '');
    const cost = raw === '' ? null : Number(raw);
    return { need: n, cost: cost !== null && Number.isFinite(cost) && cost > 0 ? cost : null };
  });

  const saveUnits = async () => {
    const ready = unitRows.filter((r) => r.cost !== null).map((r) => ({ item_id: r.need.itemId, unit: r.need.unit, cost: r.cost ?? 0 }));
    if (ready.length === 0) return;
    setSavingUnits(true);
    const answer = await setUnitCosts(ready);
    setSavingUnits(false);
    if (!answer.ok) {
      showToast(answer.error, 'error');
      return;
    }
    showToast(`Saved ${answer.data} price${answer.data === 1 ? '' : 's'}`);
    await onChanged();
  };

  const blockers: string[] = [];
  if (mismatched.length > 0) blockers.push(`${mismatched.length} file${mismatched.length === 1 ? '' : 's'} do${mismatched.length === 1 ? 'es' : ''} not match Kaarbar — remove ${mismatched.length === 1 ? 'it' : 'them'} first.`);
  if (counts.unknown > 0) blockers.push(`${unknownNames.length} unknown item${unknownNames.length === 1 ? '' : 's'}.`);
  if (needs.length > 0) blockers.push(`${needs.length} price${needs.length === 1 ? '' : 's'} per piece / per ml to save.`);
  if (counts.bad > 0) blockers.push(`${counts.bad} bill${counts.bad === 1 ? '' : 's'} could not be read.`);
  if (files.some((f) => f.error)) blockers.push('Remove the files that could not be read.');
  const canImport = toImport.length > 0 && blockers.length === 0 && reading === 0;

  const doImport = async (): Promise<string | null> => {
    const answer = await importSales(toImport);
    if (!answer.ok) return answer.error;
    setSheet(null);
    showToast(`Imported ${answer.data.added} old bill${answer.data.added === 1 ? '' : 's'}`);
    await onChanged();
    return null;
  };

  const doUndo = async (): Promise<string | null> => {
    const answer = await undoSales();
    if (!answer.ok) return answer.error;
    setSheet(null);
    setKept(answer.data.kept);
    showToast(`Removed ${answer.data.removed} old bill${answer.data.removed === 1 ? '' : 's'}`);
    await onChanged();
    return null;
  };

  const cutoffText = dayText(status.cutoff);
  const last = status.lastSales;
  const listed = allBills.filter((b) => b.status !== 'after');

  return (
    <section className={`adm-ocard kb-card${locked ? ' kb-card--off' : ''}`} aria-label="Step 2 · Old sales" data-testid="kb-sales">
      <h2 className="kb-card__title">Step 2 · Old sales</h2>
      {locked ? (
        <p className="inv-muted" data-testid="kb-sales-locked">
          Save the product list in Step 1 first.
        </p>
      ) : (
        <>
          <p className="inv-muted">
            From Kaarbar: a customer → Party Statement → PDF. Pick many at once; you can add more later. Bills on or before {cutoffText} are
            added; later ones are already on the site as orders.
          </p>
          <label className="adm-btn kb-file">
            {reading > 0 ? `Reading… (${reading} left)` : files.length > 0 ? 'Add more PDFs' : 'Pick party statements (PDF)'}
            <input
              type="file"
              accept="application/pdf,.pdf"
              multiple
              hidden
              onChange={(e) => {
                void add(e.target.files);
                e.target.value = '';
              }}
              data-testid="kb-sales-file"
            />
          </label>

          {files.filter((f) => f.error).map((f) => (
            <div key={f.id} className="kb-notice kb-notice--row" role="alert" data-testid="kb-sales-file-error">
              <span>
                <b>{f.fileName}</b>: {f.error}
              </span>
              <button type="button" className="adm-btn adm-btn--sm adm-btn--ghost" onClick={() => remove(f.id)}>
                Remove
              </button>
            </div>
          ))}

          {previews.length > 0 && (
            <div className="inv-stack" data-testid="kb-sales-preview">
              <ul className="kb-list" data-testid="kb-statements">
                {previews.map((p) => {
                  const f = good[p.file];
                  const who = site.get(f.id);
                  const toAddTotal = p.bills.filter((b) => b.status === 'new').reduce((s, b) => s + (b.kind === 'return' ? -b.total : b.total), 0);
                  return (
                    <li key={f.id} className="kb-row kb-row--stack" data-testid="kb-statement-row">
                      <span className="kb-stmt__top">
                        <span className="kb-row__main">
                          <span className="kb-row__name">{p.statement.partyName || p.fileName}</span>
                          <span className="kb-row__sub">
                            {p.statement.phoneKey ?? (p.statement.phone || 'No phone')} ·{' '}
                            {who === undefined ? 'checking…' : who.siteKey ? 'on the site' : 'not on the site'}
                          </span>
                        </span>
                        <button type="button" className="adm-btn adm-btn--sm adm-btn--ghost" onClick={() => remove(f.id)} aria-label={`Remove ${p.fileName}`}>
                          Remove
                        </button>
                      </span>
                      <span className="kb-row__sub">
                        {p.toAdd > 0
                          ? `${p.toAdd} bill${p.toAdd === 1 ? '' : 's'} to add · ${moneyText(toAddTotal)}`
                          : `0 bills${p.after > 0 ? ` — ${p.after} after ${cutoffText}, skipped` : ''}`}
                      </span>
                      {p.matches ? (
                        <span className="kb-check-ok" data-testid="kb-statement-ok">
                          <AdminIcon name="check" className="adm-icon--sm" /> matches Kaarbar
                        </span>
                      ) : (
                        <span className="kb-check-bad" role="alert" data-testid="kb-statement-bad">
                          Does not match Kaarbar ({moneyText(p.fileTotal)} vs {p.statement.headerTotal === null ? 'no Total Sales' : moneyText(p.statement.headerTotal)})
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>

              <ul className="kb-counts" aria-label="Bills">
                <li className="kb-counts__item" data-testid="kb-scount-new">
                  <span>Bills to add</span>
                  <b>{counts.toAdd}</b>
                </li>
                <li className="kb-counts__item" data-testid="kb-scount-already">
                  <span>Already added</span>
                  <b>{counts.already}</b>
                </li>
                <li className="kb-counts__item" data-testid="kb-scount-after">
                  <span>After {cutoffText.replace(/ \d{4}$/, '')} (skip)</span>
                  <b>{counts.after}</b>
                </li>
                <li className="kb-counts__item" data-testid="kb-scount-unknown">
                  <span>Unknown item</span>
                  <b>{counts.unknown}</b>
                </li>
              </ul>

              {unknownNames.length > 0 && (
                <div className="kb-notice" data-testid="kb-sales-unknown">
                  <b>Unknown items — add them to the Item List in Step 1:</b>
                  <ul>
                    {unknownNames.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}

              {needs.length > 0 && (
                <div className="kb-fold kb-units" data-testid="kb-sales-units">
                  <p className="kb-sub">Needs a price per piece / per ml</p>
                  <p className="inv-muted">These were sold by the piece or by the ml. Type what one cost you; it is saved in the Step 1 list.</p>
                  <ul className="kb-list">
                    {unitRows.map(({ need: n, cost }) => {
                      const k = `${n.itemId}:${n.unit}`;
                      return (
                        <li key={k} className="kb-row kb-row--stack" data-testid="kb-unit-row">
                          <span className="kb-row__name">{n.itemName}</span>
                          <label className="kb-price">
                            <span className="kb-price__label">Buying price of 1 {unitWord(n.unit)}</span>
                            <input
                              className={`form-input kb-price__input${cost === null ? ' kb-price__input--missing' : ''}`}
                              inputMode="decimal"
                              value={unitInput[k] ?? ''}
                              placeholder="৳"
                              onChange={(e) => setUnitInput((old) => ({ ...old, [k]: e.target.value }))}
                              aria-label={`Buying price of 1 ${unitWord(n.unit)} of ${n.itemName}`}
                              data-testid="kb-unit-price"
                            />
                          </label>
                          <span className="kb-row__sub">
                            {n.suggested !== null ? 'Worked out from the pack size on the site. ' : ''}Sold for up to {money2(n.maxRate)} per {unitWord(n.unit)}.
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <button
                    type="button"
                    className="adm-btn"
                    disabled={savingUnits || unitRows.every((r) => r.cost === null)}
                    onClick={() => void saveUnits()}
                    data-testid="kb-unit-save"
                  >
                    {savingUnits ? <span className="spinner" aria-hidden="true" /> : 'Save these prices'}
                  </button>
                </div>
              )}

              {listed.length > 0 && <p className="kb-sub">Bills</p>}
              <ul className="kb-list" data-testid="kb-bills">
                {listed.slice(0, shown).map((b) => (
                  <BillRow
                    key={`${b.file}:${billKey(b)}`}
                    bill={b}
                    party={previews[b.file]?.statement.partyName ?? ''}
                    isOpen={open === `${b.file}:${billKey(b)}`}
                    onToggle={() => setOpen((o) => (o === `${b.file}:${billKey(b)}` ? null : `${b.file}:${billKey(b)}`))}
                  />
                ))}
              </ul>
              {listed.length > shown && (
                <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setShown((s) => s + BILLS_PAGE)}>
                  Show {Math.min(BILLS_PAGE, listed.length - shown)} more
                </button>
              )}
            </div>
          )}

          <p className="kb-notice kb-notice--plain" data-testid="kb-sales-note">
            Nothing else changes: stock, lots, Cash / bKash and customer dues stay as they are. These bills only appear in Profit &amp; loss and in
            each customer&apos;s history.
          </p>
        </>
      )}

      {kept && kept.length > 0 && (
        <div className="kb-notice" data-testid="kb-sales-kept">
          <b>Kept {kept.length} bill{kept.length === 1 ? '' : 's'} in locked months:</b>
          <ul>
            {kept.map((k) => (
              <li key={k.bill_no}>
                {k.bill_no} · {dayText(k.date)} · {moneyText(k.amount)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="adm-careful kb-careful" aria-label="Careful actions" data-testid="kb-sales-careful">
        <h3 className="adm-careful__title">Careful actions</h3>
        <p className="adm-ocard__muted">You will be asked for your password.</p>
        <ul className="adm-careful__list">
          <li className="adm-careful__row">
            <span className="adm-careful__text">
              <span className="adm-careful__name">Import {toImport.length} bills</span>
              <span className="adm-careful__explain" data-testid="kb-sales-import-note">
                {blockers.length > 0 ? blockers.join(' ') : toImport.length > 0 ? `${moneyText(importTotal)} in old sales. Bills already added are skipped.` : 'No bill to add yet.'}
              </span>
            </span>
            <button
              type="button"
              className="adm-btn adm-btn--sm kb-go"
              disabled={locked || !canImport}
              onClick={() => setSheet('import')}
              data-testid="kb-sales-import"
            >
              Import {toImport.length} bills…
            </button>
          </li>
          <li className="adm-careful__row">
            <span className="adm-careful__text">
              <span className="adm-careful__name">Undo last old-sales import</span>
              <span className="adm-careful__explain">
                {last ? `${importWhen(last.at)}: ${last.count} bills (${moneyText(last.total)}). Only the bills of that import are removed.` : 'No old-sales import yet.'}
              </span>
            </span>
            <button
              type="button"
              className="adm-btn adm-btn--sm adm-careful__btn adm-careful__btn--red"
              disabled={!last}
              onClick={() => setSheet('undo')}
              data-testid="kb-sales-undo"
            >
              Undo…
            </button>
          </li>
        </ul>
      </section>

      <PasswordSheet
        isOpen={sheet === 'import'}
        title={`Import ${toImport.length} old bills?`}
        text={`${moneyText(importTotal)} in old Kaarbar sales, dated on or before ${cutoffText}. They are history only: stock, lots, Cash / bKash and customer dues do not change.`}
        confirmLabel="Import"
        onConfirm={doImport}
        onClose={() => setSheet(null)}
      />
      <PasswordSheet
        isOpen={sheet === 'undo'}
        title="Undo the last old-sales import?"
        text={last ? `Removes the ${last.count} bills imported ${importWhen(last.at)}. Nothing else changes.` : ''}
        confirmLabel="Undo import"
        danger
        onConfirm={doUndo}
        onClose={() => setSheet(null)}
      />
    </section>
  );
}

const STATUS_TEXT: Record<BillPreview['status'], string> = {
  new: 'To add',
  already: 'Already added',
  after: 'After the cut-off',
  unknown: 'Unknown item',
  bad: 'Not readable',
};

function BillRow({ bill: b, party, isOpen, onToggle }: { bill: BillPreview; party: string; isOpen: boolean; onToggle: () => void }) {
  const products = b.lines.filter((l) => !l.isDelivery);
  const shares = spreadDiscount(products.map((l) => l.total), b.billDiscount);
  const sign = b.kind === 'return' ? '−' : '';
  return (
    <li className="kb-bill" data-testid="kb-bill-row" data-status={b.status}>
      <button type="button" className="kb-bill__head" onClick={onToggle} aria-expanded={isOpen}>
        <span className="kb-row__main">
          <span className="kb-row__name">
            {b.kind === 'return' ? 'Return' : 'Bill'} {b.billNo}
          </span>
          <span className="kb-row__sub">
            {b.date ? dayText(b.date) : 'no date'} · {party}
          </span>
        </span>
        <span className="kb-bill__right">
          <b className="kb-bill__total">
            {sign}
            {moneyText(b.total)}
          </b>
          <span className={`kb-tag kb-tag--${b.status}`}>{b.status === 'unknown' ? `${STATUS_TEXT.unknown}: ${b.unknown.length}` : STATUS_TEXT[b.status]}</span>
        </span>
      </button>
      {isOpen && (
        <div className="kb-bill__body" data-testid="kb-bill-lines">
          {/* Batch 54: why a bill can't be imported (e.g. it doesn't add up). */}
          {b.status === 'bad' && (
            <p className="kb-check-bad" role="alert" data-testid="kb-bill-problem">
              {b.reason}
            </p>
          )}
          {products.map((l, i) => (
            <div key={`${l.key}-${i}`} className="kb-bill__line">
              <span className="kb-row__main">
                <span className="kb-bill__item">{l.name}</span>
                <span className="kb-row__sub">
                  {qtyText(l.quantity, l.unit)} × {money2(l.rate)}
                  {l.discount > 0 ? ` − ${money2(l.discount)}` : ''}
                  {shares[i] > 0 ? ` · after bill discount ${money2(l.total - shares[i])}` : ''}
                </span>
              </span>
              <span className="kb-bill__amount">{money2(l.total)}</span>
            </div>
          ))}
          {b.delivery !== 0 && (
            <div className="kb-bill__line">
              <span className="kb-bill__item">Delivery charge</span>
              <span className="kb-bill__amount">{money2(b.delivery)}</span>
            </div>
          )}
          {b.billDiscount !== 0 && (
            <div className="kb-bill__line" data-testid="kb-bill-discount">
              <span className="kb-bill__item">Bill discount</span>
              <span className="kb-bill__amount">−{money2(b.billDiscount)}</span>
            </div>
          )}
          <div className="kb-bill__line kb-bill__line--total">
            <span>Bill total</span>
            <b>
              {sign}
              {money2(b.total)}
            </b>
          </div>
        </div>
      )}
    </li>
  );
}
