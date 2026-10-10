import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { normalizeText } from '../../../lib/format';
import { fetchStockUnits, setWeight, unitName } from '../../../lib/inventory/api';
import type { StockUnit } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { AdminPageHeader, AdminSearch, ChipRow, EmptyState, SkeletonRows } from '../ui/AdminUi';

const unitId = (u: StockUnit) => `${u.product_id}:${u.variant_id ?? ''}`;

/**
 * Batch 38 Part 3: products with no weight (no size found in the name or
 * size field), with a quick inline edit. "All products" shows every weight
 * so a wrong estimate can be corrected too. A typed weight is saved as
 * 'manual' and the estimate never overwrites it again.
 */
export function NeedsWeightView({ onBack }: { onBack: () => void }) {
  const { showToast } = useToast();
  const [units, setUnits] = useState<LoadState<StockUnit[]> | null>(null);
  const [filter, setFilter] = useState<'missing' | 'all'>('missing');
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => setUnits(await fetchStockUnits()), []);
  useEffect(() => {
    void load();
  }, [load]);

  const list = units?.kind === 'ready' ? units.data : [];
  const missing = list.filter((u) => u.weight_grams === null).length;
  const shown = useMemo(() => {
    const term = normalizeText(query.trim());
    return list
      .filter((u) => filter === 'all' || u.weight_grams === null)
      .filter((u) => term === '' || normalizeText(`${unitName(u)} ${u.sku}`).includes(term));
  }, [list, filter, query]);

  const save = async (unit: StockUnit) => {
    const id = unitId(unit);
    const text = (typed[id] ?? '').trim();
    const grams = text === '' ? null : Number(text);
    if (grams !== null && (!Number.isFinite(grams) || grams <= 0 || grams > 100000)) {
      showToast('Enter grams between 1 and 100000', 'error');
      return;
    }
    setSavingId(id);
    const answer = await setWeight(unit.product_id, unit.variant_id, grams);
    setSavingId(null);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not save the weight', 'error');
      return;
    }
    showToast(grams === null ? 'Back to the estimate' : 'Weight saved');
    setTyped((t) => {
      const next = { ...t };
      delete next[id];
      return next;
    });
    await load();
  };

  return (
    <section className="inv" aria-label="Needs weight">
      <AdminPageHeader title="Needs weight" onBack={onBack} />
      <p className="inv-muted">
        The weight of one piece, in grams, used to share the weight (luggage / cargo) cost of a lot. Estimated from the size in the
        name; type a weight to replace the estimate. Leave it empty and tap Save to go back to the estimate.
      </p>
      <ChipRow
        label="Show"
        active={filter}
        onSelect={(id) => setFilter(id as 'missing' | 'all')}
        chips={[
          { id: 'missing', label: 'Needs weight', count: missing },
          { id: 'all', label: 'All products', count: list.length },
        ]}
      />
      <AdminSearch value={query} onChange={setQuery} placeholder="Search product..." label="Search product" />
      {units === null ? (
        <SkeletonRows rows={6} thumb={false} />
      ) : units.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load products" hint={units.kind === 'error' ? units.message : 'The Batch 38 database step has not been run.'} />
      ) : shown.length === 0 ? (
        <EmptyState icon="check" title={filter === 'missing' ? 'Every product has a weight' : 'No products found'} />
      ) : (
        <div className="inv-stack" data-testid="inv-weights">
          {shown.map((u) => {
            const id = unitId(u);
            return (
              <div key={id} className="inv-item inv-weight-row">
                <span className="inv-item__name">
                  {unitName(u)}
                  {!u.is_active && <span className="inv-badge inv-badge--grey">Hidden</span>}
                </span>
                <span className="inv-muted">
                  {u.weight_grams === null ? 'No weight' : `${u.weight_grams} g (${u.weight_source === 'manual' ? 'typed' : 'estimated'})`}
                </span>
                <div className="inv-weight-edit">
                  <input
                    className="form-input"
                    inputMode="decimal"
                    placeholder="grams"
                    value={typed[id] ?? (u.weight_grams === null ? '' : String(u.weight_grams))}
                    onChange={(e) => setTyped((t) => ({ ...t, [id]: e.target.value }))}
                    aria-label={`Weight in grams for ${unitName(u)}`}
                  />
                  <button type="button" className="adm-btn adm-btn--ghost" disabled={savingId === id || typed[id] === undefined} onClick={() => void save(u)}>
                    {savingId === id ? <span className="spinner" aria-hidden="true" /> : 'Save'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
