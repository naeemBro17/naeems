import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { dhakaToday, fetchSalesProfit, packsText } from '../../../lib/inventory/api';
import type { SalesProfit } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { adminPath } from '../../../lib/adminPages';
import { formatTakaBd } from '../../../lib/adminNav';
import { AdminPageHeader, ChipRow, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { formatLotDate } from './invFormat';

type Range = 'today' | 'month' | 'custom';

function signed(amount: number): string {
  return amount < 0 ? `−${formatTakaBd(-amount)}` : formatTakaBd(amount);
}

function margin(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

/** First day of this month (Dhaka), "YYYY-MM-01". */
function monthStart(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

const ADJUSTMENT_LABELS: Record<SalesProfit['adjustments'][number]['reason'], string> = {
  late_bill: 'Late bill',
  shortfall_filled: 'Sold without stock, filled',
  given_back: 'Units came back',
};

/**
 * Batch 39 Part 3.4: Sales profit for a date range. An order counts on the
 * day it became Delivered (a Returned order on the day it came back: its
 * courier charge is the loss). Orders delivered before Inventory mode have
 * no lot cost and are left out of the totals. Plain stacked rows — no
 * sideways scrolling on a phone.
 */
export function SalesProfitView({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const today = dhakaToday();
  const [range, setRange] = useState<Range>('today');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [state, setState] = useState<LoadState<SalesProfit> | null>(null);

  const period = range === 'today' ? { from: today, to: today } : range === 'month' ? { from: monthStart(today), to: today } : { from, to };

  useEffect(() => {
    if (!period.from || !period.to || period.to < period.from) return;
    let alive = true;
    setState(null);
    void fetchSalesProfit(period.from, period.to).then((answer) => {
      if (alive) setState(answer);
    });
    return () => {
      alive = false;
    };
  }, [period.from, period.to]);

  const data = state?.kind === 'ready' ? state.data : null;
  const t = data?.totals;

  return (
    <section className="inv" aria-label="Sales profit">
      <AdminPageHeader title="Sales profit" onBack={onBack} />
      <ChipRow
        label="Dates"
        active={range}
        onSelect={(id) => setRange(id as Range)}
        chips={[
          { id: 'today', label: 'Today' },
          { id: 'month', label: 'This month' },
          { id: 'custom', label: 'Custom' },
        ]}
      />
      {range === 'custom' && (
        <div className="inv-fields">
          <label className="form-field">
            <span className="form-label">From</span>
            <input className="form-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          </label>
          <label className="form-field">
            <span className="form-label">To</span>
            <input className="form-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
          </label>
        </div>
      )}
      {range === 'custom' && to < from && <p className="inv-error">The end date is before the start date.</p>}

      {state === null ? (
        <SkeletonRows rows={5} thumb={false} />
      ) : state.kind !== 'ready' || !data || !t ? (
        <EmptyState icon="alert" title="Could not load" hint={state.kind === 'error' ? state.message : 'The Batch 39 database step has not been run.'} />
      ) : (
        <>
          <div className="adm-ocard inv-stack" data-testid="inv-profit-totals">
            <p className="inv-muted">
              {formatLotDate(data.from)}
              {data.to !== data.from ? ` – ${formatLotDate(data.to)}` : ''} · {t.orders} order{t.orders === 1 ? '' : 's'}
            </p>
            <div className="inv-line">
              <span>Sales (after discounts)</span>
              <span>{formatTakaBd(t.sales)}</span>
            </div>
            <div className="inv-line">
              <span>Cost of goods{t.provisional > 0 ? ' (part provisional)' : ''}</span>
              <span>−{formatTakaBd(t.cost)}</span>
            </div>
            <div className="inv-line">
              <span>Delivery collected</span>
              <span>+{formatTakaBd(t.delivery)}</span>
            </div>
            <div className="inv-line">
              <span>Courier + COD fee</span>
              <span>−{formatTakaBd(t.courier)}</span>
            </div>
            <div className="inv-line">
              <span>Cost adjustments</span>
              <span>{t.adjustments > 0 ? '−' : t.adjustments < 0 ? '+' : ''}{formatTakaBd(Math.abs(t.adjustments))}</span>
            </div>
            <div className="inv-line inv-line--total" data-testid="inv-profit-total">
              <span>Profit</span>
              <span>{signed(t.profit)}</span>
            </div>
            <div className="inv-line">
              <span>Margin</span>
              <span>{margin(t.margin)}</span>
            </div>
            {t.uncosted_orders > 0 && (
              <p className="inv-muted">
                {t.uncosted_orders} order{t.uncosted_orders === 1 ? '' : 's'} with no cost (before inventory) {t.uncosted_orders === 1 ? 'is' : 'are'} listed below but
                not counted.
              </p>
            )}
          </div>

          <h2 className="inv-section">Orders</h2>
          {data.orders.length === 0 ? (
            <p className="inv-muted">No delivered or returned orders in these dates.</p>
          ) : (
            <div className="inv-stack" data-testid="inv-profit-orders">
              {data.orders.map((o) => (
                <button key={o.order_id} type="button" className="inv-item inv-item--button" onClick={() => navigate(adminPath.order(o.order_number))}>
                  <span className="inv-item__head">
                    <span className="inv-item__name">{o.order_number}</span>
                    <span className="inv-badge inv-badge--grey">{o.status === 'returned' ? 'Returned' : 'Delivered'}</span>
                  </span>
                  {!o.costed ? (
                    <span className="inv-muted">No cost (before inventory)</span>
                  ) : (
                    <>
                      <span className="inv-line">
                        <span>Sale · cost</span>
                        <span>
                          {formatTakaBd(o.sale)} · {formatTakaBd(o.cost)}
                          {o.provisional > 0 ? ' (provisional)' : ''}
                        </span>
                      </span>
                      <span className="inv-line">
                        <span>Delivery · courier{o.courier_known ? '' : ' (not known yet)'}</span>
                        <span>
                          +{formatTakaBd(o.delivery)} · −{formatTakaBd(o.courier)}
                        </span>
                      </span>
                      <span className="inv-line inv-line--total">
                        <span>Profit ({margin(o.margin)})</span>
                        <span>{signed(o.profit)}</span>
                      </span>
                    </>
                  )}
                </button>
              ))}
            </div>
          )}

          <h2 className="inv-section">By product</h2>
          {data.products.length === 0 ? (
            <p className="inv-muted">No products sold from lots in these dates.</p>
          ) : (
            <div className="inv-stack" data-testid="inv-profit-products">
              <p className="inv-muted">Sales after discounts minus cost of goods. Delivery and courier are counted per order, not per product.</p>
              {data.products.map((p) => (
                <div key={`${p.product_id}:${p.variant_id ?? ''}`} className="inv-item" data-testid="inv-profit-product">
                  <span className="inv-item__name">{p.label}</span>
                  <div className="inv-line">
                    <span>Sold</span>
                    <span>{p.pack_size > 1 ? `${p.units} ${p.stock_unit} (${packsText(p.units, p.stock_unit, p.pack_size)})` : p.units}</span>
                  </div>
                  <div className="inv-line">
                    <span>Sales · cost</span>
                    <span>
                      {formatTakaBd(p.sales)} · {formatTakaBd(p.cost)}
                    </span>
                  </div>
                  <div className="inv-line inv-line--total">
                    <span>Profit ({margin(p.margin)})</span>
                    <span>{signed(p.profit)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {data.adjustments.length > 0 && (
            <>
              <h2 className="inv-section">Cost adjustments</h2>
              <div className="adm-ocard inv-stack" data-testid="inv-profit-adjustments">
                {data.adjustments.map((a, i) => (
                  <div key={`${a.date}-${i}`} className="inv-line">
                    <span>
                      {formatLotDate(a.date)} · {ADJUSTMENT_LABELS[a.reason]}
                      {a.note ? ` · ${a.note}` : ''}
                    </span>
                    <span>{a.amount < 0 ? `−${formatTakaBd(-a.amount)}` : formatTakaBd(a.amount)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
