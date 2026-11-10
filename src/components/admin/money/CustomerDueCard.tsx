import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useToast } from '../../../hooks/useToast';
import { useProducts } from '../../../contexts/ProductContext';
import { copyToClipboard } from '../../../lib/clipboard';
import { openExternal } from '../../../lib/expertLinks';
import { dhakaToday } from '../../../lib/inventory/api';
import { addDuePayment, deleteDuePayment, fetchCustomerDues, fetchCustomerHistory, recordReminder } from '../../../lib/money/api';
import { customerOrderLink, dayText, moneyText, parseAmount, reminderMessage, reminderWhatsAppUrl } from '../../../lib/money/format';
import type { CustomerDue, CustomerMoneyHistory } from '../../../lib/money/types';
import { usePayAccounts } from './LotPayments';
import { ConfirmSheet } from '../OrderActionCards';

function dhakaDayOf(iso: string): string {
  return dayText(dhakaToday(new Date(iso)));
}

/**
 * Batch 41 Part 4: on the customer page (only with "View profit & costs"):
 * what they owe (site orders + previous balance), "Send due reminder"
 * (WhatsApp with the Settings text and a link to their own order page on
 * this site), "Copy message", the reminders already sent, and money
 * received against a previous balance.
 */
export function CustomerDueCard({
  customerKey,
  name,
  phone,
  orderDue,
}: {
  customerKey: string;
  name: string;
  phone: string;
  /** The site orders' due the page already shows. */
  orderDue: number;
}) {
  const { showToast } = useToast();
  const { settings } = useProducts();
  const accounts = usePayAccounts();
  const [due, setDue] = useState<CustomerDue | null>(null);
  const [history, setHistory] = useState<CustomerMoneyHistory | null>(null);
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(dhakaToday());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; amount: number } | null>(null);

  const load = useCallback(async () => {
    const [dues, hist] = await Promise.all([fetchCustomerDues(), fetchCustomerHistory(customerKey, phone)]);
    setDue(dues.get(customerKey) ?? null);
    setHistory(hist);
  }, [customerKey, phone]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  if (!history) return null;

  const previous = history.previous_left;
  const sitesDue = due?.order_due ?? orderDue;
  const total = sitesDue + previous;
  const orderId = sitesDue > 0 ? (due?.latest_unpaid_order_id ?? null) : null;
  const link = orderId ? customerOrderLink(window.location.origin, orderId) : null;
  const text = reminderMessage(settings.due_reminder_template ?? '', { name, due: total, date: dhakaToday(), link });
  const waUrl = reminderWhatsAppUrl(phone, text);

  const send = async () => {
    if (!waUrl) return;
    openExternal(waUrl);
    const answer = await recordReminder({ customerKey, phone, amount: total, orderId, how: 'whatsapp' });
    if (!answer.ok) showToast(answer.error ?? 'The reminder was not written in the history', 'error');
    await load();
  };

  const copy = async () => {
    const ok = await copyToClipboard(text);
    showToast(ok ? 'Message copied' : 'Could not copy', ok ? 'success' : 'error');
    if (ok) {
      await recordReminder({ customerKey, phone, amount: total, orderId, how: 'copied' });
      await load();
    }
  };

  const pay = async (e: FormEvent) => {
    e.preventDefault();
    const value = parseAmount(amount);
    if (value === null || value <= 0) {
      showToast('Type an amount above 0', 'error');
      return;
    }
    setSaving(true);
    const answer = await addDuePayment({ phone, amount: value, accountId, date, note });
    setSaving(false);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not save', 'error');
      return;
    }
    showToast(`Previous balance paid: ${moneyText(value)}`);
    setPaying(false);
    setAmount('');
    setNote('');
    await load();
  };

  const remove = async () => {
    if (!deleting) return;
    const answer = await deleteDuePayment(deleting.id, Math.round(deleting.amount));
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not delete', 'error');
      return;
    }
    setDeleting(null);
    showToast('Payment deleted');
    await load();
  };

  return (
    <div className="adm-ocard inv-stack money-due" data-testid="customer-due-card">
      <h3 className="adm-group__title">TO RECEIVE</h3>
      <div className="inv-line">
        <span>Site orders</span>
        <span>{moneyText(sitesDue)}</span>
      </div>
      {(previous !== 0 || history.previous.length > 0) && (
        <div className="inv-line">
          <span>Previous balance</span>
          <span data-testid="customer-previous-balance">{moneyText(previous)}</span>
        </div>
      )}
      <div className="inv-line inv-line--total">
        <span>Total due</span>
        <b data-testid="customer-total-due">{moneyText(total)}</b>
      </div>

      {total > 0 && (
        <>
          <pre className="money-message" data-testid="customer-reminder-text">
            {text}
          </pre>
          <div className="inv-actions">
            <button type="button" className="adm-btn adm-btn--primary" onClick={() => void send()} disabled={!waUrl} data-testid="customer-send-reminder">
              Send due reminder
            </button>
            <button type="button" className="adm-btn" onClick={() => void copy()} data-testid="customer-copy-reminder">
              Copy message
            </button>
          </div>
          {!waUrl && <p className="inv-muted">This customer has no phone number WhatsApp can use.</p>}
        </>
      )}

      {history.reminders.length > 0 && (
        <div className="inv-stack" data-testid="customer-reminders">
          <p className="inv-muted">Reminders</p>
          {history.reminders.map((r) => (
            <p key={r.at} className="money-history">
              Due reminder {r.how === 'whatsapp' ? 'sent' : 'copied'}, {moneyText(r.amount)}, {dhakaDayOf(r.at)}
            </p>
          ))}
        </div>
      )}

      {history.payments.length > 0 && (
        <div className="inv-stack">
          <p className="inv-muted">Previous balance payments</p>
          {history.payments.map((p) => (
            <div key={p.id} className="inv-line">
              <span>
                {dayText(p.date)} · {p.account}
                {p.note ? ` · ${p.note}` : ''}
              </span>
              <span>
                {moneyText(p.amount)}{' '}
                <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm adm-btn--danger-text" onClick={() => setDeleting({ id: p.id, amount: p.amount })}>
                  Delete…
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {previous > 0 && !paying && (
        <button type="button" className="adm-btn" onClick={() => setPaying(true)} data-testid="customer-pay-previous">
          Record a payment of the previous balance
        </button>
      )}
      {paying && (
        <form className="inv-stack" onSubmit={pay} noValidate>
          <div className="inv-fields">
            <label className="form-field">
              <span className="form-label">Amount</span>
              <input className="form-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount received" />
            </label>
            <label className="form-field">
              <span className="form-label">Into</span>
              <select className="form-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Into account">
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="inv-fields">
            <label className="form-field">
              <span className="form-label">Date</span>
              <input className="form-input" type="date" value={date} max={dhakaToday()} onChange={(e) => setDate(e.target.value)} aria-label="Date received" />
            </label>
            <label className="form-field">
              <span className="form-label">Note</span>
              <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Payment note" />
            </label>
          </div>
          <p className="inv-muted">For site orders, record the payment on the order itself.</p>
          <div className="inv-actions">
            <button type="button" className="adm-btn" onClick={() => setPaying(false)}>
              Cancel
            </button>
            <button type="submit" className="adm-btn" disabled={saving}>
              {saving ? <span className="spinner" aria-hidden="true" /> : 'Save payment'}
            </button>
          </div>
        </form>
      )}

      <ConfirmSheet
        isOpen={deleting !== null}
        title={deleting ? `Delete the payment of ${moneyText(deleting.amount)}?` : ''}
        typeToConfirm={deleting ? String(Math.round(deleting.amount)) : undefined}
        keepLabel="Keep"
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      >
        <p className="adm-csheet__text">The previous balance goes back up by this amount. Written to the Activity Log.</p>
      </ConfirmSheet>
    </div>
  );
}
