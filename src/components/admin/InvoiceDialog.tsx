import { useEffect, useRef, useState } from 'react';
import { Modal } from '../shared/Modal';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import type { InvoiceData } from '../../lib/invoice/invoiceData';
import {
  canShareInvoice,
  downloadInvoice,
  makeInvoiceFile,
  printInvoice,
  shareInvoice,
  type InvoiceFile,
} from '../../lib/invoice/invoiceOutput';
import { recordInvoicePrints } from '../../lib/invoice/invoicePrints';

interface InvoiceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  fileName: string;
  /** Gathers the orders (fetching what it needs); runs once per opening. */
  build: () => Promise<{ invoices: InvoiceData[]; orderIds: string[] }>;
  /** After the invoices were printed, downloaded or shared (and remembered). */
  onPrinted?: () => void;
}

/**
 * Batch 37: the invoice is made as soon as the dialog opens (so Share has
 * the file ready), then Print (the one main action), Download PDF and,
 * where the device can, Share. Any of the three counts as printed.
 */
export function InvoiceDialog({ isOpen, onClose, title, fileName, build, onPrinted }: InvoiceDialogProps) {
  const { settings } = useProducts();
  const { showToast } = useToast();
  const [file, setFile] = useState<InvoiceFile | null>(null);
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const recorded = useRef(false);
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setFile(null);
    setError(null);
    recorded.current = false;
    void (async () => {
      try {
        const { invoices, orderIds: ids } = await buildRef.current();
        if (invoices.length === 0) throw new Error('No orders to print.');
        const made = await makeInvoiceFile(invoices, settings, fileName);
        if (!alive) return;
        setOrderIds(ids);
        setFile(made);
      } catch (e) {
        if (alive) setError(e instanceof Error && e.message ? e.message : 'Could not make the invoice.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, fileName, settings]);

  const remember = async () => {
    if (recorded.current) return;
    recorded.current = true;
    const result = await recordInvoicePrints(orderIds);
    if (!result.ok && result.error) showToast(result.error, 'error');
    onPrinted?.();
  };

  const handlePrint = async () => {
    if (!file) return;
    await printInvoice(file);
    await remember();
  };

  const handleDownload = async () => {
    if (!file) return;
    downloadInvoice(file);
    await remember();
  };

  const handleShare = async () => {
    if (!file) return;
    if (await shareInvoice(file)) await remember();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <div className="invoice-dialog" data-testid="invoice-dialog">
        {error ? (
          <p className="form-error" role="alert">
            {error} Check the connection and try again.
          </p>
        ) : !file ? (
          <p className="invoice-dialog__status" role="status">
            <span className="spinner" aria-hidden="true" /> Making the invoice…
          </p>
        ) : (
          <>
            <p className="invoice-dialog__status" role="status" data-testid="invoice-ready">
              Ready: {file.pageCount} A4 page{file.pageCount === 1 ? '' : 's'}.
            </p>
            <p className="invoice-dialog__hint">
              Print on A4 at <strong>Actual size</strong> (100%), not &quot;Fit to page&quot;, so the barcode scans.
            </p>
          </>
        )}
        <div className="confirm-actions invoice-dialog__actions">
          {file && canShareInvoice(file) && (
            <button type="button" className="button button--secondary" onClick={() => void handleShare()}>
              Share
            </button>
          )}
          <button type="button" className="button button--secondary" onClick={() => void handleDownload()} disabled={!file}>
            Download PDF
          </button>
          <button type="button" className="button button--primary" onClick={() => void handlePrint()} disabled={!file}>
            Print
          </button>
        </div>
      </div>
    </Modal>
  );
}
