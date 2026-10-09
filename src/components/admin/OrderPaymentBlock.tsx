import { useState } from 'react';
import { MoneyInput } from '../shared/MoneyInput';
import { BottomSheet } from '../shared/BottomSheet';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { useToast } from '../../hooks/useToast';
import { formatTaka } from '../../lib/format';
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_NAMES,
  PAYMENT_STATE_LABELS,
  addOrderPayment,
  deleteOrderPayment,
  markOrderFullyPaid,
  updateOrderPayment,
  type OrderPayment,
  type PaymentInput,
  type PaymentKind,
  type PaymentMethodId,
  type PaymentSummary,
} from '../../lib/payments';
import { courierCod } from '../../lib/paymentPlan';
import type { OrderWithDetails } from '../../types';

const STATE_TONE: Record<PaymentSummary['state'], 'neutral' | 'info' | 'success' | 'danger'> = {
  unpaid: 'neutral',
  partly_paid: 'info',
  paid: 'success',
  refunded: 'danger',
};

function paidTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** datetime-local value in Dhaka time ("2026-10-05T14:30"). */
function toLocalInput(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  const dhaka = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  return dhaka.toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const asUtc = new Date(`${value}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return null;
  return new Date(asUtc.getTime() - 6 * 60 * 60 * 1000).toISOString();
}

interface FormState {
  amount: string;
  method: PaymentMethodId;
  trxId: string;
  paidAt: string;
  note: string;
  kind: PaymentKind;
}

function MethodChips({ value, onChange }: { value: PaymentMethodId; onChange: (m: PaymentMethodId) => void }) {
  return (
    <div className="chip-group" role="group" aria-label="How it was paid">
      {PAYMENT_METHODS.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`chip-select${value === m.id ? ' chip-select--on' : ''}`}
          aria-pressed={value === m.id}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Batch 30 Part 3: Total · Paid · Due, the payment state, every payment
 * (with who recorded it), and Add payment / Mark fully paid. Editing or
 * deleting a payment is Super Admin only. Every action is checked again by
 * the database and lands in History and the Activity Log.
 */
export function OrderPaymentBlock({
  order,
  payments,
  summary,
  canRecord,
  isAdmin,
  onChanged,
  onConfirmBkash,
  isConfirmingBkash,
}: {
  order: OrderWithDetails;
  payments: OrderPayment[];
  summary: PaymentSummary;
  canRecord: boolean;
  isAdmin: boolean;
  onChanged: () => Promise<void>;
  /** The old "Mark as paid" for a bKash TrxID still waiting for a check. */
  onConfirmBkash: () => void;
  isConfirmingBkash: boolean;
}) {
  const { showToast } = useToast();
  const [sheet, setSheet] = useState<'add' | 'edit' | 'full' | null>(null);
  const [editing, setEditing] = useState<OrderPayment | null>(null);
  const [form, setForm] = useState<FormState>({ amount: '', method: 'bkash', trxId: '', paidAt: '', note: '', kind: 'payment' });
  const [isSaving, setIsSaving] = useState(false);
  const [deleting, setDeleting] = useState<OrderPayment | null>(null);

  const pendingBkash = order.payment_method === 'bkash' && order.payment_status === 'pending_verification' && Boolean(order.bkash_trx_id);

  const openAdd = () => {
    setForm({ amount: summary.due > 0 ? String(summary.due) : '', method: 'bkash', trxId: '', paidAt: toLocalInput(null), note: '', kind: 'payment' });
    setSheet('add');
  };
  const openFull = () => {
    setForm({ amount: String(summary.due), method: 'cash', trxId: '', paidAt: '', note: '', kind: 'payment' });
    setSheet('full');
  };
  const openEdit = (p: OrderPayment) => {
    setEditing(p);
    setForm({ amount: String(p.amount), method: p.method, trxId: p.trx_id ?? '', paidAt: toLocalInput(p.paid_at), note: p.note ?? '', kind: p.kind });
    setSheet('edit');
  };

  const save = async () => {
    const amount = Math.round(Number(form.amount) * 100) / 100;
    if (sheet !== 'full' && (!Number.isFinite(amount) || amount <= 0)) {
      showToast('Enter an amount more than 0.', 'error');
      return;
    }
    const input: PaymentInput = {
      amount,
      method: form.method,
      trxId: form.trxId,
      paidAt: fromLocalInput(form.paidAt),
      note: form.note,
      kind: form.kind,
    };
    setIsSaving(true);
    const { error } =
      sheet === 'full'
        ? await markOrderFullyPaid(order.id, form.method, form.trxId, form.note)
        : sheet === 'edit' && editing
          ? await updateOrderPayment(editing.id, input)
          : await addOrderPayment(order.id, input);
    setIsSaving(false);
    if (error) {
      showToast(error, 'error');
      return;
    }
    showToast(sheet === 'full' ? 'Marked fully paid' : sheet === 'edit' ? 'Payment changed' : form.kind === 'refund' ? 'Refund recorded' : 'Payment added');
    setSheet(null);
    setEditing(null);
    await onChanged();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const { error } = await deleteOrderPayment(deleting.id);
    setDeleting(null);
    if (error) {
      showToast(error, 'error');
      return;
    }
    showToast('Payment deleted');
    await onChanged();
  };

  return (
    <section className="order-detail__section order-pay" data-testid="payment-block">
      <div className="order-detail__section-title-row">
        <h2 className="order-detail__section-title">Payment</h2>
        <span className={`status-badge status-badge--${STATE_TONE[summary.state]}`} data-testid="payment-state">
          {PAYMENT_STATE_LABELS[summary.state]}
        </span>
      </div>

      <div className="order-pay__figures">
        <div>
          <span className="order-pay__label">Total</span>
          <span className="order-pay__value" data-testid="payment-total">{formatTaka(summary.total)}</span>
        </div>
        <div>
          <span className="order-pay__label">Paid</span>
          <span className="order-pay__value" data-testid="payment-paid">{formatTaka(summary.paid)}</span>
        </div>
        <div>
          <span className="order-pay__label">Due</span>
          <span className="order-pay__value order-pay__value--due" data-testid="payment-due">{formatTaka(summary.due)}</span>
        </div>
      </div>
      {summary.due > 0 && order.status !== 'cancelled' && (order.collect_mode === 'pay_later' || order.status !== 'delivered') && (
        <p className="order-pay__mode" data-testid="payment-collect-mode">
          {order.collect_mode === 'pay_later'
            ? `Customer pays later · courier collects ${formatTaka(0)}`
            : `Courier collects ${formatTaka(courierCod(summary.total, summary.paid, order.collect_mode))} on delivery`}
        </p>
      )}
      {summary.overpaid > 0 && (
        <p className="order-pay__over" data-testid="payment-overpaid">
          Over-paid {formatTaka(summary.overpaid)}
        </p>
      )}

      {pendingBkash && (
        <div className="order-pay__pending">
          <span>
            bKash advance · TrxID {order.bkash_trx_id}
            {order.bkash_sender ? ` · from ${order.bkash_sender}` : ''}
            <span className="order-pay__pending-tag">Not checked yet</span>
          </span>
          {canRecord && (
            <button type="button" className="button button--secondary button--small" onClick={onConfirmBkash} disabled={isConfirmingBkash}>
              {isConfirmingBkash ? <span className="spinner" aria-hidden="true" /> : 'Confirm received'}
            </button>
          )}
        </div>
      )}

      {payments.length > 0 && (
        <ul className="order-pay__list" aria-label="Payments">
          {payments.map((p) => (
            <li key={p.id} className="order-pay__row" data-testid="payment-row">
              <span className="order-pay__row-main">
                <span className="order-pay__row-title">
                  {p.kind === 'refund' ? 'Refund · ' : ''}
                  {PAYMENT_METHOD_NAMES[p.method]}
                  {p.trx_id ? ` · TrxID ${p.trx_id}` : ''}
                </span>
                <span className="order-pay__row-sub">
                  {paidTime(p.paid_at)}
                  {p.created_by_username ? ` · by ${p.created_by_username}` : ''}
                  {p.note ? ` · ${p.note}` : ''}
                </span>
              </span>
              <span className={`order-pay__row-amount${p.kind === 'refund' ? ' order-pay__row-amount--refund' : ''}`}>
                {p.kind === 'refund' ? '−' : ''}
                {formatTaka(p.amount)}
              </span>
              {isAdmin && (
                <span className="order-pay__row-actions">
                  <button type="button" className="account-card__edit" onClick={() => openEdit(p)} aria-label={`Edit payment ${formatTaka(p.amount)}`}>
                    Edit
                  </button>
                  <button type="button" className="account-card__edit" onClick={() => setDeleting(p)} aria-label={`Delete payment ${formatTaka(p.amount)}`}>
                    Delete
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {order.steadfast_status?.startsWith('partial_delivered') && (
        <p className="order-pay__note">Partly delivered — check the amount Steadfast collected, then add it as a payment.</p>
      )}

      {canRecord && (
        <div className="order-pay__actions">
          <button type="button" className="button button--secondary button--small" onClick={openAdd}>
            Add payment
          </button>
          {summary.due > 0 && (
            <button type="button" className="button button--secondary button--small" onClick={openFull}>
              Mark fully paid
            </button>
          )}
        </div>
      )}

      <BottomSheet
        isOpen={sheet !== null}
        onClose={() => {
          setSheet(null);
          setEditing(null);
        }}
        title={sheet === 'full' ? 'Mark fully paid' : sheet === 'edit' ? 'Edit payment' : 'Add payment'}
      >
        <form
          className="form order-pay__form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {sheet === 'full' ? (
            <p className="admin-panel__description">
              Records one payment of <strong>{formatTaka(summary.due)}</strong> so nothing is due.
            </p>
          ) : (
            <>
              {sheet === 'add' && isAdmin && (
                <div className="chip-group" role="group" aria-label="Payment or refund">
                  <button type="button" className={`chip-select${form.kind === 'payment' ? ' chip-select--on' : ''}`} onClick={() => setForm((f) => ({ ...f, kind: 'payment' }))}>
                    Payment
                  </button>
                  <button type="button" className={`chip-select${form.kind === 'refund' ? ' chip-select--on' : ''}`} onClick={() => setForm((f) => ({ ...f, kind: 'refund' }))}>
                    Refund
                  </button>
                </div>
              )}
              <div className="form-field">
                <label className="form-label" htmlFor="pay-amount">
                  Amount (৳)
                </label>
                <MoneyInput
                  id="pay-amount"
                  min="0"
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                />
              </div>
            </>
          )}
          <div className="form-field">
            <span className="form-label">Method</span>
            <MethodChips value={form.method} onChange={(method) => setForm((f) => ({ ...f, method }))} />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="pay-trx">
              Transaction ID (optional)
            </label>
            <input id="pay-trx" type="text" className="form-input" value={form.trxId} onChange={(e) => setForm((f) => ({ ...f, trxId: e.target.value }))} />
          </div>
          {sheet !== 'full' && (
            <div className="form-field">
              <label className="form-label" htmlFor="pay-date">
                Date and time
              </label>
              <input id="pay-date" type="datetime-local" className="form-input" value={form.paidAt} onChange={(e) => setForm((f) => ({ ...f, paidAt: e.target.value }))} />
            </div>
          )}
          <div className="form-field">
            <label className="form-label" htmlFor="pay-note">
              Note (optional)
            </label>
            <input id="pay-note" type="text" className="form-input" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          </div>
          <div className="edit-sheet__footer">
            <button type="button" className="edit-sheet__cancel" onClick={() => setSheet(null)} disabled={isSaving}>
              Cancel
            </button>
            <button type="submit" className="edit-sheet__save" disabled={isSaving}>
              {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
            </button>
          </div>
        </form>
      </BottomSheet>

      <ConfirmDialog
        isOpen={deleting !== null}
        title="Delete this payment?"
        message={deleting ? `${PAYMENT_METHOD_NAMES[deleting.method]} ${formatTaka(deleting.amount)} will be removed. This is logged in History.` : ''}
        confirmLabel="Delete payment"
        cancelLabel="Keep"
        danger
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
      />
    </section>
  );
}
