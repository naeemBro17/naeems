import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchOrderProfit } from '../../../lib/inventory/api';
import type { OrderProfit } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { formatTakaBd } from '../../../lib/adminNav';
import { formatDhakaDateTime } from '../../../lib/orderTracking';
import { courierLabel, useCourierCostsRefresh } from '../../../lib/inventory/courierLabel';

function signedTaka(amount: number): string {
  return amount < 0 ? `−${formatTakaBd(-amount)}` : formatTakaBd(amount);
}

/**
 * Batch 39 Part 3: the order's profit — items sold, cost of goods (landed,
 * locked when the stock left), delivery collected, courier + COD fee, and
 * profit with margin. Only rendered for "View profit & costs"; the
 * database (order_profit) refuses everyone else. Counted on the day the
 * order became Delivered; a Returned order's loss is the courier charge.
 * Batch 53: the courier amount carries a small grey label (From Steadfast /
 * Share of payout / Expected / No courier), and the card reads its numbers
 * again when the page comes back into view or the Payouts page refreshes.
 * Batch 58: an item with no cost no longer hides the card — the rest is
 * shown and "Cost missing" links to Set buying prices; a cancelled order
 * Steadfast charged for shows the charge as its courier cost.
 */
export function OrderProfitBox({ orderId, version }: { orderId: string; version: string }) {
  const [state, setState] = useState<LoadState<OrderProfit> | null>(null);
  const refreshTick = useCourierCostsRefresh();

  useEffect(() => {
    let alive = true;
    void fetchOrderProfit(orderId).then((answer) => {
      if (alive) setState(answer);
    });
    return () => {
      alive = false;
    };
  }, [orderId, version, refreshTick]);

  if (state === null || state.kind === 'no-db') return null;
  if (state.kind === 'error') {
    return (
      <section className="adm-ocard" aria-label="Profit" data-testid="order-profit">
        <h2 className="adm-ocard__title">Profit</h2>
        <p className="adm-ocard__muted">{state.message}</p>
      </section>
    );
  }
  const p = state.data;
  const tag = courierLabel(p.courier_kind, p.courier_known);
  const separately = p.bill_paid_separately ?? 0;

  return (
    <section className="adm-ocard" aria-label="Profit" data-testid="order-profit">
      <h2 className="adm-ocard__title">Profit</h2>
      <div className="adm-ototals">
        <div className="adm-ototals__row">
          <span>Items sold (after discounts)</span>
          <span>{formatTakaBd(p.sale)}</span>
        </div>
        <div className="adm-ototals__row">
          <span>Cost of goods{p.provisional > 0 ? ' (part provisional)' : ''}</span>
          <span>−{formatTakaBd(p.cost)}</span>
        </div>
        <div className="adm-ototals__row">
          <span>Delivery charged to the customer</span>
          <span>+{formatTakaBd(p.delivery)}</span>
        </div>
        <div className="adm-ototals__row" data-testid="order-profit-courier">
          <span>
            Courier + COD fee
            {tag && (
              <span className="adm-courier-tag" data-testid="order-profit-courier-tag">
                {tag.label}
              </span>
            )}
            {tag?.note && <span className="adm-courier-note">{tag.note}</span>}
            {separately > 0 && (
              <span className="adm-courier-note">Includes a delivery bill of {formatTakaBd(separately)} paid outside the payout</span>
            )}
          </span>
          <span>−{formatTakaBd(p.courier)}</span>
        </div>
        <div className="adm-ototals__row adm-ototals__row--strong" data-testid="order-profit-total">
          <span>Profit{p.margin !== null ? ` (${p.margin}%)` : ''}</span>
          <span>{signedTaka(p.profit)}</span>
        </div>
      </div>
      {(!p.costed || (p.items_missing_cost ?? 0) > 0) && (
        <p className="adm-ocard__muted" data-testid="order-profit-cost-missing">
          Cost missing — <Link to="/admin?tab=inventory&inv=prices">set a buying price</Link>
        </p>
      )}
      {p.provisional > 0 && (
        <p className="adm-ocard__muted" data-testid="order-profit-provisional">
          {formatTakaBd(p.provisional)} of the cost is provisional: some units were sold without stock. When the next lot arrives
          the real cost is used and the difference is recorded as a cost adjustment on that day.
        </p>
      )}
      {p.filled_adjustments !== 0 && (
        <p className="adm-ocard__muted">
          {p.filled_adjustments > 0
            ? `Cost of goods includes ${formatTakaBd(p.filled_adjustments)} extra, because the real price of a unit sold without stock turned out higher.`
            : `Cost of goods includes ${formatTakaBd(-p.filled_adjustments)} less, because the real price of a unit sold without stock turned out lower.`}
        </p>
      )}
      <p className="adm-ocard__muted">
        {p.status === 'cancelled'
          ? p.courier > 0
            ? "Cancelled: no sale; Steadfast's charge is the loss."
            : 'Cancelled: counts nothing.'
          : p.status === 'returned'
            ? `Returned${p.counted_at ? ` ${formatDhakaDateTime(p.counted_at)}` : ''}: the goods came back; the courier charge is the loss.`
            : p.counted_at
              ? `Counted in sales profit on ${formatDhakaDateTime(p.counted_at)} (Delivered).`
              : 'Counts in sales profit when the order is Delivered.'}
      </p>
    </section>
  );
}
