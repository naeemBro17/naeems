import { useState } from 'react';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  /** Hide the confirm button (e.g. category with products can't be deleted). */
  confirmLabel?: string | null;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [isWorking, setIsWorking] = useState(false);

  const handleConfirm = async () => {
    setIsWorking(true);
    try {
      await onConfirm();
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <p className="confirm-message">{message}</p>
      <div className="confirm-actions">
        <button type="button" className="button button--secondary" onClick={onClose}>
          {cancelLabel}
        </button>
        {confirmLabel !== null && (
          <button
            type="button"
            className={`button ${danger ? 'button--danger' : 'button--primary'}`}
            onClick={handleConfirm}
            disabled={isWorking}
          >
            {isWorking ? <span className="spinner" aria-hidden="true" /> : confirmLabel}
          </button>
        )}
      </div>
    </Modal>
  );
}
