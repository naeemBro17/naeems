import { useCallback, useEffect, useState } from 'react';
import {
  coveredByOpening,
  fetchBooksStart,
  fetchPayout,
  isOutsideParcel,
  isSettled,
  itemFeesPaisa,
  payoutOrderCount,
  payoutPill,
  reasonText,
  settledByText,
  takaExact,
  takaWhole,
  unsettlePayoutLine,
  type LoadState,
  type Payout,
  type PayoutItem,
} from '../../../lib/payouts';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../hooks/useToast';
import { SettleLineSheet } from '../SettleLineSheet';
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
  const [booksStart, setBooksStart] = useState<string | null>(null);
  // Batch 47: settling is the Super Admin's (the database checks it too).
  const { isAdmin } = useAuth();

  useEffect(() => {
    let alive = true;
    void fetchPayout(payoutId).then((answer) => {
      if (alive) setState(answer);
    });
    void fetchBooksStart().then((start) => {
      if (alive) setBooksStart(start);
    });
    return () => {
      alive = false;
    };
  }, [payoutId]);

  const reload = useCallback(async () => {
    setState(await fetchPayout(payoutId));
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
        <PayoutDetail payout={payout} booksStart={booksStart} onOpenOrder={onOpenOrder} canSettle={isAdmin} onChanged={reload} />
      )}
    </section>
  );
}

/** Batch 51: "0" when nothing was kept — never "−0". */
function feesText(paisa: number): string {
  return paisa === 0 ? '0' : `−${takaWhole(paisa).replace('৳', '')}`;
}

function PayoutDetail({
  payout,
  booksStart,
  onOpenOrder,
  canSettle,
  onChanged,
}: {
  payout: Payout;
  booksStart: string | null;
  onOpenOrder: (orderNumber: string) => void;
  canSettle: boolean;
  onChanged: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [settling, setSettling] = useState<PayoutItem | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const pill = payoutPill(payout, booksStart);
  // Batch 51: paid before the money start date — in the opening balances.
  const covered = coveredByOpening(payout.paid_at, booksStart);

  const undo = async (item: PayoutItem) => {
    setUndoing(item.id);
    const result = await unsettlePayoutLine(item.id);
    setUndoing(null);
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast('Settle undone');
    await onChanged();
  };
  const orders = payoutOrderCount(payout);
  const sum = payout.items.reduce(
    (t, i) => ({
      cod: t.cod + toPaisa(i.cod_collected),
      fees: t.fees + itemFeesPaisa(i),
      net: t.net + toPaisa(i.net_paid),
    }),
    { cod: 0, fees: 0, net: 0 }
  );
  // Batch 51: Steadfast's own total, also when it is ৳0 (it always equals
  // the lines' sum — Batch 46).
  const amount = toPaisa(payout.total_amount);
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
              // Booked on Steadfast's website: grey, never "to check".
              // Batch 47: settled (by hand or Batch 46): green, with why,
              // who and when; anything not matched can be settled.
              const settled = isSettled(item);
              const outside = isOutsideParcel(item) && !settled;
              const toCheck = item.match_status === 'to_check' && !outside;
              const label = item.invoice ?? (item.consignment_id ? `Parcel ${item.consignment_id}` : '—');
              const reason = outside && covered ? 'Booked on Steadfast · in the opening balances' : reasonText(item);
              const by = settled ? settledByText(item) : null;
              return (
                <tr key={item.id} className={toCheck ? 'is-check' : settled ? 'is-settled' : undefined} data-testid="payout-line">
                  <td>
                    {item.order_id && item.invoice ? (
                      <button type="button" className="adm-payouts__link" onClick={() => onOpenOrder(item.invoice ?? '')}>
                        {label}
                      </button>
                    ) : (
                      <span>{label}</span>
                    )}
                    {reason && (
                      <span
                        className={`adm-payouts__reason${settled ? ' adm-payouts__reason--settled' : outside ? ' adm-payouts__reason--outside' : ''}`}
                        data-testid="payout-reason"
                      >
                        {toCheck ? `To check: ${reason}` : settled ? `Settled: ${reason}` : reason}
                      </span>
                    )}
                    {by && <span className="adm-payouts__settled-by">{by}</span>}
                    {canSettle && item.match_status === 'to_check' && !settled && (
                      <button type="button" className="adm-payouts__action" onClick={() => setSettling(item)} data-testid="payout-settle">
                        Settle
                      </button>
                    )}
                    {canSettle && settled && (
                      <button
                        type="button"
                        className="adm-payouts__action"
                        onClick={() => void undo(item)}
                        disabled={undoing === item.id}
                        data-testid="payout-undo"
                      >
                        Undo
                      </button>
                    )}
                  </td>
                  <td title={takaExact(toPaisa(item.cod_collected))}>{takaWhole(toPaisa(item.cod_collected))}</td>
                  <td title={takaExact(-itemFeesPaisa(item))}>{feesText(itemFeesPaisa(item))}</td>
                  <td title={takaExact(toPaisa(item.net_paid))}>{takaWhole(toPaisa(item.net_paid))}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td title={takaExact(sum.cod)}>{takaWhole(sum.cod)}</td>
              <td title={takaExact(-sum.fees)}>{feesText(sum.fees)}</td>
              <td title={takaExact(sum.net)} data-testid="payout-total">
                {takaWhole(sum.net)}
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="adm-payouts__note">
          Fees = delivery charge + 1% COD fee{anyOther ? ' + anything else Steadfast kept (for example a return charge)' : ''}.
          Steadfast reports these fees for the whole payout; each order’s share is worked out from them, so the
          total is exact. Each order page now shows “Steadfast paid ৳… on …”.
        </p>
      </div>

      <SettleLineSheet
        item={settling}
        onClose={() => setSettling(null)}
        onSettled={async () => {
          setSettling(null);
          showToast('Line settled');
          await onChanged();
        }}
      />
    </>
  );
}
