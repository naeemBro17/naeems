import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { useProducts } from '../../../contexts/ProductContext';
import { takaExact } from '../../../lib/payouts';
import { deleteLot, fetchLot, fetchLotDeleteInfo, fetchMovements, fetchStockUnits, monthYear, packsText, unitName } from '../../../lib/inventory/api';
import type { LotDeleteInfo, LotDetail, StockMovement, StockUnit } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { formatLotDate, movementLabel, sourceLabel, taka2 } from './invFormat';
import { LotPaymentsCard } from '../money/LotPayments';
import { CountryLabel } from './countries';
import { LotReceipts } from './LotReceipts';

/**
 * Batch 38 Part 3: one lot — its rows with the cost shared out, its bills,
 * the stock movements and the pieces left. Batch 39: stock and cost are per
 * unit (packs shown for products with a pack size). Batch 45: every lot —
 * the opening lot and lots with sales too — can be edited and deleted (one
 * confirmation that says what will happen; the orders stay). Weight is not
 * part of cost. Receipts are listed by name; a file opens only when tapped.
 */
export function LotDetailView({ lotId, onBack, onEdit, onDeleted }: { lotId: string; onBack: () => void; onEdit: () => void; onDeleted: () => void }) {
  const { showToast } = useToast();
  const { refetch: refetchProducts } = useProducts();
  const [lot, setLot] = useState<LoadState<LotDetail | null> | null>(null);
  const [units, setUnits] = useState<Map<string, StockUnit>>(new Map());
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteInfo, setDeleteInfo] = useState<LotDeleteInfo | null>(null);

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
    let otherAlloc = 0;
    for (const i of data.lot_items) {
      pieces += i.qty;
      left += i.qty_remaining;
      buyPaisa += Math.round((Number(i.buy_value_bdt) > 0 ? Number(i.buy_value_bdt) : i.qty * Number(i.unit_price_bdt)) * 100);
      otherAlloc += Number(i.alloc_other_paisa);
    }
    // Old weight bills are history only: they count nowhere.
    const otherBills = data.lot_costs.filter((c) => c.cost_type === 'other').reduce((a, c) => a + Math.round(Number(c.amount_bdt) * 100), 0);
    return { pieces, left, buyPaisa, otherAlloc, otherBills };
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
    await refetchProducts();
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
  const askDelete = () => {
    setConfirmDelete(true);
    setDeleteInfo(null);
    void fetchLotDeleteInfo(lotId).then(setDeleteInfo);
  };
  const menu = [
    { label: 'Edit lot', onSelect: onEdit },
    { label: 'Delete lot', onSelect: askDelete, danger: true },
  ];
  const otherOk = totals.otherAlloc === totals.otherBills;
  const otherCosts = data.lot_costs.filter((c) => c.cost_type === 'other');
  const unitsLeaving = deleteInfo?.units_left ?? Math.max(totals.left, 0);
  const soldOrders = deleteInfo?.orders ?? null;

  return (
    <section className="inv" aria-label={`Lot ${data.code}`}>
      <AdminPageHeader title={`Lot ${data.code}`} onBack={onBack} menu={menu} />

      {confirmDelete && (
        <div className="adm-ocard inv-stack inv-danger-box" role="alertdialog" aria-label="Delete lot">
          <p data-testid="inv-delete-text">
            Delete lot <b>{data.code}</b>? {unitsLeaving} unit{unitsLeaving === 1 ? '' : 's'} leave stock.
            {soldOrders !== null && soldOrders > 0
              ? ` ${soldOrders} order${soldOrders === 1 ? ' was' : 's were'} sold from this lot — the orders stay.`
              : ''}
            {deleteInfo && deleteInfo.receipts > 0 ? ` Its ${deleteInfo.receipts} receipt${deleteInfo.receipts === 1 ? ' is' : 's are'} deleted too.` : ''} This can&apos;t be undone.
          </p>
          {deleteError && <p className="inv-error">{deleteError}</p>}
          <div className="inv-actions">
            <button type="button" className="adm-btn adm-btn--danger" onClick={() => void handleDelete()} disabled={isDeleting} data-testid="inv-delete-lot">
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
              <span>
                {data.country.trim() ? <CountryLabel text={data.country} /> : null}
                {data.country.trim() && data.supplier.trim() ? ' · ' : ''}
                {data.supplier.trim() || (data.country.trim() ? '' : '—')}
              </span>
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
      </div>

      <div className="adm-ocard inv-stack" data-testid="inv-lot-totals">
        <div className="inv-line">
          <span>Units</span>
          <span>{totals.pieces}</span>
        </div>
        <div className="inv-line">
          <span>Units left</span>
          <span>{totals.left}</span>
        </div>
        <div className="inv-line">
          <span>Buy price (all units)</span>
          <span>{takaExact(totals.buyPaisa)}</span>
        </div>
        {!isOpening && (
          <div className="inv-line">
            <span>Other costs</span>
            <span>{takaExact(totals.otherBills)}</span>
          </div>
        )}
        <div className="inv-line inv-line--total">
          <span>Landed cost</span>
          <span>{takaExact(totals.buyPaisa + totals.otherAlloc)}</span>
        </div>
        {totals.otherBills > 0 &&
          (otherOk ? (
            <p className="inv-ok" data-testid="inv-detail-allocated-ok">
              Allocated total matches the lot total
            </p>
          ) : (
            <p className="inv-error">Allocated total does not match the lot total — open Edit and save again.</p>
          ))}
      </div>

      {/* Batch 41 Part 3.3: what was paid and what is still owed. */}
      <LotPaymentsCard lotId={lotId} isOpening={isOpening} />

      <h2 className="inv-section">Products</h2>
      <div className="inv-stack">
        {data.lot_items.map((i) => {
          const unit = units.get(`${i.product_id}:${i.variant_id ?? ''}`);
          const word = unit?.stock_unit ?? 'pcs';
          const pack = Math.max(1, Number(i.pack_size) || 1);
          const per = pack > 1 ? word : 'piece';
          return (
          <div key={i.id} className="inv-item" data-testid="inv-detail-item">
            <span className="inv-item__name">{label(i.product_id, i.variant_id)}</span>
            <div className="inv-line">
              <span>{pack > 1 ? `Units (${word}) · left` : 'Pieces · left'}</span>
              <span>
                {i.qty} · {i.qty_remaining}
              </span>
            </div>
            {pack > 1 && (
              <div className="inv-line">
                <span>In packs of {pack}</span>
                <span>{packsText(i.qty_remaining, word, pack)} left</span>
              </div>
            )}
            <div className="inv-line">
              <span>Expiry</span>
              <span>{monthYear(i.expiry_date)}</span>
            </div>
            {isOpening && i.opening_source && (
              <div className="inv-line">
                <span>Source</span>
                <span>{sourceLabel(i.opening_source)}</span>
              </div>
            )}
            <div className="inv-line">
              <span>Buy price per {per}</span>
              <span>
                {!isOpening && data.currency !== 'BDT' ? `${data.currency} ${Number(i.unit_price_foreign)} = ` : ''}
                {taka2(Number(i.unit_price_bdt))}
              </span>
            </div>
            {pack > 1 && (i.entry_unit === 'pack' || isOpening) && (
              <div className="inv-line">
                <span>Typed per pack</span>
                <span>{taka2(Number(i.unit_price_foreign))}</span>
              </div>
            )}
            {Number(i.alloc_other_bdt) !== 0 && (
              <div className="inv-line">
                <span>+ other share</span>
                <span>{taka2(Number(i.alloc_other_bdt))}</span>
              </div>
            )}
            <div className="inv-line inv-line--total">
              <span>Landed cost per {per}</span>
              <span data-testid="inv-landed-unit">{taka2(Number(i.landed_unit_cost_bdt))}</span>
            </div>
          </div>
          );
        })}
      </div>

      {!isOpening && (
        <>
          <h2 className="inv-section">Other costs</h2>
          {otherCosts.length === 0 ? (
            <p className="inv-muted">No other costs.</p>
          ) : (
            <div className="adm-ocard inv-stack">
              {otherCosts.map((c) => (
                <div key={c.id} className="inv-line">
                  <span>
                    Other cost
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

      <h2 className="inv-section">Receipts</h2>
      <div className="adm-ocard">
        <LotReceipts lotId={lotId} />
      </div>

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
