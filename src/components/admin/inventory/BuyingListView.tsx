import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { moneyText } from '../../../lib/money/format';
import type { LoadState } from '../../../lib/payouts';
import { buildWorkbook, downloadBlob, excelFileName } from '../../../lib/reports/excel';
import { fetchBuyingRows } from '../../../lib/smart/api';
import {
  BUYING_DEFAULTS,
  buyingLines,
  buyingSheet,
  buyingTotal,
  lineMoney,
  packsFor,
  sourceName,
  type BuyingSource,
} from '../../../lib/smart/buying';
import { unitsText } from '../../../lib/smart/speed';
import type { BuyingRowsAnswer } from '../../../lib/smart/types';
import { AdminPageHeader, ChipRow, EmptyState, SkeletonRows } from '../ui/AdminUi';
import '../../../styles/adminReports.css';
import '../../../styles/adminSmart.css';

function wholeNumber(raw: string, fallback: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Batch 43 Part 2: the next-trip buying list. Pick where you buy (a supplier
 * or a country from the lists), when the stock arrives and how long it must
 * last; each product usually bought there gets a suggestion in whole packs
 * (src/lib/smart/buying.ts) that can be changed before the Excel download.
 */
export function BuyingListView({ onBack }: { onBack: () => void }) {
  const { showToast } = useToast();
  const [state, setState] = useState<LoadState<BuyingRowsAnswer> | null>(null);
  const [kind, setKind] = useState<'supplier' | 'country'>('supplier');
  const [pick, setPick] = useState('');
  const [weeksInput, setWeeksInput] = useState(String(BUYING_DEFAULTS.weeks));
  const [monthsInput, setMonthsInput] = useState(String(BUYING_DEFAULTS.months));
  const [typed, setTyped] = useState<Map<string, number>>(new Map());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchBuyingRows().then(setState);
  }, []);

  const data = state?.kind === 'ready' ? state.data : null;
  const source: BuyingSource | null = pick ? (kind === 'supplier' ? { kind, id: pick } : { kind, name: pick }) : null;
  const settings = { weeks: wholeNumber(weeksInput, BUYING_DEFAULTS.weeks), months: wholeNumber(monthsInput, BUYING_DEFAULTS.months) };
  const lines = useMemo(
    () => (data ? buyingLines(data.rows, source, settings) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, kind, pick, settings.weeks, settings.months]
  );
  const total = buyingTotal(lines, typed);
  const toBuy = lines.filter((l) => packsFor(l, typed) > 0).length;
  const name = data ? sourceName(source, data.suppliers) : '';

  const setPacks = (key: string, raw: string) => {
    setTyped((prev) => {
      const next = new Map(prev);
      if (raw.trim() === '') next.delete(key);
      else next.set(key, wholeNumber(raw, 0));
      return next;
    });
  };

  const download = async () => {
    if (!data || !source) return;
    setBusy(true);
    try {
      const blob = await buildWorkbook([buyingSheet(lines, typed, name, settings, data.today)]);
      downloadBlob(blob, excelFileName(`buying list ${name}`, data.today, data.today));
    } catch {
      showToast('Could not make the Excel file. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const excel = (
    <button type="button" className="adm-btn adm-btn--primary" disabled={!source || toBuy === 0 || busy} onClick={download} data-testid="buying-excel">
      {busy ? 'Making…' : 'Download Excel'}
    </button>
  );

  return (
    <section className="inv smart" aria-label="Buying list">
      <AdminPageHeader title="Buying list" onBack={onBack} primary={excel} />
      <p className="inv-muted">
        Suggested units = sales a month × (weeks until the stock arrives + months to keep it) − units left − units on the way
        (lots marked &ldquo;costs pending&rdquo; with a later date), rounded up to whole packs. Products with no sale in 120 days are skipped.
      </p>
      {data && !data.inventory_mode && (
        <p className="smart-note" data-testid="buying-mode-note">
          Inventory mode is Off, so no sale is taken from lots yet and every product shows as not moving. The list becomes
          useful once Inventory mode is On.
        </p>
      )}

      {state === null ? (
        <SkeletonRows rows={4} thumb={false} />
      ) : state.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load" hint={state.kind === 'error' ? state.message : 'The Batch 43 database step has not been run.'} />
      ) : (
        <>
          <div className="adm-ocard smart-form">
            <ChipRow
              label="Buy from"
              active={kind}
              onSelect={(id) => {
                setKind(id as 'supplier' | 'country');
                setPick('');
                setTyped(new Map());
              }}
              chips={[
                { id: 'supplier', label: 'Supplier' },
                { id: 'country', label: 'Country' },
              ]}
            />
            <label className="form-field">
              <span className="form-label">{kind === 'supplier' ? 'Supplier' : 'Country'}</span>
              <select
                className="form-input"
                value={pick}
                onChange={(e) => {
                  setPick(e.target.value);
                  setTyped(new Map());
                }}
                data-testid="buying-source"
              >
                <option value="">Choose…</option>
                {kind === 'supplier'
                  ? state.data.suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.country ? ` (${s.country})` : ''}
                      </option>
                    ))
                  : state.data.countries.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
              </select>
            </label>
            <div className="smart-pair">
              <label className="form-field">
                <span className="form-label">Next stock arrives in about (weeks)</span>
                <input className="form-input" type="number" min="0" step="1" inputMode="numeric" value={weeksInput} onChange={(e) => setWeeksInput(e.target.value)} data-testid="buying-weeks" />
              </label>
              <label className="form-field">
                <span className="form-label">Keep stock for (months after it arrives)</span>
                <input className="form-input" type="number" min="0" step="1" inputMode="numeric" value={monthsInput} onChange={(e) => setMonthsInput(e.target.value)} data-testid="buying-months" />
              </label>
            </div>
          </div>

          {!source ? (
            <EmptyState icon="restock" title="Choose where you buy" hint="The products you usually buy there appear here." />
          ) : lines.length === 0 ? (
            <EmptyState icon="restock" title="No products from here yet" hint="Products appear once a purchase lot from this supplier or country is saved." />
          ) : (
            <>
              <div className="rep-stats smart-total">
                <div className="rep-stat">
                  <span className="rep-stat__label">Estimated money needed</span>
                  <span className="rep-stat__value" data-testid="buying-total">
                    {moneyText(total)}
                  </span>
                </div>
                <div className="rep-stat">
                  <span className="rep-stat__label">Products to buy</span>
                  <span className="rep-stat__value" data-testid="buying-count">
                    {toBuy}
                  </span>
                </div>
              </div>
              <div className="inv-stack" data-testid="buying-list">
                {lines.map((l) => {
                  const packs = packsFor(l, typed);
                  const pack = Math.max(l.row.pack_size, 1);
                  return (
                    <div key={l.key} className={`inv-item${l.skip ? ' smart-skip' : ''}`} data-testid="buying-row" data-key={l.key}>
                      <div className="inv-item__head">
                        <span className="inv-item__name">{l.row.label}</span>
                        {l.skip && <span className="smart-badge smart-badge--grey">Skip — not moving</span>}
                      </div>
                      <p className="smart-reason" data-testid="buying-note">
                        {l.note}
                      </p>
                      <div className="inv-line">
                        <span>Last landed cost{pack > 1 ? ` (pack of ${unitsText(pack, l.row.stock_unit)})` : ''}</span>
                        <span>{moneyText(l.packCost)}</span>
                      </div>
                      <div className="inv-line">
                        <span>Suggested</span>
                        <span>
                          {l.packs} {pack > 1 ? 'packs' : 'units'}
                        </span>
                      </div>
                      <div className="smart-packs">
                        <label className="form-field">
                          <span className="form-label">Buy ({pack > 1 ? 'packs' : 'units'})</span>
                          <input
                            className="form-input"
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            value={typed.has(l.key) ? String(typed.get(l.key)) : String(l.packs)}
                            onChange={(e) => setPacks(l.key, e.target.value)}
                            aria-label={`Buy ${l.row.label}`}
                            data-testid="buying-packs"
                          />
                        </label>
                        <span className="smart-packs__money" data-testid="buying-money">
                          {moneyText(lineMoney(l, packs))}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
