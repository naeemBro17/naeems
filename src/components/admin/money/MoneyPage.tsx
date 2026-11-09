import { useEffect, useState } from 'react';
import { dhakaToday } from '../../../lib/inventory/api';
import type { LoadState } from '../../../lib/payouts';
import { fetchSummary } from '../../../lib/money/api';
import { dayText, moneyText, periodRange, signedMoney, type PeriodKind } from '../../../lib/money/format';
import type { MoneySummary } from '../../../lib/money/types';
import { AdminPageHeader, ChipRow, EmptyState, ListGroup, ListRow, SkeletonRows } from '../ui/AdminUi';
import { PayoutsToPlace } from './AccountsView';
import type { MoneyOpen } from './moneyNav';

function Line({ label, value, sign, strong, testId }: { label: string; value: number; sign?: '+' | '−' | '='; strong?: boolean; testId?: string }) {
  const text = sign === '=' ? signedMoney(value) : `${Math.round(value * 100) === 0 ? '' : (sign ?? '')}${moneyText(Math.abs(value))}`;
  return (
    <div className={`inv-line${strong ? ' inv-line--total' : ''}`} data-testid={testId}>
      <span>{label}</span>
      <span>{strong ? <b>{text}</b> : text}</span>
    </div>
  );
}

/**
 * Batch 41 Part 7: the Money page — one plain page. Your profit for the
 * period (every line shown), the return on money in the business, the money
 * now, and the balance check ("Books balance" in green, or a red line with
 * the difference and the first day it went wrong).
 */
export function MoneyPage({ onOpen }: { onOpen: MoneyOpen }) {
  const today = dhakaToday();
  const [period, setPeriod] = useState<PeriodKind>('month');
  const [custom, setCustom] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const [state, setState] = useState<LoadState<MoneySummary> | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const [reload, setReload] = useState(0);
  const range = periodRange(period, today, custom);

  useEffect(() => {
    if (!range.from || !range.to || range.to < range.from) return;
    let alive = true;
    setState(null);
    void fetchSummary(range.from, range.to).then((answer) => {
      if (alive) setState(answer);
    });
    return () => {
      alive = false;
    };
  }, [range.from, range.to, reload]);

  const data = state?.kind === 'ready' ? state.data : null;
  const p = data?.profit;
  const pos = data?.position;

  const addButton = (
    <button type="button" className="adm-btn adm-btn--primary" onClick={() => onOpen('add')} data-testid="money-add">
      Add money
    </button>
  );

  return (
    <section className="inv money" aria-label="Money">
      <AdminPageHeader title="Money" primary={addButton} />

      {data && !data.confirmed && (
        <div className="adm-ocard inv-stack" data-testid="money-not-started">
          <p className="inv-mode__title">Opening balances not confirmed yet</p>
          <p className="inv-muted">
            Type your accounts, customer dues and what you owe on your start date (Opening balances). Until then the balance check is off and
            the accounts show every entry ever made.
          </p>
          <button type="button" className="adm-btn" onClick={() => onOpen('opening')}>
            Open "Opening balances"
          </button>
        </div>
      )}

      <ChipRow
        label="Period"
        active={period}
        onSelect={(id) => setPeriod(id as PeriodKind)}
        chips={[
          { id: 'today', label: 'Today' },
          { id: 'month', label: 'This month' },
          { id: 'year', label: 'This year' },
          { id: 'custom', label: 'Custom' },
        ]}
      />
      {period === 'custom' && (
        <div className="inv-fields">
          <label className="form-field">
            <span className="form-label">From</span>
            <input className="form-input" type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="From date" />
          </label>
          <label className="form-field">
            <span className="form-label">To</span>
            <input className="form-input" type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="To date" />
          </label>
        </div>
      )}
      {period === 'custom' && custom.to < custom.from && <p className="inv-error">The end date is before the start date.</p>}

      {state === null ? (
        <SkeletonRows rows={6} thumb={false} />
      ) : !data || !p || !pos ? (
        <EmptyState icon="alert" title="Could not load" hint={state.kind === 'error' ? state.message : 'The Batch 41 database step has not been run.'} />
      ) : (
        <>
          <div className="adm-ocard inv-stack" data-testid="money-profit">
            <p className="inv-muted">
              {dayText(range.from)}
              {range.to !== range.from ? ` – ${dayText(range.to)}` : ''} · {p.orders} order{p.orders === 1 ? '' : 's'}
            </p>
            <p className="money-big-label">Your profit</p>
            <p className={`money-big${p.your_profit < 0 ? ' money-out' : ''}`} data-testid="money-your-profit">
              {signedMoney(p.your_profit)}
            </p>
            <Line label="Sales (after discounts)" value={p.sales} />
            <Line label={`Cost of goods${p.provisional > 0 ? ' (part provisional)' : ''}`} value={p.cost} sign="−" />
            <Line label="Delivery collected" value={p.delivery} sign="+" />
            <Line label="Courier & COD fee" value={p.courier} sign="−" />
            <Line label="Expenses" value={p.expenses} sign="−" testId="money-line-expenses" />
            <Line label="Stock removed (write-offs)" value={p.write_offs} sign="−" testId="money-line-writeoffs" />
            <Line label="Cost adjustments" value={p.cost_adjustments} sign={p.cost_adjustments < 0 ? '+' : '−'} />
            <Line label="Net profit" value={p.net_profit} sign="=" strong testId="money-net-profit" />
            <Line label="Investor profit share" value={p.profit_share} sign="−" />
            <Line label="Your profit" value={p.your_profit} sign="=" strong />
            <Line label="Your withdrawals" value={p.withdrawals} sign="−" />
            <Line label="Left in the business" value={p.left_in_business} sign="=" strong testId="money-left" />
            {p.uncosted_orders > 0 && (
              <p className="inv-muted">
                {p.uncosted_orders} order{p.uncosted_orders === 1 ? '' : 's'} from before Inventory mode (no lot cost) are left out, as in Sales profit.
              </p>
            )}
          </div>

          <div className="adm-ocard inv-stack" data-testid="money-roi">
            <div className="inv-line inv-line--total">
              <span>Return on money in the business</span>
              <b>{data.roi.percent === null ? '—' : `${data.roi.percent}%`}</b>
            </div>
            <p className="inv-muted money-formula">
              Net profit {moneyText(p.net_profit)} ÷ average money in the business {data.roi.average_money === null ? '—' : moneyText(data.roi.average_money)}{' '}
              (stock at landed cost + Cash + bKash + Bank + With Steadfast + customer dues − To give; the average of the start and the end of the
              period).
            </p>
          </div>

          <h2 className="inv-section">Money now</h2>
          <div className="adm-ocard inv-stack" data-testid="money-now">
            {pos.accounts
              .filter((a) => a.kind !== 'steadfast' && (!a.archived || a.balance !== 0))
              .map((a) => (
                <Line key={a.account_id} label={a.name} value={a.balance} sign="=" />
              ))}
            <Line label="With Steadfast" value={pos.with_steadfast} sign="=" testId="money-with-steadfast" />
            {pos.steadfast_reported !== null && (
              <p className="inv-muted">
                Steadfast&apos;s own balance: {moneyText(pos.steadfast_reported)}
                {pos.unplaced_payouts.length > 0 ? ' (payouts not placed yet are still counted here)' : ''}
              </p>
            )}
            <Line label="To receive (customers)" value={pos.to_receive + pos.previous_balances} sign="=" testId="money-to-receive" />
            {pos.previous_balances !== 0 && <p className="inv-muted">of it previous balances: {moneyText(pos.previous_balances)}</p>}
            <Line label="To give" value={pos.to_give} sign="=" testId="money-to-give" />
            <Line label="Stock at landed cost" value={pos.stock_value} sign="=" />
          </div>

          <PayoutsToPlace onPlaced={() => setReload((n) => n + 1)} />

          <div
            className={`adm-ocard inv-stack money-check${pos.balanced === true ? ' money-check--ok' : pos.balanced === false ? ' money-check--bad' : ''}`}
            data-testid="money-check"
          >
            {pos.balanced === null ? (
              <p className="inv-muted">The balance check starts when the opening balances are confirmed.</p>
            ) : pos.balanced ? (
              <p className="inv-ok" data-testid="money-books-balance">
                <b>Books balance</b>
              </p>
            ) : (
              <p className="inv-bad" role="alert" data-testid="money-books-off">
                <b>Books are off by {signedMoney(pos.difference ?? 0)}</b>
                {pos.first_wrong ? ` — first seen ${dayText(pos.first_wrong)}` : ''}
              </p>
            )}
            {pos.balanced !== null && (
              <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setShowCheck((v) => !v)} aria-expanded={showCheck}>
                {showCheck ? 'Hide the sums' : 'Show the sums'}
              </button>
            )}
            {showCheck && pos.balanced !== null && pos.opening && pos.since_start && (
              <div className="inv-stack" data-testid="money-check-sums">
                <p className="inv-muted">What the business has</p>
                <Line label="Accounts" value={pos.accounts_total} sign="=" />
                <Line label="With Steadfast" value={pos.with_steadfast} sign="=" />
                <Line label="Customers owe (orders)" value={pos.to_receive} sign="=" />
                <Line label="Previous balances" value={pos.previous_balances} sign="=" />
                <Line label="Stock at landed cost" value={pos.stock_value} sign="=" />
                <Line label="Goods on orders not delivered yet" value={pos.goods_on_open_orders} sign="=" />
                <p className="inv-muted">What it owes</p>
                <Line label="To give" value={pos.to_give} sign="=" />
                <Line label="Customers paid in advance" value={pos.customer_advances} sign="=" />
                <Line label="Price of orders not delivered yet (counted when delivered)" value={pos.open_orders_value} sign="=" />
                <Line label="Sold without stock (cost still to come)" value={pos.sold_without_stock} sign="=" />
                <Line label="Has − owes" value={pos.net_worth} sign="=" strong />
                <p className="inv-muted">Should be (since {dayText(pos.start_date)})</p>
                <Line label="Opening net worth" value={pos.opening.total} sign="=" />
                <Line label="Net profit" value={pos.since_start.net_profit} sign="=" />
                <Line label="Investor profit share" value={pos.since_start.profit_share} sign="−" />
                <Line label="Your withdrawals" value={pos.since_start.withdrawals} sign="−" />
                <Line label="Your money put in" value={pos.since_start.owner_money_in} sign="+" />
                <Line label="Not shop money (in − out)" value={pos.since_start.not_shop_money} sign="=" />
                <Line label="Count differences" value={pos.since_start.count_differences} sign="=" />
                <Line label="Orders from before Inventory mode (outside profit)" value={pos.outside} sign="=" />
                <Line label="Should be" value={pos.expected ?? 0} sign="=" strong />
              </div>
            )}
          </div>
        </>
      )}

      <ListGroup title="MONEY">
        <ListRow icon="receipt" label="Expenses" onClick={() => onOpen('expenses')} />
        <ListRow icon="payouts" label="Accounts" detail={pos ? moneyText(pos.accounts_total) : undefined} onClick={() => onOpen('accounts')} />
        <ListRow icon="customers" label="Investors and what I owe" detail={pos ? moneyText(pos.to_give) : undefined} onClick={() => onOpen('people')} />
        <ListRow icon="chart" label="End-of-day count" onClick={() => onOpen('count')} />
        <ListRow icon="restock" label="Stock removed (write-offs)" onClick={() => onOpen('writeoffs')} />
        <ListRow icon="settings" label="Expense categories" onClick={() => onOpen('categories')} />
        <ListRow icon="lock" label="Opening balances" detail={data ? (data.confirmed ? `Since ${dayText(pos?.start_date ?? null)}` : 'Not confirmed') : undefined} onClick={() => onOpen('opening')} />
      </ListGroup>
    </section>
  );
}
