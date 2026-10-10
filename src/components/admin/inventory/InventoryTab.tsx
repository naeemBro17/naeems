import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchLots, fetchStockUnits, lotTotals } from '../../../lib/inventory/api';
import type { LotSummary, StockUnit } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { takaWhole, takaExact } from '../../../lib/payouts';
import { useProducts } from '../../../contexts/ProductContext';
import { AdminPageHeader, EmptyState, ListGroup, ListRow, SkeletonRows } from '../ui/AdminUi';
import { useInvNav } from './invNav';
import { LotForm } from './LotForm';
import { LotDetailView } from './LotDetailView';
import { NeedsWeightView } from './NeedsWeightView';
import { CompareView } from './CompareView';
import { OpeningStockView } from './OpeningStockView';
import { formatLotDate, sourceLabel } from './invFormat';
import '../../../styles/adminInventory.css';

/**
 * Admin → Inventory (Batch 38). Only "View profit & costs" opens it, and
 * the database shows these numbers to nobody else. Plain screens on
 * purpose: correct numbers first, design later.
 */
export function InventoryTab() {
  const { view, lotId, open, back } = useInvNav();

  if (view === 'new') return <LotForm lotId={null} onBack={back} onSaved={(id) => open('lot', id, { replace: true })} />;
  if (view === 'edit' && lotId) return <LotForm lotId={lotId} onBack={back} onSaved={(id) => open('lot', id, { replace: true })} />;
  if (view === 'lot' && lotId) return <LotDetailView key={lotId} lotId={lotId} onBack={back} onEdit={() => open('edit', lotId)} onDeleted={() => open('home', undefined, { replace: true })} />;
  if (view === 'weights') return <NeedsWeightView onBack={back} />;
  if (view === 'compare') return <CompareView onBack={back} />;
  if (view === 'opening') return <OpeningStockView onBack={back} onOpenLot={(id) => open('lot', id)} />;
  return <InventoryHome onOpen={open} />;
}

function InventoryHome({ onOpen }: { onOpen: ReturnType<typeof useInvNav>['open'] }) {
  const { settings } = useProducts();
  const [lots, setLots] = useState<LoadState<LotSummary[]> | null>(null);
  const [units, setUnits] = useState<StockUnit[]>([]);

  const load = useCallback(async () => {
    const [list, stock] = await Promise.all([fetchLots(), fetchStockUnits()]);
    setLots(list);
    setUnits(stock.kind === 'ready' ? stock.data : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const list = lots?.kind === 'ready' ? lots.data : [];
  const opening = list.find((l) => l.kind === 'opening') ?? null;
  const needsWeight = useMemo(() => units.filter((u) => u.weight_grams === null).length, [units]);
  const modeOn = settings.inventory_mode === 'true';

  const newLot = (
    <button type="button" className="adm-btn adm-btn--primary" onClick={() => onOpen('new')} data-testid="inv-new-lot">
      New lot
    </button>
  );

  return (
    <section aria-label="Inventory" className="inv">
      <AdminPageHeader title="Inventory" primary={newLot} />

      <div className="adm-ocard inv-mode" data-testid="inv-mode-note">
        <p className="inv-mode__title">
          Inventory mode: <b>{modeOn ? 'On' : 'Off'}</b>
        </p>
        <p className="inv-muted">
          Lots are a separate record for costs and profit. While Inventory mode is Off, the shop&apos;s stock numbers and
          checkout are not changed by anything here.
        </p>
      </div>

      <ListGroup title="TOOLS">
        <ListRow icon="restock" label="Opening stock" detail={opening ? 'Saved (L-000)' : 'Not uploaded'} onClick={() => onOpen('opening')} />
        <ListRow icon="alert" label="Needs weight" detail={units.length ? String(needsWeight) : undefined} onClick={() => onOpen('weights')} />
        <ListRow icon="chart" label="Compare stock (shop vs lots)" onClick={() => onOpen('compare')} />
      </ListGroup>

      <h2 className="inv-section">Lots</h2>
      {lots === null ? (
        <SkeletonRows rows={4} thumb={false} />
      ) : lots.kind === 'no-db' ? (
        <EmptyState icon="inventory" title="Inventory is not set up yet" hint="The Batch 38 database step has not been run." />
      ) : lots.kind === 'error' ? (
        <EmptyState icon="alert" title="Could not load lots" hint={lots.message} />
      ) : list.length === 0 ? (
        <EmptyState icon="inventory" title="No lots yet" hint="Tap New lot when a shipment arrives, or upload your opening stock." />
      ) : (
        <div className="inv-list" data-testid="inv-lots">
          {list.map((lot) => {
            const t = lotTotals(lot.lot_items);
            const where = [lot.country, lot.supplier].filter((s) => s.trim() !== '').join(' · ');
            return (
              <button key={lot.id} type="button" className="inv-lot" onClick={() => onOpen('lot', lot.id)}>
                <span className="inv-lot__main">
                  <span className="inv-lot__title">
                    {lot.code}
                    <span className="inv-badge inv-badge--grey">{lot.kind === 'opening' ? 'Opening' : sourceLabel(lot.source_type)}</span>
                    {lot.costs_pending && <span className="inv-badge">Costs pending</span>}
                  </span>
                  <span className="inv-lot__sub">
                    {where ? `${where} · ` : ''}
                    {formatLotDate(lot.lot_date)}
                  </span>
                  <span className="inv-lot__sub">
                    {t.products} product{t.products === 1 ? '' : 's'} · {t.pieces} pieces · {t.left} left
                  </span>
                </span>
                <span className="inv-lot__side">
                  <b title={takaExact(t.landedPaisa)}>{takaWhole(t.landedPaisa)}</b>
                  <span className="inv-muted">landed</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
