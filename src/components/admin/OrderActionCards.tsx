import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
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
import { fetchInvoicePrintedAt, recordInvoicePrints } from '../../lib/invoice/invoicePrints';
import { formatDhakaDateTime } from '../../lib/orderTracking';
import { AdminIcon } from './ui/AdminIcon';

/** "NM-2851" → "2851": what the admin types to confirm a careful action. */
export function orderDigits(orderNumber: string): string {
  return orderNumber.replace(/\D/g, '');
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="adm-icon adm-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------ Invoice card */

interface OrderInvoiceCardProps {
  orderId: string;
  orderNumber: string;
  /** Makes this order's invoice data (the Batch 37 generator's input). */
  build: () => InvoiceData;
  /** Print is the page's one orange button only when nothing else is. */
  printIsPrimary: boolean;
  onPrinted: () => void;
}

/**
 * Fix (1.38.1): the invoice has its own card near the top. Its three buttons
 * only print, save or share the PDF — nothing here changes the order.
 */
export function OrderInvoiceCard({ orderId, orderNumber, build, printIsPrimary, onPrinted }: OrderInvoiceCardProps) {
  const { settings } = useProducts();
  const { showToast } = useToast();
  const [printedAt, setPrintedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<'print' | 'download' | 'share' | null>(null);
  const fileRef = useRef<InvoiceFile | null>(null);
  const buildRef = useRef(build);
  buildRef.current = build;
  const fileName = `Invoice-${orderNumber}.pdf`;

  useEffect(() => {
    let alive = true;
    void fetchInvoicePrintedAt(orderId).then((at) => {
      if (alive) setPrintedAt(at);
    });
    return () => {
      alive = false;
    };
  }, [orderId]);

  // A new PDF whenever the order or the settings change.
  useEffect(() => {
    fileRef.current = null;
  }, [build, settings]);

  const getFile = async (): Promise<InvoiceFile | null> => {
    if (fileRef.current) return fileRef.current;
    try {
      fileRef.current = await makeInvoiceFile([buildRef.current()], settings, fileName);
      return fileRef.current;
    } catch (e) {
      showToast(e instanceof Error && e.message ? e.message : 'Could not make the invoice.', 'error');
      return null;
    }
  };

  const remember = async () => {
    const result = await recordInvoicePrints([orderId]);
    if (!result.ok && result.error) showToast(result.error, 'error');
    setPrintedAt(new Date().toISOString());
    onPrinted();
  };

  const run = async (kind: 'print' | 'download' | 'share') => {
    setBusy(kind);
    try {
      const wasReady = fileRef.current !== null;
      const file = await getFile();
      if (!file) return;
      if (kind === 'print') {
        await printInvoice(file);
      } else if (kind === 'share' && canShareInvoice(file)) {
        if (!(await shareInvoice(file))) {
          // A phone may refuse a share that starts after the PDF took time
          // to make; the PDF is ready now, so a second tap opens the sheet.
          if (!wasReady) showToast('The PDF is ready. Tap Share again.');
          return;
        }
      } else {
        downloadInvoice(file);
        if (kind === 'share') showToast('Sharing is not supported here, so the PDF was downloaded.');
      }
      await remember();
    } finally {
      setBusy(null);
    }
  };

  const button = (kind: 'print' | 'download' | 'share', label: string, icon: ReactNode, primary: boolean) => (
    <button
      type="button"
      className={`adm-btn adm-btn--sm${primary ? ' adm-btn--primary' : ''}`}
      onClick={() => void run(kind)}
      disabled={busy !== null}
      data-testid={`invoice-${kind}`}
    >
      {busy === kind ? <span className="spinner" aria-hidden="true" /> : icon}
      {label}
    </button>
  );

  return (
    <section className="adm-ocard adm-oinvoice" aria-label="Invoice" data-testid="invoice-card">
      <h2 className="adm-ocard__title">Invoice</h2>
      <p className="adm-ocard__muted" data-testid="invoice-printed">
        INV-{orderNumber} · A4 · {printedAt ? `last printed ${formatDhakaDateTime(printedAt)}` : 'Not printed yet'}
      </p>
      <div className="adm-oinvoice__buttons">
        {button(
          'print',
          'Print',
          <Svg>
            <path d="M6 9V3h12v6M6 18H4a1 1 0 01-1-1v-6a2 2 0 012-2h14a2 2 0 012 2v6a1 1 0 01-1 1h-2" />
            <path d="M6 14h12v7H6z" />
          </Svg>,
          printIsPrimary
        )}
        {button(
          'download',
          'Download',
          <Svg>
            <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
          </Svg>,
          false
        )}
        {button(
          'share',
          'Share',
          <Svg>
            <path d="M7 17L17 7M9 7h8v8" />
          </Svg>,
          false
        )}
      </div>
      <p className="adm-ocard__muted adm-oinvoice__hint">Share opens your phone&apos;s share sheet (WhatsApp, Messenger…)</p>
    </section>
  );
}

/* ------------------------------------------------------- Careful actions */

export interface CarefulAction {
  key: string;
  title: string;
  explain: string;
  button: string;
  /** Shown instead of an enabled button (e.g. the Safety Lock is closed). */
  disabled?: boolean;
  onOpen: () => void;
}

/** Fix (1.38.1): the actions that change the order, at the very bottom.
 *  Each only opens a confirmation — nothing happens on one tap. */
export function CarefulActionsCard({ actions }: { actions: CarefulAction[] }) {
  if (actions.length === 0) return null;
  return (
    <section className="adm-ocard adm-careful" aria-label="Careful actions" data-testid="careful-actions">
      <h2 className="adm-careful__title">Careful actions</h2>
      <p className="adm-ocard__muted">These change the order. You will be asked to confirm.</p>
      <ul className="adm-careful__list">
        {actions.map((a) => (
          <li key={a.key} className="adm-careful__row">
            <span className="adm-careful__text">
              <span className="adm-careful__name">{a.title}</span>
              <span className="adm-careful__explain">{a.explain}</span>
            </span>
            <button
              type="button"
              className={`adm-btn adm-btn--sm adm-careful__btn${a.key === 'deliver' || a.key === 'transit' ? '' : ' adm-careful__btn--red'}`}
              onClick={a.onOpen}
              disabled={a.disabled}
              data-testid={`careful-${a.key}`}
            >
              {a.button}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------- Confirmation sheet */

interface ConfirmSheetProps {
  isOpen: boolean;
  title: string;
  children?: ReactNode;
  /** Text shown in a yellow warning box (e.g. booked with Steadfast). */
  warning?: string | null;
  /** When set, the confirm button stays off until these digits are typed. */
  typeToConfirm?: string;
  keepLabel: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/** A bottom sheet that asks before a careful action runs. */
export function ConfirmSheet({
  isOpen,
  title,
  children,
  warning,
  typeToConfirm,
  keepLabel,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: ConfirmSheetProps) {
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (isOpen) setTyped('');
  }, [isOpen]);

  const ready = !typeToConfirm || typed.trim() === typeToConfirm;

  const confirm = async () => {
    if (!ready || working) return;
    setWorking(true);
    try {
      await onConfirm();
    } finally {
      setWorking(false);
    }
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={title} panelClassName="adm-csheet">
      <div className="adm-csheet__body" data-testid="confirm-sheet">
        {warning && (
          <p className="adm-csheet__warning" role="alert" data-testid="confirm-sheet-warning">
            <AdminIcon name="alert" className="adm-icon--sm" />
            <span>{warning}</span>
          </p>
        )}
        {children}
        {typeToConfirm && (
          <label className="adm-csheet__type">
            <span>
              Type <b>{typeToConfirm}</b> to confirm
            </span>
            <input
              className="form-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Type here…"
              data-testid="confirm-sheet-input"
            />
          </label>
        )}
        <div className="adm-csheet__actions">
          <button type="button" className="adm-btn" onClick={onClose}>
            {keepLabel}
          </button>
          <button
            type="button"
            className={`adm-btn ${danger ? 'adm-btn--danger' : 'adm-btn--primary'}`}
            onClick={() => void confirm()}
            disabled={!ready || working}
            data-testid="confirm-sheet-confirm"
          >
            {working ? <span className="spinner" aria-hidden="true" /> : confirmLabel}
          </button>
        </div>
        {typeToConfirm && <p className="adm-csheet__foot">The red button turns on only after typing the number.</p>}
      </div>
    </BottomSheet>
  );
}

/* ----------------------------------------------------------- Reopen card */

interface ReopenCardProps {
  cancelledAt: string | null;
  cancelledBy: string | null;
  canReopen: boolean;
  onReopen: () => void;
}

/** Fix (1.38.1): a cancelled order can be put back (e.g. cancelled by mistake). */
export function ReopenCard({ cancelledAt, cancelledBy, canReopen, onReopen }: ReopenCardProps) {
  return (
    <section className="adm-ocard adm-oreopen" aria-label="Cancelled" data-testid="reopen-card">
      <span className="track-pill track-pill--red">Cancelled</span>
      <p className="adm-ocard__muted">
        Cancelled{cancelledAt ? ` ${formatDhakaDateTime(cancelledAt)}` : ''}
        {cancelledBy ? ` by ${cancelledBy}` : ''}
      </p>
      {canReopen && (
        <>
          <button type="button" className="adm-btn adm-btn--primary adm-oreopen__btn" onClick={onReopen} data-testid="reopen-order">
            <Svg>
              <path d="M3 12a9 9 0 109-9 9.5 9.5 0 00-6.5 2.7L3 8" />
              <path d="M3 3v5h5" />
            </Svg>
            Reopen order
          </button>
          <p className="adm-ocard__muted">Puts it back to the status it had before and takes the stock again.</p>
        </>
      )}
    </section>
  );
}
