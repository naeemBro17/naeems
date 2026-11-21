import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { mobileKey, numberLabel, phoneText, type CustomerNumber, type NumberOwner } from '../../../lib/customerNumbers';
import { addCustomerNumber, fetchCustomerNumbers, removeCustomerNumber } from '../../../lib/customerNumbersApi';
import { BottomSheet } from '../../shared/BottomSheet';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { AdminIcon } from '../ui/AdminIcon';
import '../../../styles/kaarbarMerge.css';
import '../../../styles/customerTools.css';

const CANT_REMOVE = "Orders, dues or Kaarbar bills use this number, so it can't be removed.";

/** Runs `go` once a sheet that was just closed has taken its own history
 *  entry off (leaving in the same moment would step back twice). */
export function afterSheetCloses(go: () => void): void {
  if ((window.history.state as { modalBackCloseId?: string } | null)?.modalBackCloseId) {
    window.addEventListener('popstate', () => go(), { once: true });
    return;
  }
  go();
}

/**
 * Batch 55, mockup screen 1: PHONE NUMBERS on the customer page (Super
 * Admin). The main number, then the extra numbers (old / second numbers);
 * orders, dues and Kaarbar bills on any of them belong to this customer.
 * `onReady(false)` when the numbers can't be loaded (migration-056 not
 * run), so the page keeps its old phone line.
 */
export function CustomerNumbersCard({
  customerKey,
  name,
  onJoin,
  onReady,
}: {
  customerKey: string;
  name: string;
  onJoin: (pickKey?: string) => void;
  onReady: (ok: boolean) => void;
}) {
  const { showToast } = useToast();
  const [numbers, setNumbers] = useState<CustomerNumber[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [phone, setPhone] = useState('');
  const [owner, setOwner] = useState<NumberOwner | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<CustomerNumber | null>(null);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const load = useCallback(async () => {
    const answer = await fetchCustomerNumbers(customerKey);
    if (answer.ok) setNumbers(answer.data);
    onReadyRef.current(answer.ok);
  }, [customerKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!adding) {
      setPhone('');
      setOwner(null);
      setError(null);
    }
  }, [adding]);

  const openJoin = (pickKey?: string) => {
    if (!adding) {
      onJoin(pickKey);
      return;
    }
    setAdding(false);
    afterSheetCloses(() => onJoin(pickKey));
  };

  const save = async () => {
    const key = mobileKey(phone);
    if (!key) {
      setError('Enter a valid Bangladeshi mobile number (01XXXXXXXXX).');
      return;
    }
    setSaving(true);
    setError(null);
    const answer = await addCustomerNumber(customerKey, key, 'added');
    setSaving(false);
    if (!answer.ok) {
      setError(answer.error);
      return;
    }
    if (answer.data.kind === 'owner') {
      setOwner(answer.data.owner);
      return;
    }
    if (answer.data.kind === 'same') {
      setError(`${phoneText(key)} is already ${name}'s number.`);
      return;
    }
    setAdding(false);
    showToast(`Added ${phoneText(key)} to ${name}`);
    await load();
  };

  const askRemove = (n: CustomerNumber) => {
    if (!n.can_remove) {
      showToast(CANT_REMOVE, 'error');
      return;
    }
    setRemoving(n);
  };

  const remove = async () => {
    if (!removing) return;
    const answer = await removeCustomerNumber(customerKey, removing.phone_key);
    const removed = removing;
    setRemoving(null);
    if (!answer.ok) {
      showToast(answer.error, 'error');
      return;
    }
    showToast(`Removed ${phoneText(removed.phone)} from ${name}`);
    await load();
  };

  if (numbers === null) return null;

  return (
    <section className="ct-section" data-testid="customer-numbers">
      <h3 className="km-title">PHONE NUMBERS</h3>
      <div className="km-card ct-numbers">
        {numbers.map((n) => (
          <div key={n.phone_key} className="ct-num" data-testid="customer-number">
            <div className="ct-num__text">
              <b className="ct-num__value">{phoneText(n.phone)}</b>
              <span className="ct-num__sub">{numberLabel(n)}</span>
            </div>
            {n.is_main ? (
              <span className="km-chip km-chip--neutral">Main</span>
            ) : (
              <button
                type="button"
                className="ct-dots"
                aria-label={`More for ${phoneText(n.phone)}`}
                onClick={() => askRemove(n)}
                data-testid="customer-number-more"
              >
                <AdminIcon name="dots" />
              </button>
            )}
          </div>
        ))}
        <div className="ct-num__add">
          <button type="button" className="km-link" onClick={() => setAdding(true)} data-testid="customer-number-add">
            + Add a number
          </button>
        </div>
      </div>
      <p className="km-note ct-pad">Orders, dues and Kaarbar bills on any of these numbers belong to this customer.</p>

      <BottomSheet isOpen={adding} onClose={() => setAdding(false)} title="Add a number" panelClassName="km-sheet">
        <div className="km-sheet__body" data-testid="customer-number-sheet">
          <label className="form-field">
            <span className="form-label">Phone number</span>
            <input
              className="form-input"
              inputMode="tel"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setOwner(null);
                setError(null);
              }}
              placeholder="01XXXXXXXXX"
              data-testid="customer-number-input"
            />
          </label>
          <p className="km-note">Use this for the customer&apos;s old or second number.</p>
          {owner && (
            <>
              <p className="km-check km-check--bad" role="alert" data-testid="customer-number-owner">
                {`${phoneText(phone)} belongs to ${owner.name} (${owner.orders} orders).`}
              </p>
              <button type="button" className="km-btn km-btn--dark" onClick={() => openJoin(owner.key)} data-testid="customer-number-join">
                {`Merge ${owner.name} into this customer`}
              </button>
            </>
          )}
          {error && (
            <p className="km-sheet__error" role="alert">
              {error}
            </p>
          )}
          {!owner && (
            <button type="button" className="km-btn km-btn--dark" onClick={() => void save()} disabled={saving} data-testid="customer-number-save">
              Save
            </button>
          )}
          <button type="button" className="km-btn" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      </BottomSheet>

      <ConfirmDialog
        isOpen={removing !== null}
        title="Remove this number?"
        message={removing ? `${phoneText(removing.phone)} will no longer be linked to ${name}.` : ''}
        confirmLabel="Remove"
        danger
        onConfirm={remove}
        onClose={() => setRemoving(null)}
      />
    </section>
  );
}
