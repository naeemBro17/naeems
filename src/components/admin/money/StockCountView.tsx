import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { fetchStockUnits, packsText, unitName } from '../../../lib/inventory/api';
import type { StockUnit, StockUnitWord } from '../../../lib/inventory/types';
import { dayText, moneyText, monthText } from '../../../lib/money/format';
import type { LoadState } from '../../../lib/payouts';
import { fetchCountHistory, fetchCountPlan, saveCounts } from '../../../lib/reports/api';
import { countedUnits, countWhyText, differenceText } from '../../../lib/reports/count';
import type { CountHistoryRow, CountInput, CountPlan } from '../../../lib/reports/types';
import { AdminPageHeader, AdminSearch, EmptyState, SkeletonRows } from '../ui/AdminUi';

interface Typed {
  packs: string;
  loose: string;
}

function CountInputs({
  id,
  unit,
  packSize,
  value,
  onChange,
}: {
  id: string;
  unit: StockUnitWord;
  packSize: number;
  value: Typed;
  onChange: (v: Typed) => void;
}) {
  if (packSize <= 1) {
    return (
      <label className="form-field count-input">
        <span className="form-label">I counted ({unit})</span>
        <input
          className="form-input"
          inputMode="numeric"
          value={value.packs}
          onChange={(e) => onChange({ packs: e.target.value, loose: '' })}
          data-testid={`count-input-${id}`}
          aria-label="I counted"
        />
      </label>
    );
  }
  return (
    <div className="inv-fields count-input">
      <label className="form-field">
        <span className="form-label">Packs of {packSize}</span>
        <input className="form-input" inputMode="numeric" value={value.packs} onChange={(e) => onChange({ ...value, packs: e.target.value })} data-testid={`count-input-${id}`} aria-label="Packs counted" />
      </label>
      <label className="form-field">
        <span className="form-label">+ loose {unit}</span>
        <input className="form-input" inputMode="numeric" value={value.loose} onChange={(e) => onChange({ ...value, loose: e.target.value })} aria-label="Loose units counted" />
      </label>
    </div>
  );
}

/**
 * Batch 42 Part 3.1: the monthly stock count. The system picks 15–20
 * products each month (every product counted at least once in about 6
 * months; expensive and fast-selling products more often). Type what you
 * counted; less than the system says becomes a write-off "Count difference",
 * more goes back into the newest lot. Any product can be counted any time.
 */
export function StockCountView({ onBack }: { onBack: () => void }) {
  const { showToast } = useToast();
  const [plan, setPlan] = useState<LoadState<CountPlan> | null>(null);
  const [history, setHistory] = useState<CountHistoryRow[]>([]);
  const [units, setUnits] = useState<StockUnit[]>([]);
  const [typed, setTyped] = useState<Record<string, Typed>>({});
  const [extra, setExtra] = useState<StockUnit[]>([]);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, h, u] = await Promise.all([fetchCountPlan(), fetchCountHistory(30), fetchStockUnits()]);
    setPlan(p);
    setHistory(h.kind === 'ready' ? h.data : []);
    setUnits(u.kind === 'ready' ? u.data : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const data = plan?.kind === 'ready' ? plan.data : null;
  const keyOf = (productId: string, variantId: string | null) => `${productId}:${variantId ?? ''}`;

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    const inPlan = new Set((data?.rows ?? []).map((r) => keyOf(r.product_id, r.variant_id)));
    const added = new Set(extra.map((u) => keyOf(u.product_id, u.variant_id)));
    return units
      .filter((u) => !inPlan.has(keyOf(u.product_id, u.variant_id)) && !added.has(keyOf(u.product_id, u.variant_id)))
      .filter((u) => unitName(u).toLowerCase().includes(q) || u.sku.toLowerCase().includes(q))
      .slice(0, 8);
  }, [search, units, data, extra]);

  const rows = useMemo(() => {
    const planned = (data?.rows ?? []).map((r) => ({
      key: keyOf(r.product_id, r.variant_id),
      product_id: r.product_id,
      variant_id: r.variant_id,
      label: r.label,
      unit: r.stock_unit as StockUnitWord,
      pack: Math.max(1, r.pack_size),
      system: r.system_units,
      why: countWhyText(r.why),
      done: r.counted ? { units: r.counted_units ?? 0, diff: r.difference ?? 0, date: r.counted_date } : null,
      last: r.last_count,
    }));
    const added = extra.map((u) => ({
      key: keyOf(u.product_id, u.variant_id),
      product_id: u.product_id,
      variant_id: u.variant_id,
      label: unitName(u),
      unit: u.stock_unit,
      pack: Math.max(1, u.pack_size),
      system: u.lot_pieces_left,
      why: 'Added by you',
      done: null,
      last: null,
    }));
    return [...planned, ...added];
  }, [data, extra]);

  const ready: CountInput[] = rows
    .map((r) => {
      const v = typed[r.key];
      const n = v ? countedUnits(v.packs, v.loose, r.pack) : null;
      return n === null ? null : { product_id: r.product_id, variant_id: r.variant_id, counted: n };
    })
    .filter((r): r is CountInput => r !== null);

  const save = async () => {
    setError(null);
    if (ready.length === 0) {
      setError('Type at least one count.');
      return;
    }
    setSaving(true);
    const answer = await saveCounts(ready);
    setSaving(false);
    if (!answer.ok) {
      setError(answer.error ?? 'Could not save the count.');
      return;
    }
    const diffs = (answer.data ?? []).filter((r) => r.difference !== 0).length;
    showToast(`Saved ${ready.length} count${ready.length === 1 ? '' : 's'}${diffs > 0 ? ` · ${diffs} difference${diffs === 1 ? '' : 's'} recorded` : ' · no differences'}`);
    setTyped({});
    setExtra([]);
    await load();
  };

  const counted = (data?.rows ?? []).filter((r) => r.counted).length;
  const saveButton = (
    <button type="button" className="adm-btn adm-btn--primary" onClick={() => void save()} disabled={saving || !data?.inventory_mode || ready.length === 0} data-testid="count-save">
      {saving ? 'Saving…' : ready.length > 0 ? `Save ${ready.length} count${ready.length === 1 ? '' : 's'}` : 'Save counts'}
    </button>
  );

  return (
    <section className="inv money" aria-label="Monthly stock count">
      <AdminPageHeader title="Monthly stock count" onBack={onBack} primary={saveButton} />
      {plan === null ? (
        <SkeletonRows rows={6} thumb={false} />
      ) : !data ? (
        <EmptyState icon="alert" title="Could not load" hint={plan.kind === 'error' ? plan.message : 'The Batch 42 database step has not been run.'} />
      ) : (
        <>
          {!data.inventory_mode && (
            <div className="adm-ocard inv-stack" data-testid="count-mode-off">
              <p className="inv-mode__title">Inventory mode is Off</p>
              <p className="inv-muted">The count compares with the units in your lots, so it works once Inventory mode is On. You can look at the list now.</p>
            </div>
          )}
          <p className="inv-muted" data-testid="count-progress">
            {monthText(data.month.slice(0, 7))}: {counted} of {data.rows.length} counted. Count each one on the shelf and type what you see; the
            difference is recorded when you save.
          </p>
          {data.rows.length === 0 && extra.length === 0 && <p className="inv-muted">No stock in lots yet, so there is nothing to count this month.</p>}

          <ul className="count-list" data-testid="count-list">
            {rows.map((r) => (
              <li key={r.key} className="adm-ocard count-row" data-testid="count-row">
                <div className="count-row__head">
                  <b>{r.label}</b>
                  <span className="inv-muted">{r.why}</span>
                </div>
                <p className="count-row__system">
                  System says <b data-testid="count-system">{packsText(r.system, r.unit, r.pack)}</b>
                  {r.pack > 1 ? ` (${r.system} ${r.unit})` : ` ${r.unit}`}
                  {r.last ? <span className="inv-muted"> · last counted {dayText(r.last)}</span> : null}
                </p>
                {r.done ? (
                  <p className={r.done.diff === 0 ? 'inv-ok' : 'inv-bad'} data-testid="count-done">
                    Counted {r.done.units} {r.unit} on {dayText(r.done.date)} — {differenceText(r.done.diff, r.unit)}
                  </p>
                ) : (
                  <CountInputs
                    id={r.key}
                    unit={r.unit}
                    packSize={r.pack}
                    value={typed[r.key] ?? { packs: '', loose: '' }}
                    onChange={(v) => setTyped((t) => ({ ...t, [r.key]: v }))}
                  />
                )}
                {!r.done && typed[r.key] && countedUnits(typed[r.key].packs, typed[r.key].loose, r.pack) !== null && (
                  <p className="inv-muted" data-testid="count-preview">
                    {differenceText((countedUnits(typed[r.key].packs, typed[r.key].loose, r.pack) ?? 0) - r.system, r.unit)}
                  </p>
                )}
              </li>
            ))}
          </ul>

          <h2 className="inv-section">Count another product</h2>
          <AdminSearch value={search} onChange={setSearch} placeholder="Search a product to count" label="Search a product to count" />
          {matches.length > 0 && (
            <ul className="rep-list">
              {matches.map((u) => (
                <li key={keyOf(u.product_id, u.variant_id)}>
                  <button
                    type="button"
                    className="rep-list__row"
                    onClick={() => {
                      setExtra((x) => [...x, u]);
                      setSearch('');
                    }}
                  >
                    <span>{unitName(u)}</span>
                    <span className="inv-muted">{packsText(u.lot_pieces_left, u.stock_unit, u.pack_size)} in lots</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && (
            <p className="inv-error" role="alert" data-testid="count-error">
              {error}
            </p>
          )}

          {history.length > 0 && (
            <>
              <h2 className="inv-section">Recent counts</h2>
              <ul className="rep-list" data-testid="count-history">
                {history.map((h) => (
                  <li key={h.id} className="rep-list__item">
                    <span>
                      <b>{h.label}</b>
                      <span className="inv-muted"> · {dayText(h.count_date)} · system {h.system_units}, counted {h.counted_units}</span>
                    </span>
                    <span className={h.difference === 0 ? 'inv-muted' : 'money-out'}>
                      {differenceText(h.difference, h.stock_unit)}
                      {h.cost !== null && h.difference !== 0 ? ` (${moneyText(Math.abs(h.cost))})` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
