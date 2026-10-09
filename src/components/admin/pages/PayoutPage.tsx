import { useEffect, useState } from 'react';
import {
  fetchPayout,
  itemFeesPaisa,
  payoutPill,
  reasonText,
  takaExact,
  takaWhole,
  type LoadState,
  type Payout,
} from '../../../lib/payouts';
import { formatDhakaDateTime } from '../../../../supabase/functions/_shared/orderTracking';
import { toPaisa } from '../../../../supabase/functions/_shared/steadfastPayouts';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';
import '../../../styles/adminPayouts.css';

interface PayoutPageProps {
  payoutId: string;
  onBack: () => void;
  onOpenOrder: (orderNumber: string) => void;
}

/**
 * /admin/payouts/:id (Batch 36 Part 1, mockup screen 2): which orders were
 * in one Steadfast payout, the fees per order and what Naeem got.
 */
export function PayoutPage({ payoutId, onBack, onOpenOrder }: PayoutPageProps) {
  const [state, setState] = useState<LoadState<Payout | null> | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchPayout(payoutId).then((answer) => {
      if (alive) setState(answer);
    });
    return () => {
      alive = false;
    };
  }, [payoutId]);

  const payout = state?.kind === 'ready' ? state.data : null;
  const title = payout ? `Payout #${payout.steadfast_payment_id}` : 'Payout';

  return (
    <section aria-label={title} className="adm-payouts">
      <AdminPageHeader title={title} onBack={onBack} backLabel="Back to payouts" />
      {state === null ? (
        <SkeletonRows rows={6} thumb={false} />
      ) : state.kind === 'no-db' ? (
        <EmptyState icon="payouts" title="Payouts are not set up yet" hint="The Batch 36 database step has not been run." />
      ) : state.kind === 'error' ? (
        <EmptyState icon="alert" title="Could not load this payout" hint={state.message} />
      ) : !payout ? (
        <EmptyState icon="payouts" title="Payout not found" />
      ) : (
        <PayoutDetail payout={payout} onOpenOrder={onOpenOrder} />
      )}
    </section>
  );
}

function PayoutDetail({ payout, onOpenOrder }: { payout: Payout; onOpenOrder: (orderNumber: string) => void }) {
  const pill = payoutPill(payout);
  const orders = payout.items.length || payout.parcel_count;
  const sum = payout.items.reduce(
    (t, i) => ({
      cod: t.cod + toPaisa(i.cod_collected),
      fees: t.fees + itemFeesPaisa(i),
      net: t.net + toPaisa(i.net_paid),
    }),
    { cod: 0, fees: 0, net: 0 }
  );
  const amount = toPaisa(payout.total_amount) || sum.net;
  const anyOther = payout.items.some((i) => toPaisa(i.other_deduction) !== 0);

  return (
    <>
      <div className="adm-ocard adm-payouts__balance" data-testid="payout-summary">
        <div className="adm-ocard__head">
          <span className={`adm-payouts__pill adm-payouts__pill--${pill.tone}`} data-testid="payout-pill">
            {pill.text}
          </span>
          {payout.paid_at && <span className="adm-ocard__muted">Paid {formatDhakaDateTime(payout.paid_at)}</span>}
        </div>
        <p className="adm-payouts__big" title={takaExact(amount)}>
          {takaWhole(amount)}
        </p>
        <p className="adm-ocard__muted">
          Payout #{payout.steadfast_payment_id} · {orders} order{orders === 1 ? '' : 's'}
        </p>
      </div>

      <div className="adm-ocard adm-payouts__table-card">
        <table className="adm-payouts__table" data-testid="payout-table">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">COD</th>
              <th scope="col">Fees</th>
              <th scope="col">You get</th>
            </tr>
          </thead>
          <tbody>
            {payout.items.map((item) => {
              const label = item.invoice ?? item.consignment_id ?? '—';
              const reason = reasonText(item);
              return (
                <tr key={item.id} className={item.match_status === 'to_check' ? 'is-check' : undefined}>
                  <td>
                    {item.order_id && item.invoice ? (
                      <button type="button" className="adm-payouts__link" onClick={() => onOpenOrder(item.invoice ?? '')}>
                        {label}
                      </button>
                    ) : (
                      <span>{label}</span>
                    )}
                    {reason && (
                      <span className="adm-payouts__reason" data-testid="payout-reason">
                        To check: {reason}
                      </span>
                    )}
                  </td>
                  <td title={takaExact(toPaisa(item.cod_collected))}>{takaWhole(toPaisa(item.cod_collected))}</td>
                  <td title={takaExact(-itemFeesPaisa(item))}>−{takaWhole(itemFeesPaisa(item)).replace('৳', '')}</td>
                  <td title={takaExact(toPaisa(item.net_paid))}>{takaWhole(toPaisa(item.net_paid))}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td title={takaExact(sum.cod)}>{takaWhole(sum.cod)}</td>
              <td title={takaExact(-sum.fees)}>−{takaWhole(sum.fees).replace('৳', '')}</td>
              <td title={takaExact(sum.net)} data-testid="payout-total">
                {takaWhole(sum.net)}
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="adm-payouts__note">
          Fees = delivery charge + 1% COD fee{anyOther ? ' + anything else Steadfast kept (for example a return charge)' : ''}.
          Each order page now shows “Steadfast paid ৳… on …”.
        </p>
      </div>
    </>
  );
}
