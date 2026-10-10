import { useEffect, useState } from 'react';
import { fetchOrderProfit } from '../../../lib/inventory/api';
import type { OrderProfit } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { formatTakaBd } from '../../../lib/adminNav';
import { formatDhakaDateTime } from '../../../lib/orderTracking';

function signedTaka(amount: number): string {
  return amount < 0 ? `−${formatTakaBd(-amount)}` : formatTakaBd(amount);
}

/**
 * Batch 39 Part 3: the order's profit — items sold, cost of goods (landed,
 * locked when the stock left), delivery collected, courier + COD fee, and
 * profit with margin. Only rendered for "View profit & costs"; the
 * database (order_profit) refuses everyone else. Counted on the day the
 * order became Delivered; a Returned order's loss is the courier charge.
 */
export function OrderProfitBox({ orderId, version }: { orderId: string; version: string }) {
  const [state, setState] = useState<LoadState<OrderProfit> | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchOrderProfit(orderId).then((answer) => {
      if (alive) setState(answer);
    });
    return () => {
      alive = false;
    };
  }, [orderId, version]);

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

  return (
    <section className="adm-ocard" aria-label="Profit" data-testid="order-profit">
      <h2 className="adm-ocard__title">Profit</h2>
      {!p.costed ? (
        <p className="adm-ocard__muted" data-testid="order-profit-no-cost">
          No cost (before inventory): this order did not take its stock from lots, so its profit is not known.
        </p>
      ) : (
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
          <div className="adm-ototals__row">
            <span>Courier + COD fee{p.courier_known ? '' : ' (not known yet)'}</span>
            <span>−{formatTakaBd(p.courier)}</span>
          </div>
          <div className="adm-ototals__row adm-ototals__row--strong" data-testid="order-profit-total">
            <span>Profit{p.margin !== null ? ` (${p.margin}%)` : ''}</span>
            <span>{signedTaka(p.profit)}</span>
          </div>
        </div>
      )}
      {p.costed && p.provisional > 0 && (
        <p className="adm-ocard__muted" data-testid="order-profit-provisional">
          {formatTakaBd(p.provisional)} of the cost is provisional: some units were sold without stock. When the next lot arrives
          the real cost is used and the difference is recorded as a cost adjustment on that day.
        </p>
      )}
      {p.costed && p.filled_adjustments !== 0 && (
        <p className="adm-ocard__muted">
          Cost adjustments for units sold without stock: {signedTaka(p.filled_adjustments)} (counted on the day the stock arrived).
        </p>
      )}
      <p className="adm-ocard__muted">
        {p.status === 'cancelled'
          ? 'Cancelled: counts nothing.'
          : p.status === 'returned'
            ? `Returned${p.counted_at ? ` ${formatDhakaDateTime(p.counted_at)}` : ''}: the goods came back; the courier charge is the loss.`
            : p.counted_at
              ? `Counted in sales profit on ${formatDhakaDateTime(p.counted_at)} (Delivered).`
              : 'Counts in sales profit when the order is Delivered.'}
      </p>
    </section>
  );
}
