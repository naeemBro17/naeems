import { useEffect, useState } from 'react';
import { typedNumber } from '../../../../lib/kaarbar/merge';
import { BottomSheet } from '../../../shared/BottomSheet';
import '../../../../styles/kaarbarMerge.css';

/**
 * Batch 54, mockup screen 4: "Add as a new product" — a hidden product
 * (never shown in the shop) with its buying price. The same sheet asks only
 * for the buying price when a picked site product has none.
 */
export function AddProductSheet({
  isOpen,
  mode,
  initialName,
  productLabel,
  onClose,
  onDone,
}: {
  isOpen: boolean;
  mode: 'new' | 'price';
  initialName: string;
  /** The picked product (price mode). */
  productLabel?: string;
  onClose: () => void;
  onDone: (name: string, price: number) => void;
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(initialName);
    setPrice('');
    setError(null);
  }, [isOpen, initialName]);

  const done = () => {
    const n = typedNumber(price);
    if (mode === 'new' && name.trim() === '') {
      setError('Type a name.');
      return;
    }
    if (n === null || n <= 0 || n >= 100000000) {
      setError('Type a buying price above 0.');
      return;
    }
    onDone(name.trim(), Math.round(n * 100) / 100);
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={mode === 'new' ? 'Add as a new product' : 'Buying price'} panelClassName="km-sheet">
      <div className="km-sheet__body" data-testid="merge-add-sheet">
        {mode === 'new' ? (
          <label className="form-field">
            <span className="form-label">Name</span>
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={300} data-testid="merge-add-name" />
          </label>
        ) : (
          <p className="km-picked">{productLabel}</p>
        )}
        <label className="form-field">
          <span className="form-label">Buying price (per pack)</span>
          <input
            className="form-input km-price-input"
            inputMode="decimal"
            placeholder="৳"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            data-testid="merge-add-price"
          />
        </label>
        {mode === 'new' && <p className="km-note">It is added as a hidden product: never shown in the shop. You can show it later from Products.</p>}
        {error && (
          <p className="km-sheet__error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="km-btn km-btn--orange" onClick={done} data-testid="merge-add-go">
          {mode === 'new' ? 'Add and match' : 'Match'}
        </button>
        <button type="button" className="km-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </BottomSheet>
  );
}

export interface LineValues {
  name: string;
  quantity: number;
  rate: number;
  discount: number;
  total: number;
}

/** A line added by hand (name, quantity, rate, line total), or the numbers
 *  of a line read from the PDF corrected. */
export function LineSheet({
  isOpen,
  mode,
  start,
  onClose,
  onDone,
}: {
  isOpen: boolean;
  mode: 'add' | 'correct-hand' | 'correct-pdf';
  start: LineValues | null;
  onClose: () => void;
  onDone: (values: LineValues) => void;
}) {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [rate, setRate] = useState('');
  const [discount, setDiscount] = useState('');
  const [total, setTotal] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const text = (n: number | undefined) => (n === undefined || (mode === 'add' && n === 0) ? '' : String(n));
    setName(start?.name ?? '');
    setQuantity(text(start?.quantity ?? (mode === 'add' ? 1 : undefined)));
    setRate(text(start?.rate));
    setDiscount(text(start?.discount));
    setTotal(text(start?.total));
    setError(null);
  }, [isOpen, start, mode]);

  const done = () => {
    const q = typedNumber(quantity);
    const r = typedNumber(rate) ?? 0;
    const d = discount.trim() === '' ? 0 : typedNumber(discount);
    const t = total.trim() === '' ? (q !== null && d !== null ? Math.round((q * r - d) * 100) / 100 : null) : typedNumber(total);
    if (mode !== 'correct-pdf' && name.trim() === '') return setError('Type the item name as in Kaarbar.');
    if (q === null || q <= 0) return setError('Type a quantity above 0.');
    if (d === null) return setError('Type the discount, or leave it empty.');
    if (t === null || t < 0) return setError('Type the line total.');
    onDone({ name: name.trim(), quantity: q, rate: r, discount: d, total: t });
  };

  const title = mode === 'add' ? 'Add a missing item' : 'Correct this line';
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={title} panelClassName="km-sheet">
      <div className="km-sheet__body" data-testid="merge-line-sheet">
        {mode === 'correct-pdf' ? (
          <p className="km-picked">{start?.name}</p>
        ) : (
          <label className="form-field">
            <span className="form-label">Name (as in Kaarbar)</span>
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={300} data-testid="merge-line-name" />
          </label>
        )}
        <div className="km-two">
          <label className="form-field">
            <span className="form-label">Quantity</span>
            <input className="form-input km-price-input" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} data-testid="merge-line-qty" />
          </label>
          <label className="form-field">
            <span className="form-label">Rate</span>
            <input className="form-input km-price-input" inputMode="decimal" placeholder="৳" value={rate} onChange={(e) => setRate(e.target.value)} data-testid="merge-line-rate" />
          </label>
          <label className="form-field">
            <span className="form-label">Discount</span>
            <input className="form-input km-price-input" inputMode="decimal" placeholder="৳" value={discount} onChange={(e) => setDiscount(e.target.value)} data-testid="merge-line-discount" />
          </label>
          <label className="form-field">
            <span className="form-label">Line total</span>
            <input className="form-input km-price-input" inputMode="decimal" placeholder="৳" value={total} onChange={(e) => setTotal(e.target.value)} data-testid="merge-line-total" />
          </label>
        </div>
        {error && (
          <p className="km-sheet__error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="km-btn km-btn--orange" onClick={done} data-testid="merge-line-save">
          {mode === 'add' ? 'Add the item' : 'Save'}
        </button>
        <button type="button" className="km-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </BottomSheet>
  );
}
