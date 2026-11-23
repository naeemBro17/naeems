import { useState, type CSSProperties, type FormEvent } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { MoneyInput } from '../shared/MoneyInput';
import { WhatsAppIcon } from '../expert/SocialLinks';
import { openExternal } from '../../lib/expertLinks';
import { formatTaka } from '../../lib/format';
import { takaTight } from '../../lib/advanceDiscount';
import {
  STORE_WALLET_CHIPS,
  STORE_WALLET_METHOD_NAMES,
  STORE_WALLET_MIN,
  sendStoreWalletRequest,
  storeWalletWhatsAppMessage,
  storeWalletWhatsAppUrl,
  type StoreWalletMethod,
} from '../../lib/storeWallet';

/** BD mobile numbers only: the same rule as the checkout's bKash / Nagad
 *  sender number. */
function isValidBangladeshiPhone(raw: string): boolean {
  return /^(\+?880|0)1[3-9]\d{8}$/.test(raw.replace(/[\s-]/g, ''));
}

const DUPLICATE = 'This transaction ID has already been used.';

interface Errors {
  amount?: string;
  trx?: string;
  sender?: string;
  form?: string;
}

interface Sent {
  amount: number;
  method: StoreWalletMethod;
  trx: string;
}

/**
 * Batch 60: "Add money". The customer sends money by bKash / Nagad to the
 * shop's number, types the transaction ID, and Submit sends a request that
 * waits for Naeem. Then "Almost there!" with the WhatsApp button.
 */
export function AddMoneySheet({
  isOpen,
  onClose,
  onSent,
  shopNumber,
  nagadAvailable,
  shopWhatsApp,
  customerName,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** A request was saved (the page loads the wallet again). */
  onSent: () => void;
  /** settings.shop_bkash_number (bKash and Nagad use the same number). */
  shopNumber: string;
  nagadAvailable: boolean;
  /** settings.shop_whatsapp_number. */
  shopWhatsApp: string;
  customerName: string;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<StoreWalletMethod>('bkash');
  const [trx, setTrx] = useState('');
  const [sender, setSender] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);

  const close = () => {
    onClose();
    if (sent) {
      setSent(null);
      setAmount('');
      setTrx('');
      setErrors({});
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const value = Number(amount);
    const next: Errors = {};
    if (!Number.isFinite(value) || value < STORE_WALLET_MIN) next.amount = `Minimum ${takaTight(STORE_WALLET_MIN)}`;
    if (trx.trim() === '') next.trx = 'Transaction ID is required';
    if (!isValidBangladeshiPhone(sender)) next.sender = 'Enter a valid number';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    const answer = await sendStoreWalletRequest({ amount: value, method, trxId: trx.trim(), sender: sender.trim() });
    setSaving(false);
    if (!answer.ok) {
      const text = answer.error ?? 'Could not send. Please try again.';
      if (text === DUPLICATE || text === 'Transaction ID is required' || /transaction id/i.test(text)) setErrors({ trx: text });
      else if (text.startsWith('Minimum')) setErrors({ amount: text });
      else if (text === 'Enter a valid number') setErrors({ sender: text });
      else setErrors({ form: text });
      return;
    }
    setSent({ amount: answer.data?.amount ?? value, method, trx: answer.data?.trxId || trx.trim().toUpperCase() });
    onSent();
  };

  const waUrl = sent
    ? storeWalletWhatsAppUrl(
        shopWhatsApp,
        storeWalletWhatsAppMessage({ amount: sent.amount, method: sent.method, trx: sent.trx, name: customerName })
      )
    : null;

  return (
    <BottomSheet isOpen={isOpen} onClose={close} title="Add money" panelClassName="mw-sheet">
      {sent ? (
        <div className="mw-done" data-testid="wallet-sent">
          <div className="mw-ring mw-in" style={{ '--mw-i': 0 } as CSSProperties} aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </div>
          <h2 className="mw-done__title mw-in" style={{ '--mw-i': 1 } as CSSProperties}>
            Almost there!
          </h2>
          <p className="mw-lead mw-in" style={{ '--mw-i': 2 } as CSSProperties}>
            We've got your request. Let us know on WhatsApp and we'll add it to your wallet right away.
          </p>
          <div className="mw-receipt mw-in" style={{ '--mw-i': 3 } as CSSProperties}>
            <div>
              <span>Amount</span>
              <b>{formatTaka(sent.amount)}</b>
            </div>
            <div>
              <span>Sent by</span>
              <b>{STORE_WALLET_METHOD_NAMES[sent.method]}</b>
            </div>
            <div>
              <span>Transaction ID</span>
              <b>{sent.trx}</b>
            </div>
          </div>
          {waUrl ? (
            <div className="mw-in" style={{ '--mw-i': 4 } as CSSProperties}>
              <button
                type="button"
                className="mw-btn mw-btn--wa"
                onClick={() => openExternal(waUrl)}
                data-testid="wallet-whatsapp"
                data-href={waUrl}
              >
                <span className="mw-wa-icon" aria-hidden="true">
                  <WhatsAppIcon />
                </span>
                Let us know on WhatsApp
              </button>
              <p className="mw-fine">You can close this page. Your balance updates as soon as we confirm.</p>
            </div>
          ) : (
            <p className="mw-fine mw-in" style={{ '--mw-i': 4 } as CSSProperties}>
              You can close this page. Your balance updates as soon as we confirm.
            </p>
          )}
        </div>
      ) : (
        <form className="mw-form" onSubmit={submit} noValidate data-testid="wallet-add-sheet">
          <label className="form-field">
            <span className="form-label">Amount</span>
            <MoneyInput
              className="mw-amount"
              inputMode="numeric"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setErrors((er) => ({ ...er, amount: undefined }));
              }}
              aria-label="Amount"
              data-testid="wallet-amount"
            />
          </label>
          <div className="mw-chips">
            {STORE_WALLET_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                className="mw-chip"
                onClick={() => {
                  setAmount(String(chip));
                  setErrors((er) => ({ ...er, amount: undefined }));
                }}
              >
                {takaTight(chip)}
              </button>
            ))}
          </div>
          {errors.amount && (
            <p className="form-error" role="alert">
              {errors.amount}
            </p>
          )}

          <div className="mw-methods" role="radiogroup" aria-label="Send by">
            <button
              type="button"
              role="radio"
              aria-checked={method === 'bkash'}
              className="mw-method mw-method--bkash"
              onClick={() => setMethod('bkash')}
              data-testid="wallet-method-bkash"
            >
              <b>bKash</b>
              <span>{shopNumber}</span>
            </button>
            {nagadAvailable && (
              <button
                type="button"
                role="radio"
                aria-checked={method === 'nagad'}
                className="mw-method mw-method--nagad"
                onClick={() => setMethod('nagad')}
                data-testid="wallet-method-nagad"
              >
                <b>Nagad</b>
                <span>{shopNumber}</span>
              </button>
            )}
          </div>
          <p className="mw-info">Send money to this number (Personal), then enter the transaction ID below. Minimum ৳500.</p>

          <label className="form-field">
            <span className="form-label">Transaction ID</span>
            <input
              className="form-input"
              type="text"
              autoComplete="off"
              value={trx}
              onChange={(e) => setTrx(e.target.value.toUpperCase())}
              placeholder="e.g. 9AK2XYZ1AB"
              data-testid="wallet-trx"
            />
          </label>
          {errors.trx && (
            <p className="form-error" role="alert">
              {errors.trx}
            </p>
          )}

          <label className="form-field">
            <span className="form-label">Your {STORE_WALLET_METHOD_NAMES[method]} number</span>
            <input
              className="form-input"
              type="tel"
              inputMode="tel"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
              placeholder="01XXXXXXXXX"
              data-testid="wallet-sender"
            />
          </label>
          {errors.sender && (
            <p className="form-error" role="alert">
              {errors.sender}
            </p>
          )}

          <p className="mw-fine mw-fine--left">
            Your wallet balance is for shopping with us. Use it on any order, anytime. It never expires and can't be refunded as cash.
          </p>
          {errors.form && (
            <p className="form-error" role="alert">
              {errors.form}
            </p>
          )}
          <button type="submit" className="mw-btn mw-btn--primary mw-submit" disabled={saving} data-testid="wallet-submit">
            {saving ? <span className="spinner" aria-hidden="true" /> : 'Submit'}
          </button>
        </form>
      )}
    </BottomSheet>
  );
}
