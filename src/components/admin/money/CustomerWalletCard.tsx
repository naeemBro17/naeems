import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../hooks/useToast';
import { dhakaToday } from '../../../lib/inventory/api';
import { dayText, moneyText, parseAmount } from '../../../lib/money/format';
import { confirmPassword } from '../../../lib/reports/api';
import {
  STORE_WALLET_METHOD_NAMES,
  addToStoreWallet,
  confirmStoreWalletRequest,
  correctStoreWallet,
  defaultStoreWalletAccount,
  fetchCustomerStoreWallet,
  rejectStoreWalletRequest,
  setStoreWalletOpen,
  storeWalletEntryLabel,
  type CustomerStoreWallet,
  type StoreWalletWaiting,
} from '../../../lib/storeWallet';
import { usePayAccounts } from './LotPayments';
import { ConfirmSheet } from '../OrderActionCards';
import { Toggle } from '../edit-sheets/SheetChrome';

function signed(amount: number): string {
  return `${amount < 0 ? '−' : '+'}${moneyText(Math.abs(amount))}`;
}

function whenText(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/**
 * Batch 60: the customer's WALLET on their admin page (above TO RECEIVE;
 * only with "View profit & costs", the same permission that records their
 * payments). Balance, each waiting "I sent money" request with Confirm /
 * Reject, "Add to wallet" (money they sent on WhatsApp), the history, and
 * for the Super Admin "Correct" (password typed again).
 *
 * Batch 62: the "Wallet open" switch (wallets are by invitation). Add to
 * wallet opens it by itself; closing is refused while it holds money.
 */
export function CustomerWalletCard({ customerKey, onChanged }: { customerKey: string; onChanged?: () => void }) {
  const { isAdmin, session } = useAuth();
  const { showToast } = useToast();
  const accounts = usePayAccounts();
  const [wallet, setWallet] = useState<CustomerStoreWallet | null>(null);
  const [confirming, setConfirming] = useState<StoreWalletWaiting | null>(null);
  const [confirmAccount, setConfirmAccount] = useState('');
  const [rejecting, setRejecting] = useState<StoreWalletWaiting | null>(null);
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(dhakaToday());
  const [note, setNote] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [newBalance, setNewBalance] = useState('');
  const [why, setWhy] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setWallet(await fetchCustomerStoreWallet(customerKey));
  }, [customerKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  // Before migration-060 (or without permission) there is nothing to show.
  if (!wallet) return null;

  const changed = async (message: string) => {
    showToast(message);
    await load();
    onChanged?.();
  };

  const switchOpen = async (next: boolean) => {
    if (switching) return;
    setSwitchError(null);
    setSwitching(true);
    const answer = await setStoreWalletOpen(customerKey, next);
    setSwitching(false);
    if (!answer.ok) {
      setSwitchError(answer.error ?? 'Could not save');
      return;
    }
    await changed(answer.data ? 'Wallet opened' : 'Wallet closed');
  };

  const openConfirm = (w: StoreWalletWaiting) => {
    setError(null);
    setConfirmAccount(defaultStoreWalletAccount(accounts, w.method));
    setConfirming(w);
  };

  const doConfirm = async () => {
    if (!confirming) return;
    const answer = await confirmStoreWalletRequest(confirming.id, confirmAccount || null);
    if (!answer.ok) {
      setError(answer.error ?? 'Could not confirm');
      return;
    }
    const added = confirming.amount;
    setConfirming(null);
    await changed(`${moneyText(added)} added to the wallet`);
  };

  const doReject = async () => {
    if (!rejecting) return;
    const answer = await rejectStoreWalletRequest(rejecting.id, reason);
    if (!answer.ok) {
      setError(answer.error ?? 'Could not save');
      return;
    }
    setRejecting(null);
    setReason('');
    await changed('Request rejected');
  };

  const addValue = parseAmount(amount);
  const doAdd = async () => {
    setError(null);
    if (addValue === null || addValue <= 0) {
      setError('Type an amount above 0');
      return;
    }
    if (!accountId) {
      setError('Pick an account');
      return;
    }
    const answer = await addToStoreWallet({ customerKey, amount: addValue, accountId, date, note });
    if (!answer.ok) {
      setError(answer.error ?? 'Could not save');
      return;
    }
    setAdding(false);
    setAmount('');
    setNote('');
    await changed(`${moneyText(addValue)} added to the wallet`);
  };

  const doCorrect = async () => {
    setError(null);
    const value = parseAmount(newBalance);
    if (value === null || value < 0) {
      setError('Type the correct balance (0 or more)');
      return;
    }
    if (why.trim() === '') {
      setError('Write why it is corrected');
      return;
    }
    const wrong = await confirmPassword(session?.user.email, password);
    if (wrong) {
      setError(wrong);
      return;
    }
    const answer = await correctStoreWallet(customerKey, value, why.trim());
    if (!answer.ok) {
      setError(answer.error ?? 'Could not save');
      return;
    }
    setCorrecting(false);
    await changed(`Wallet corrected to ${moneyText(value)}`);
  };

  const accountSelect = (value: string, onChange: (id: string) => void, label: string) => (
    <label className="form-field">
      <span className="form-label">Received in</span>
      <select className="form-input" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );

  const errorLine = error ? (
    <p className="inv-error" role="alert" data-testid="wallet-admin-error">
      {error}
    </p>
  ) : null;

  return (
    <div className="adm-ocard inv-stack" data-testid="customer-wallet-card" data-own-save="">
      <h3 className="adm-group__title">WALLET</h3>
      {wallet.canSwitch && (
        <div className="inv-line" data-testid="customer-wallet-open">
          <span>
            <b>Wallet open</b>
            <span className="inv-muted mw-admin-open__hint">{wallet.open ? 'The customer can add money.' : 'Closed: the customer sees "Invite only".'}</span>
          </span>
          <Toggle checked={wallet.open} onChange={(next) => void switchOpen(next)} label="Wallet open" />
        </div>
      )}
      {switchError && (
        <p className="inv-error" role="alert" data-testid="customer-wallet-open-error">
          {switchError}
        </p>
      )}
      <div className="inv-line inv-line--total">
        <span>Balance</span>
        <b data-testid="customer-wallet-balance">{moneyText(wallet.balance)}</b>
      </div>

      {wallet.waiting.map((w) => (
        <div key={w.id} className="inv-stack money-wallet-wait" data-testid="customer-wallet-waiting">
          <div className="inv-line">
            <span>
              <b>{moneyText(w.amount)}</b> waiting · {STORE_WALLET_METHOD_NAMES[w.method]} · TrxID {w.trxId}
            </span>
          </div>
          <p className="inv-muted">
            {whenText(w.createdAt)}
            {w.sender ? ` · from ${w.sender}` : ''}
          </p>
          <div className="inv-actions">
            <button type="button" className="adm-btn adm-btn--primary adm-btn--sm" onClick={() => openConfirm(w)} data-testid="customer-wallet-confirm">
              Confirm
            </button>
            <button
              type="button"
              className="adm-btn adm-btn--sm"
              onClick={() => {
                setError(null);
                setReason('');
                setRejecting(w);
              }}
              data-testid="customer-wallet-reject"
            >
              Reject
            </button>
          </div>
        </div>
      ))}

      <div className="inv-actions">
        <button
          type="button"
          className="adm-btn"
          onClick={() => {
            setError(null);
            setDate(dhakaToday());
            setAdding(true);
          }}
          data-testid="customer-wallet-add"
        >
          Add to wallet
        </button>
        {isAdmin === true && (
          <button
            type="button"
            className="adm-btn adm-btn--ghost"
            onClick={() => {
              setError(null);
              setNewBalance('');
              setWhy('');
              setPassword('');
              setCorrecting(true);
            }}
            data-testid="customer-wallet-correct"
          >
            Correct
          </button>
        )}
      </div>

      {wallet.history.length > 0 && (
        <div className="inv-stack" data-testid="customer-wallet-history">
          <p className="inv-muted">History</p>
          {wallet.history.map((e) => (
            <div key={e.id} className="inv-line">
              <span>
                {dayText(e.date)} · {storeWalletEntryLabel(e)}
                {e.account ? ` · ${e.account}` : ''}
                {e.kind === 'correction' && e.note ? ` · ${e.note}` : ''}
                {e.by ? ` · ${e.by}` : ''}
              </span>
              <span className={e.amount > 0 ? 'money-in' : undefined}>{signed(e.amount)}</span>
            </div>
          ))}
        </div>
      )}
      {wallet.requests.some((r) => r.status === 'rejected') && (
        <div className="inv-stack">
          <p className="inv-muted">Rejected requests</p>
          {wallet.requests
            .filter((r) => r.status === 'rejected')
            .map((r) => (
              <p key={r.id} className="money-history">
                {moneyText(r.amount)} · {STORE_WALLET_METHOD_NAMES[r.method]} · TrxID {r.trxId}
                {r.reason ? ` · ${r.reason}` : ''}
                {r.by ? ` · ${r.by}` : ''}
              </p>
            ))}
        </div>
      )}

      <ConfirmSheet
        isOpen={confirming !== null}
        title={confirming ? `Confirm ${moneyText(confirming.amount)}?` : ''}
        keepLabel="Cancel"
        confirmLabel="Confirm"
        onConfirm={doConfirm}
        onClose={() => setConfirming(null)}
      >
        {confirming && (
          <p className="adm-csheet__text">
            {STORE_WALLET_METHOD_NAMES[confirming.method]}, TrxID {confirming.trxId}. Check you received it first. The money goes into the account
            below and into the customer&apos;s wallet.
          </p>
        )}
        {accountSelect(confirmAccount, setConfirmAccount, 'Received in account')}
        {errorLine}
      </ConfirmSheet>

      <ConfirmSheet
        isOpen={rejecting !== null}
        title={rejecting ? `Reject ${moneyText(rejecting.amount)}?` : ''}
        keepLabel="Cancel"
        confirmLabel="Reject"
        danger
        onConfirm={doReject}
        onClose={() => setRejecting(null)}
      >
        <p className="adm-csheet__text">No money moves. The customer sees &quot;We couldn&apos;t confirm&quot; and is asked to message you.</p>
        <label className="form-field">
          <span className="form-label">Reason (optional)</span>
          <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} aria-label="Reason" />
        </label>
        {errorLine}
      </ConfirmSheet>

      <ConfirmSheet
        isOpen={adding}
        title="Add to wallet"
        keepLabel="Cancel"
        confirmLabel={addValue !== null && addValue > 0 ? `Add ${moneyText(addValue)}` : 'Add'}
        onConfirm={doAdd}
        onClose={() => setAdding(false)}
      >
        <label className="form-field">
          <span className="form-label">Amount</span>
          <input
            className="form-input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="৳"
            aria-label="Amount"
            data-testid="customer-wallet-add-amount"
          />
        </label>
        {accountSelect(accountId, setAccountId, 'Received in')}
        <label className="form-field">
          <span className="form-label">Date</span>
          <input className="form-input" type="date" value={date} max={dhakaToday()} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
        </label>
        <label className="form-field">
          <span className="form-label">Note</span>
          <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} aria-label="Note" />
        </label>
        <p className="inv-muted">The money goes into this account and into the customer&apos;s wallet. It is not a sale.</p>
        {errorLine}
      </ConfirmSheet>

      <ConfirmSheet isOpen={correcting} title="Correct the wallet" keepLabel="Cancel" confirmLabel="Save" onConfirm={doCorrect} onClose={() => setCorrecting(false)}>
        <p className="adm-csheet__text">For a mistake only. No money moves; written to the Activity Log.</p>
        <p className="money-correct__now">
          <span>Now</span>
          <b>{moneyText(wallet.balance)}</b>
        </p>
        <label className="form-field">
          <span className="form-label">Correct balance</span>
          <input className="form-input" inputMode="decimal" value={newBalance} onChange={(e) => setNewBalance(e.target.value)} placeholder="৳" aria-label="Correct balance" />
        </label>
        <label className="form-field">
          <span className="form-label">Why</span>
          <input className="form-input" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={300} aria-label="Why" />
        </label>
        <label className="adm-csheet__type">
          <span>Type your password to confirm</span>
          <input className="form-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {errorLine}
      </ConfirmSheet>
    </div>
  );
}
