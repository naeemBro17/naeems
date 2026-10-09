import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../hooks/useToast';
import {
  fetchPayouts,
  fetchSyncState,
  fetchUnpaidOrders,
  monthLabel,
  monthOptions,
  monthTotals,
  overdueOrders,
  payoutFeesPaisa,
  payoutPill,
  shortDhakaDate,
  syncPayouts,
  takaExact,
  takaWhole,
  updatedAgo,
  dhakaMonthKey,
  UNPAID_AFTER_DAYS,
  type LoadState,
  type Payout,
  type SyncState,
  type UnpaidOrder,
} from '../../lib/payouts';
import { toPaisa } from '../../../supabase/functions/_shared/steadfastPayouts';
import { AdminPageHeader, EmptyState, SkeletonRows } from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';
import '../../styles/adminPayouts.css';

interface PayoutsTabProps {
  onOpenPayout: (payoutId: string) => void;
  onOpenOrder: (orderNumber: string) => void;
}

/**
 * Admin → Steadfast payouts (Batch 36 Part 1, mockup screen 1): what
 * Steadfast still holds, this month in short, orders not paid after 7
 * days, and every payout. Only "View profit & costs" opens it, and the
 * database shows these numbers to nobody else.
 */
export function PayoutsTab({ onOpenPayout, onOpenOrder }: PayoutsTabProps) {
  const { showToast } = useToast();
  const [payouts, setPayouts] = useState<LoadState<Payout[]> | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [unpaid, setUnpaid] = useState<UnpaidOrder[]>([]);
  const [month, setMonth] = useState(() => dhakaMonthKey(new Date().toISOString()));
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [list, state, open] = await Promise.all([fetchPayouts(), fetchSyncState(), fetchUnpaidOrders()]);
    setPayouts(list);
    setSync(state);
    setUnpaid(open);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setIsRefreshing(true);
    const answer = await syncPayouts();
    await load();
    setIsRefreshing(false);
    showToast(answer.ok ? 'Payouts updated' : (answer.error ?? 'Could not refresh'), answer.ok ? 'success' : 'error');
  };

  const list = payouts?.kind === 'ready' ? payouts.data : [];
  const months = useMemo(() => monthOptions(list), [list]);
  const totals = useMemo(() => monthTotals(list, month), [list, month]);
  const overdue = useMemo(() => overdueOrders(unpaid), [unpaid]);

  const refreshButton = (
    <button type="button" className="adm-btn" onClick={refresh} disabled={isRefreshing} data-testid="payouts-refresh">
      {isRefreshing ? <span className="spinner" aria-hidden="true" /> : 'Refresh'}
    </button>
  );

  return (
    <section aria-label="Steadfast payouts" className="adm-payouts">
      <AdminPageHeader title="Steadfast payouts" primary={refreshButton} />

      {payouts === null ? (
        <SkeletonRows rows={5} thumb={false} />
      ) : payouts.kind === 'no-db' ? (
        <EmptyState
          icon="payouts"
          title="Payouts are not set up yet"
          hint="The Batch 36 database step has not been run. Run it, then tap Refresh."
        />
      ) : payouts.kind === 'error' ? (
        <EmptyState icon="alert" title="Could not load payouts" hint={payouts.message} />
      ) : (
        <>
          <div className="adm-ocard adm-payouts__balance" data-testid="payouts-balance">
            <p className="adm-payouts__label">Steadfast balance (not yet paid to you)</p>
            <p className="adm-payouts__big" title={sync?.current_balance != null ? takaExact(toPaisa(sync.current_balance)) : undefined}>
              {sync?.current_balance != null ? takaWhole(toPaisa(sync.current_balance)) : '—'}
            </p>
            <p className="adm-ocard__muted">
              From {unpaid.length} delivered order{unpaid.length === 1 ? '' : 's'} · {updatedAgo(sync?.balance_at ?? null)}
            </p>
          </div>

          {overdue.length > 0 && (
            <div className="adm-payouts__alert" role="status" data-testid="payouts-overdue">
              <AdminIcon name="alert" className="adm-payouts__alert-icon" />
              <div>
                <p className="adm-payouts__alert-title">
                  {overdue.length} order{overdue.length === 1 ? '' : 's'} not paid after {UNPAID_AFTER_DAYS} days
                </p>
                <p className="adm-payouts__alert-orders">
                  {overdue.map((o, i) => (
                    <span key={o.order_id}>
                      {i > 0 && ', '}
                      <button type="button" className="adm-payouts__link" onClick={() => onOpenOrder(o.order_number)}>
                        {o.order_number}
                      </button>
                    </span>
                  ))}
                  {' · delivered '}
                  {shortDhakaDate(overdue[overdue.length - 1].delivered_at)}
                  {overdue.length > 1 && overdue[0].delivered_at.slice(0, 10) !== overdue[overdue.length - 1].delivered_at.slice(0, 10)
                    ? ` or earlier`
                    : ''}
                </p>
              </div>
            </div>
          )}

          <div className="adm-ocard adm-payouts__month" data-testid="payouts-month">
            <div className="adm-ocard__head">
              <h2 className="adm-ocard__title">This month</h2>
              <select
                className="adm-payouts__month-select"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                aria-label="Month"
              >
                {months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </div>
            <div className="adm-payouts__line">
              <span>COD collected</span>
              <span title={takaExact(totals.codPaisa)}>{takaWhole(totals.codPaisa)}</span>
            </div>
            <div className="adm-payouts__line">
              <span>Courier charges</span>
              <span title={takaExact(-totals.chargesPaisa)}>− {takaWhole(totals.chargesPaisa)}</span>
            </div>
            <div className="adm-payouts__line">
              <span>COD fee (1%)</span>
              <span title={takaExact(-totals.codFeePaisa)}>− {takaWhole(totals.codFeePaisa)}</span>
            </div>
            <div className="adm-payouts__line adm-payouts__line--total">
              <span>Received in bank/bKash</span>
              <span title={takaExact(totals.receivedPaisa)} data-testid="payouts-month-received">
                {takaWhole(totals.receivedPaisa)}
              </span>
            </div>
          </div>

          <h2 className="adm-payouts__section">Payouts</h2>
          {list.length === 0 ? (
            <EmptyState icon="payouts" title="No payouts yet" hint="Tap Refresh to read them from Steadfast." />
          ) : (
            <div className="adm-payouts__list" data-testid="payouts-list">
              {list.map((p) => {
                const pill = payoutPill(p);
                const orders = p.items.length || p.parcel_count;
                return (
                  <button key={p.id} type="button" className="adm-payouts__row" onClick={() => onOpenPayout(p.id)}>
                    <span className="adm-payouts__row-main">
                      <span className="adm-payouts__row-title">
                        {p.paid_at ? `${shortDhakaDate(p.paid_at)} · ` : ''}Payout #{p.steadfast_payment_id}
                      </span>
                      <span className="adm-payouts__row-sub">
                        {orders} order{orders === 1 ? '' : 's'} · fees {takaWhole(payoutFeesPaisa(p))}
                      </span>
                    </span>
                    <span className="adm-payouts__row-side">
                      <b title={takaExact(toPaisa(p.total_amount))}>{takaWhole(toPaisa(p.total_amount))}</b>
                      <span className={`adm-payouts__pill adm-payouts__pill--${pill.tone}`}>{pill.text}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
