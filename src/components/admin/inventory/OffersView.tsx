import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminPath } from '../../../lib/adminPages';
import { useToast } from '../../../hooks/useToast';
import { moneyText } from '../../../lib/money/format';
import { writeOff } from '../../../lib/money/api';
import type { LoadState } from '../../../lib/payouts';
import { fetchOfferRows } from '../../../lib/smart/api';
import { offerList, type ExpiredRow, type OfferSuggestion } from '../../../lib/smart/offers';
import { amountText, expiryText, monthsText, unitsText } from '../../../lib/smart/speed';
import type { OfferRowsAnswer } from '../../../lib/smart/types';
import { ConfirmSheet } from '../OrderActionCards';
import { AdminPageHeader, ChipRow, EmptyState, SkeletonRows } from '../ui/AdminUi';
import '../../../styles/adminSmart.css';

type Filter = 'all' | 'offer' | 'watch' | 'expired';

/**
 * Batch 43 Part 1: "Give an offer" — lot rows that will not sell before
 * they expire at today's speed (plain rules, src/lib/smart/offers.ts), a
 * discount range that never goes below the landed cost, and units already
 * expired with a "Write off" shortcut (Batch 41). Only "View profit & costs".
 */
export function OffersView({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [state, setState] = useState<LoadState<OfferRowsAnswer> | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [writing, setWriting] = useState<ExpiredRow | null>(null);

  const load = useCallback(async () => {
    setState(await fetchOfferRows());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const data = state?.kind === 'ready' ? state.data : null;
  const list = useMemo(() => (data ? offerList(data.rows, data.today) : { offers: [], expired: [] }), [data]);
  const offerCount = list.offers.filter((o) => o.status === 'offer').length;
  const watchCount = list.offers.length - offerCount;
  const shown = filter === 'expired' ? [] : list.offers.filter((o) => filter === 'all' || o.status === filter);

  const runWriteOff = async () => {
    if (!writing) return;
    const r = writing.row;
    const answer = await writeOff({
      productId: r.product_id,
      variantId: r.variant_id,
      units: r.units,
      reason: 'expired',
      note: `Expired (${expiryText(r.expiry_date)}) — from Give an offer`,
      lotItemId: r.lot_item_id,
    });
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not write off.', 'error');
      return;
    }
    showToast(`Written off: ${unitsText(r.units, r.stock_unit)} of ${r.label}`);
    setWriting(null);
    await load();
  };

  return (
    <section className="inv smart" aria-label="Give an offer">
      <AdminPageHeader title="Give an offer" onBack={onBack} />
      <p className="inv-muted">
        Products that will not sell before they expire at today&apos;s speed. Speed = units sold in the last 90 days ÷ 3.
        &ldquo;Give offer&rdquo;: it needs more time to sell than it has, less one month. &ldquo;Watch&rdquo;: within a month of that.
        Suggested prices never go below the landed cost.
      </p>
      {data && !data.inventory_mode && (
        <p className="smart-note" data-testid="offers-mode-note">
          Inventory mode is Off, so no sale is taken from lots yet and every speed is 0. These suggestions become useful once
          Inventory mode is On.
        </p>
      )}
      <ChipRow
        label="Show"
        active={filter}
        onSelect={(id) => setFilter(id as Filter)}
        chips={[
          { id: 'all', label: 'All', count: list.offers.length },
          { id: 'offer', label: 'Give offer', count: offerCount },
          { id: 'watch', label: 'Watch', count: watchCount },
          { id: 'expired', label: 'Expired', count: list.expired.length },
        ]}
      />
      {state === null ? (
        <SkeletonRows rows={4} thumb={false} />
      ) : state.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load" hint={state.kind === 'error' ? state.message : 'The Batch 43 database step has not been run.'} />
      ) : filter !== 'expired' ? (
        shown.length === 0 ? (
          <EmptyState icon="check" title="Nothing needs an offer" hint="Every lot with an expiry date sells in time at today's speed." />
        ) : (
          <div className="inv-stack" data-testid="offers-list">
            {shown.map((o) => (
              <OfferCard key={o.row.lot_item_id} offer={o} onOpen={() => navigate(adminPath.editProduct(o.row.product_id))} />
            ))}
          </div>
        )
      ) : null}

      {state?.kind === 'ready' && (filter === 'all' || filter === 'expired') && (
        <>
          <h2 className="inv-section">Already expired</h2>
          {list.expired.length === 0 ? (
            <p className="inv-muted" data-testid="expired-empty">No expired units in stock.</p>
          ) : (
            <div className="inv-stack" data-testid="expired-list">
              {list.expired.map((e) => (
                <div key={e.row.lot_item_id} className="inv-item" data-testid="expired-row">
                  <div className="inv-item__head">
                    <span className="inv-item__name">{e.row.label}</span>
                    <span className="smart-badge smart-badge--red">Expired</span>
                  </div>
                  <div className="inv-line">
                    <span>Lot · expiry</span>
                    <span>
                      {e.row.lot_code} · {expiryText(e.row.expiry_date)}
                    </span>
                  </div>
                  <div className="inv-line">
                    <span>Units left</span>
                    <span>{unitsText(e.row.units, e.row.stock_unit)}</span>
                  </div>
                  <div className="inv-line">
                    <span>Landed cost (the loss if written off)</span>
                    <span>{moneyText(e.value)}</span>
                  </div>
                  <div className="smart-actions">
                    <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => navigate(adminPath.editProduct(e.row.product_id))}>
                      Open product
                    </button>
                    <button
                      type="button"
                      className="adm-btn adm-btn--ghost adm-btn--sm"
                      disabled={!data?.inventory_mode}
                      onClick={() => setWriting(e)}
                      data-testid="expired-write-off"
                    >
                      Write off
                    </button>
                  </div>
                  {!data?.inventory_mode && <p className="inv-muted">Write off works once Inventory mode is On.</p>}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <ConfirmSheet
        isOpen={writing !== null}
        title={writing ? `Write off ${unitsText(writing.row.units, writing.row.stock_unit)} of ${writing.row.label}?` : ''}
        typeToConfirm={writing ? String(writing.row.units) : undefined}
        keepLabel="Keep"
        confirmLabel="Write off"
        danger
        onConfirm={runWriteOff}
        onClose={() => setWriting(null)}
      >
        <p className="adm-csheet__text">
          Reason: Expired. They leave lot {writing?.row.lot_code} and count as a loss of {writing ? moneyText(writing.value) : ''} today. Written to the
          Activity Log.
        </p>
      </ConfirmSheet>
    </section>
  );
}

function OfferCard({ offer: o, onOpen }: { offer: OfferSuggestion; onOpen: () => void }) {
  const r = o.row;
  const packWord = r.pack_size > 1 ? ' a pack' : '';
  return (
    <div className="inv-item" data-testid="offer-row" data-status={o.status}>
      <div className="inv-item__head">
        <span className="inv-item__name">{r.label}</span>
        <span className={`smart-badge ${o.status === 'offer' ? 'smart-badge--red' : 'smart-badge--amber'}`}>
          {o.status === 'offer' ? 'Give offer' : 'Watch'}
        </span>
      </div>
      <p className="smart-reason" data-testid="offer-reason">
        {o.reason.charAt(0).toUpperCase() + o.reason.slice(1)}.
      </p>
      <div className="inv-line">
        <span>Lot · expiry</span>
        <span>
          {r.lot_code} · {expiryText(r.expiry_date)}
        </span>
      </div>
      <div className="inv-line">
        <span>Units left</span>
        <span>{unitsText(r.units, r.stock_unit)}</span>
      </div>
      <div className="inv-line">
        <span>Speed</span>
        <span>
          {unitsText(o.perMonth, r.stock_unit)} a month{o.isNew ? ' · new' : ''}
        </span>
      </div>
      <div className="inv-line">
        <span>Time to sell · to expiry</span>
        <span>
          {o.monthsToSell === null ? 'no sales' : `${amountText(o.monthsToSell)} mo`} · {monthsText(o.monthsToExpiry)}
        </span>
      </div>
      <div className="inv-line">
        <span>Price now{packWord}</span>
        <span>{moneyText(o.price)}</span>
      </div>
      <div className="inv-line">
        <span>Lowest price (landed cost){packWord}</span>
        <span data-testid="offer-floor">{moneyText(o.floor)}</span>
      </div>
      <div className="inv-line inv-line--total">
        <span>Suggested</span>
        <span data-testid="offer-suggested">
          {o.noRoom
            ? 'No room — the price is already at or below cost'
            : `${o.discount.min}–${o.discount.max}% off: ${moneyText(o.priceLow)}–${moneyText(o.priceHigh)}`}
        </span>
      </div>
      {!o.noRoom && o.maxDiscount < o.discount.max && (
        <p className="inv-muted" data-testid="offer-capped">
          At most {o.maxDiscount}% off before it goes below cost.
        </p>
      )}
      <div className="smart-actions">
        <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={onOpen} data-testid="offer-open">
          Open product
        </button>
      </div>
    </div>
  );
}
