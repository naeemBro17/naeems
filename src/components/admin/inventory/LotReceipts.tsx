import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { deleteReceipt, fetchReceipts, receiptUrl, uploadReceipt } from '../../../lib/inventory/receipts';
import type { LotReceipt } from '../../../lib/inventory/types';
import { AdminIcon } from '../ui/AdminIcon';
import { formatLotDate } from './invFormat';

/**
 * Batch 45 Part 12: a lot's receipts. Lists names and dates only (loaded
 * once when the lot opens, never the files); a file is downloaded only when
 * it is tapped. Photos are made small in the browser before upload.
 */
export function LotReceipts({ lotId }: { lotId: string }) {
  const { showToast } = useToast();
  const [receipts, setReceipts] = useState<LotReceipt[] | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void fetchReceipts(lotId).then((rows) => {
      if (!alive) return;
      if (rows === null) setNotReady(true);
      setReceipts(rows ?? []);
    });
    return () => {
      alive = false;
    };
  }, [lotId]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    const added: LotReceipt[] = [];
    for (const file of Array.from(files)) {
      const answer = await uploadReceipt(lotId, file);
      if (answer.receipt) added.push(answer.receipt);
      else showToast(`${file.name}: ${answer.error ?? 'could not upload'}`, 'error');
    }
    setIsUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (added.length > 0) {
      setReceipts((list) => [...(list ?? []), ...added]);
      showToast(added.length === 1 ? 'Receipt added' : `${added.length} receipts added`);
    }
  };

  const handleOpen = async (receipt: LotReceipt) => {
    // Opened in a new tab so the link (10 minutes) is fetched only now.
    const win = window.open('', '_blank', 'noopener');
    const url = await receiptUrl(receipt.path);
    if (!url) {
      win?.close();
      showToast('Could not open the receipt.', 'error');
      return;
    }
    if (win) win.location.href = url;
    else window.location.assign(url);
  };

  const handleDelete = async (receipt: LotReceipt) => {
    const error = await deleteReceipt(receipt);
    setConfirmId(null);
    if (error) {
      showToast(error, 'error');
      return;
    }
    setReceipts((list) => (list ?? []).filter((r) => r.id !== receipt.id));
    showToast('Receipt deleted');
  };

  if (notReady) {
    return <p className="inv-muted">Receipts need the Batch 45 database step.</p>;
  }

  return (
    <div className="inv-receipts" data-testid="inv-receipts">
      {receipts === null ? (
        <p className="inv-muted">Loading…</p>
      ) : receipts.length === 0 ? (
        <p className="inv-muted">No receipts yet.</p>
      ) : (
        <ul className="inv-receipts__list">
          {receipts.map((r) => (
            <li key={r.id} className="inv-receipts__row" data-testid="inv-receipt">
              <button type="button" className="inv-receipts__open" onClick={() => void handleOpen(r)}>
                <AdminIcon name="receipt" className="adm-icon--sm" />
                <span className="inv-receipts__name">{r.file_name}</span>
                <span className="inv-muted">{formatLotDate(r.created_at.slice(0, 10))}</span>
              </button>
              {confirmId === r.id ? (
                <span className="inv-receipts__confirm">
                  <button type="button" className="adm-btn adm-btn--sm adm-btn--danger" onClick={() => void handleDelete(r)} data-testid="inv-receipt-delete-yes">
                    Delete
                  </button>
                  <button type="button" className="adm-btn adm-btn--sm adm-btn--ghost" onClick={() => setConfirmId(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button type="button" className="adm-icon-btn adm-icon-btn--plain" aria-label={`Delete ${r.file_name}`} onClick={() => setConfirmId(r.id)}>
                  <AdminIcon name="close" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        hidden
        onChange={(e) => void handleFiles(e.target.files)}
        data-testid="inv-receipt-input"
      />
      <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => fileRef.current?.click()} disabled={isUploading} data-testid="inv-add-receipt">
        {isUploading ? <span className="spinner" aria-hidden="true" /> : <AdminIcon name="plus" className="adm-icon--sm" />} Add receipt
      </button>
    </div>
  );
}
