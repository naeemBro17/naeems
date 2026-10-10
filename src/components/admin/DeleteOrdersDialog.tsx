import { useEffect, useState } from 'react';
import { Modal } from '../shared/Modal';
import type { Order } from '../../types';

interface DeleteOrdersDialogProps {
  orders: Pick<Order, 'id' | 'order_number' | 'status' | 'steadfast_consignment_id'>[];
  isOpen: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/** Word the admin must type to delete more than one order at once. */
export const BULK_DELETE_WORD = 'DELETE';

/**
 * The "are you sure" step before orders are deleted (Batch 24 Part 4).
 * Plain English, a warning for every parcel already booked on Steadfast
 * (deleting here does not cancel it there), and the admin types the order
 * number (one order) or DELETE (several) before the button turns on.
 */
export function DeleteOrdersDialog({ orders, isOpen, onConfirm, onClose }: DeleteOrdersDialogProps) {
  const [typed, setTyped] = useState('');
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    if (isOpen) setTyped('');
  }, [isOpen]);

  const booked = orders.filter((o) => o.steadfast_consignment_id);
  // Fix (1.38.1): one order → type its number's digits (NM-2851 → 2851);
  // several → type DELETE. Nothing is deleted on one tap.
  const word = orders.length === 1 ? orders[0].order_number.replace(/D/g, '') : BULK_DELETE_WORD;
  const canConfirm = typed.trim() === word;
  const restoresStock = orders.some((o) => o.status !== 'cancelled');

  const handleConfirm = async () => {
    setIsWorking(true);
    try {
      await onConfirm();
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={orders.length === 1 ? `Delete order ${orders[0].order_number}?` : `Delete ${orders.length} orders?`}
    >
      <p className="confirm-message">
        {orders.length === 1 ? 'This order' : `These ${orders.length} orders`} and {orders.length === 1 ? 'its' : 'their'}{' '}
        items and history will be removed for good. This cannot be undone.
        {restoresStock && ' Stock for the items will be put back.'} The Activity Log keeps a record of the delete.
      </p>
      {booked.map((o) => (
        <p key={o.id} className="delete-orders__warning" role="alert">
          {o.order_number}: This parcel is booked on Steadfast (consignment {o.steadfast_consignment_id}). Deleting
          here does NOT cancel it on Steadfast. Cancel it on the Steadfast portal too.
        </p>
      ))}
      <div className="form-field delete-orders__type">
        <label className="form-label" htmlFor="delete-orders-confirm">
          Type {word} to confirm
        </label>
        <input
          id="delete-orders-confirm"
          className="form-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoCapitalize="characters"
          inputMode={orders.length === 1 ? 'numeric' : 'text'}
          autoComplete="off"
          spellCheck={false}
          data-testid="delete-orders-input"
        />
      </div>
      <div className="confirm-actions">
        <button type="button" className="button button--secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={handleConfirm}
          disabled={!canConfirm || isWorking}
        >
          {isWorking ? <span className="spinner" aria-hidden="true" /> : orders.length === 1 ? 'Delete order' : 'Delete orders'}
        </button>
      </div>
    </Modal>
  );
}
