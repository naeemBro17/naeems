import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { useSafetyLock } from '../../../contexts/SafetyLockContext';
import { takaExact } from '../../../lib/payouts';
import { deleteLot, fetchLot, fetchMovements, fetchStockUnits, monthYear, unitName } from '../../../lib/inventory/api';
import type { LotDetail, StockMovement, StockUnit } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { formatLotDate, movementLabel, sourceLabel, taka2 } from './invFormat';

/**
 * Batch 38 Part 3: one lot — its rows with the cost shared out, its bills,
 * the stock movements and the pieces left. Deleting needs the Safety Lock
 * (the database checks it too).
 */
export function LotDetailView({ lotId, onBack, onEdit, onDeleted }: { lotId: string; onBack: () => void; onEdit: () => void; onDeleted: () => void }) {
  const { showToast } = useToast();
  const { openUntil } = useSafetyLock();
  const [lot, setLot] = useState<LoadState<LotDetail | null> | null>(null);
  const [units, setUnits] = useState<Map<string, StockUnit>>(new Map());
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [detail, stock] = await Promise.all([fetchLot(lotId), fetchStockUnits()]);
    setLot(detail);
    if (stock.kind === 'ready') setUnits(new Map(stock.data.map((u) => [`${u.product_id}:${u.variant_id ?? ''}`, u])));
    if (detail.kind === 'ready' && detail.data) setMovements(await fetchMovements(detail.data.lot_items.map((i) => i.id)));
  }, [lotId]);

  useEffect(() => {
    void load();
  }, [load]);

  const data = lot?.kind === 'ready' ? lot.data : null;
  const label = useCallback(
    (productId: string, variantId: string | null) => {
      const unit = units.get(`${productId}:${variantId ?? ''}`);
      return unit ? unitName(unit) : 'Product';
    },
    [units]
  );

  const totals = useMemo(() => {
    if (!data) return null;
    let pieces = 0;
    let left = 0;
    let buyPaisa = 0;
    let weightAlloc = 0;
    let otherAlloc = 0;
    for (const i of data.lot_items) {
      pieces += i.qty;
      left += i.qty_remaining;
      buyPaisa += Math.round(i.qty * Number(i.unit_price_bdt) * 100);
      weightAlloc += Number(i.alloc_weight_paisa);
      otherAlloc += Number(i.alloc_other_paisa);
    }
    const weightBills = data.lot_costs.filter((c) => c.cost_type === 'weight').reduce((a, c) => a + Math.round(Number(c.amount_bdt) * 100), 0);
    const otherBills = data.lot_costs.filter((c) => c.cost_type === 'other').reduce((a, c) => a + Math.round(Number(c.amount_bdt) * 100), 0);
    return { pieces, left, buyPaisa, weightAlloc, otherAlloc, weightBills, otherBills };
  }, [data]);

  const handleDelete = async () => {
    setIsDeleting(true);
    setDeleteError(null);
    const answer = await deleteLot(lotId);
    setIsDeleting(false);
    if (!answer.ok) {
      setDeleteError(answer.error ?? 'Could not delete the lot.');
      return;
    }
    showToast('Lot deleted');
    onDeleted();
  };

  if (lot === null) {
    return (
      <section className="inv" aria-label="Lot">
        <AdminPageHeader title="Lot" onBack={onBack} />
        <SkeletonRows rows={5} thumb={false} />
      </section>
    );
  }
  if (!data || !totals) {
    return (
      <section className="inv" aria-label="Lot">
        <AdminPageHeader title="Lot" onBack={onBack} />
        <EmptyState icon="alert" title="Lot not found" hint={lot.kind === 'error' ? lot.message : 'It may have been deleted.'} />
      </section>
    );
  }

  const isOpening = data.kind === 'opening';
  const menu = isOpening
    ? []
    : [
        { label: 'Edit lot', onSelect: onEdit },
        { label: 'Delete lot', onSelect: () => setConfirmDelete(true), danger: true },
      ];
  const weightOk = isOpening || totals.weightAlloc === totals.weightBills;
  const otherOk = isOpening || totals.otherAlloc === totals.otherBills;

  return (
    <section className="inv" aria-label={`Lot ${data.code}`}>
      <AdminPageHeader title={`Lot ${data.code}`} onBack={onBack} menu={menu} />

      {confirmDelete && (
        <div className="adm-ocard inv-stack inv-danger-box" role="alertdialog" aria-label="Delete lot">
          <p>
            Delete lot <b>{data.code}</b> and its {totals.pieces} pieces? This can&apos;t be undone.
          </p>
          {!openUntil && (
            <p className="inv-muted">
              First turn off the Safety Lock: Settings → Safety Locks (it asks your password and turns itself back on after 15 minutes).
            </p>
          )}
          {deleteError && <p className="inv-error">{deleteError}</p>}
          <div className="inv-actions">
            <button type="button" className="adm-btn adm-btn--danger" onClick={() => void handleDelete()} disabled={isDeleting || !openUntil} data-testid="inv-delete-lot">
              {isDeleting ? <span className="spinner" aria-hidden="true" /> : 'Delete lot'}
            </button>
            <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}

      <div className="adm-ocard inv-stack" data-testid="inv-lot-details">
        <div className="inv-line">
          <span>Kind</span>
          <span>{isOpening ? 'Opening stock' : `${sourceLabel(data.source_type)} lot`}</span>
        </div>
        {!isOpening && (
          <>
            <div className="inv-line">
              <span>Country · supplier</span>
              <span>{[data.country, data.supplier].filter((s) => s.trim() !== '').join(' · ') || '—'}</span>
            </div>
            <div className="inv-line">
              <span>Currency</span>
              <span>
                {data.currency}
                {data.currency !== 'BDT' ? ` at ৳${data.exchange_rate}` : ''}
              </span>
            </div>
          </>
        )}
        <div className="inv-line">
          <span>Date</span>
          <span>{formatLotDate(data.lot_date)}</span>
        </div>
        <div className="inv-line">
          <span>Created by</span>
          <span>{data.created_by_username || '—'}</span>
        </div>
        {data.costs_pending && (
          <p>
            <span className="inv-badge">Costs pending</span> Some bills have not arrived yet.
          </p>
        )}
        {data.notes && <p className="inv-muted">{data.notes}</p>}
        {isOpening && (
          <p className="inv-note-strong" data-testid="inv-opening-moved">
            Weight cost moved from old expenses into opening stock: {takaExact(Math.round(Number(data.opening_weight_added_bdt ?? 0) * 100))}
            {data.opening_weight_percent !== null ? ` (${Number(data.opening_weight_percent)}% on imported goods)` : ''}
          </p>
        )}
      </div>

      <div className="adm-ocard inv-stack" data-testid="inv-lot-totals">
        <div className="inv-line">
          <span>Pieces</span>
          <span>{totals.pieces}</span>
        </div>
        <div className="inv-line">
          <span>Pieces left</span>
          <span>{totals.left}</span>
        </div>
        <div className="inv-line">
          <span>Buy price (all pieces)</span>
          <span>{takaExact(totals.buyPaisa)}</span>
        </div>
        <div className="inv-line">
          <span>{isOpening ? 'Weight % added' : 'Weight cost'}</span>
          <span>{takaExact(isOpening ? totals.weightAlloc : totals.weightBills)}</span>
        </div>
        {!isOpening && (
          <div className="inv-line">
            <span>Other costs</span>
            <span>{takaExact(totals.otherBills)}</span>
          </div>
        )}
        <div className="inv-line inv-line--total">
          <span>Landed cost</span>
          <span>{takaExact(totals.buyPaisa + totals.weightAlloc + totals.otherAlloc)}</span>
        </div>
        {!isOpening &&
          (weightOk && otherOk ? (
            <p className="inv-ok" data-testid="inv-detail-allocated-ok">
              Allocated total = lot total ✓
            </p>
          ) : (
            <p className="inv-error">Allocated total does not match the lot total — open Edit and save again.</p>
          ))}
      </div>

      <h2 className="inv-section">Products</h2>
      <div className="inv-stack">
        {data.lot_items.map((i) => (
          <div key={i.id} className="inv-item" data-testid="inv-detail-item">
            <span className="inv-item__name">{label(i.product_id, i.variant_id)}</span>
            <div className="inv-line">
              <span>Pieces · left</span>
              <span>
                {i.qty} · {i.qty_remaining}
              </span>
            </div>
            <div className="inv-line">
              <span>Expiry · weight</span>
              <span>
                {monthYear(i.expiry_date)} · {i.weight_grams_used === null ? '—' : `${Number(i.weight_grams_used)} g`}
              </span>
            </div>
            {isOpening && i.opening_source && (
              <div className="inv-line">
                <span>Source</span>
                <span>{sourceLabel(i.opening_source)}</span>
              </div>
            )}
            <div className="inv-line">
              <span>Buy price</span>
              <span>
                {!isOpening && data.currency !== 'BDT' ? `${data.currency} ${Number(i.unit_price_foreign)} = ` : ''}
                {taka2(Number(i.unit_price_bdt))}
              </span>
            </div>
            <div className="inv-line">
              <span>+ weight share</span>
              <span>{taka2(Number(i.alloc_weight_bdt))}</span>
            </div>
            {!isOpening && (
              <div className="inv-line">
                <span>+ other share</span>
                <span>{taka2(Number(i.alloc_other_bdt))}</span>
              </div>
            )}
            <div className="inv-line inv-line--total">
              <span>Landed cost per piece</span>
              <span data-testid="inv-landed-unit">{taka2(Number(i.landed_unit_cost_bdt))}</span>
            </div>
          </div>
        ))}
      </div>

      {!isOpening && (
        <>
          <h2 className="inv-section">Bills</h2>
          {data.lot_costs.length === 0 ? (
            <p className="inv-muted">No bills yet.</p>
          ) : (
            <div className="adm-ocard inv-stack">
              {data.lot_costs.map((c) => (
                <div key={c.id} className="inv-line">
                  <span>
                    {c.cost_type === 'weight' ? 'Weight' : 'Other'}
                    {c.cost_date ? ` · ${formatLotDate(c.cost_date)}` : ''}
                    {c.note ? ` · ${c.note}` : ''}
                  </span>
                  <span>{takaExact(Math.round(Number(c.amount_bdt) * 100))}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <h2 className="inv-section">Stock movements</h2>
      <div className="adm-ocard inv-stack" data-testid="inv-movements">
        {movements.length === 0 ? (
          <p className="inv-muted">None.</p>
        ) : (
          movements.map((m) => {
            const item = data.lot_items.find((i) => i.id === m.lot_item_id);
            return (
              <div key={m.id} className="inv-line">
                <span>
                  {formatLotDate(m.created_at.slice(0, 10))} · {movementLabel(m.movement_type)} · {item ? label(item.product_id, item.variant_id) : ''}
                  {m.reason ? ` · ${m.reason}` : ''}
                </span>
                <span>{m.qty > 0 ? `+${m.qty}` : m.qty}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
