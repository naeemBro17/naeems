// Batch 37: making the invoice PDF in the browser and handing it over —
// print (PC), share sheet (phone: Android's sheet has Print), download.
// The PDF code and the fonts (~1.6 MB, cached by the browser after the
// first time) load only when someone actually makes an invoice.
import type { AppSettings } from '../../types';
import type { InvoiceData } from './invoiceData';
import { invoiceShop } from './invoiceShop';
import { INVOICE_FONT_FILES, type InvoiceFontFiles, type InvoiceWeight } from './invoiceFonts';

const FONT_BASE = '/fonts/invoice/';

let fontsPromise: Promise<InvoiceFontFiles> | null = null;

function loadInvoiceFonts(): Promise<InvoiceFontFiles> {
  if (!fontsPromise) {
    const bytesByFile = new Map<string, Promise<Uint8Array>>();
    const read = (file: string) => {
      let found = bytesByFile.get(file);
      if (!found) {
        found = fetch(`${FONT_BASE}${file}`).then(async (res) => {
          if (!res.ok) throw new Error(`Font ${file} could not be loaded.`);
          return new Uint8Array(await res.arrayBuffer());
        });
        bytesByFile.set(file, found);
      }
      return found;
    };
    const family = async (names: Record<InvoiceWeight, string>) => {
      const entries = await Promise.all(Object.entries(names).map(async ([w, f]) => [w, await read(f)] as const));
      return Object.fromEntries(entries) as Record<InvoiceWeight, Uint8Array>;
    };
    fontsPromise = Promise.all([family(INVOICE_FONT_FILES.latin), family(INVOICE_FONT_FILES.bengali)]).then(
      ([latin, bengali]) => ({ latin, bengali })
    );
    // A failed load (offline) may be tried again on the next tap.
    fontsPromise.catch(() => {
      fontsPromise = null;
    });
  }
  return fontsPromise;
}

export interface InvoiceFile {
  blob: Blob;
  file: File;
  fileName: string;
  pageCount: number;
}

export async function makeInvoiceFile(invoices: InvoiceData[], settings: Partial<AppSettings>, fileName: string): Promise<InvoiceFile> {
  const [{ buildInvoicePdf }, fonts] = await Promise.all([import('./renderInvoice'), loadInvoiceFonts()]);
  const pdf = await buildInvoicePdf(invoices, invoiceShop(settings), fonts);
  const blob = new Blob([pdf.bytes as BlobPart], { type: 'application/pdf' });
  return { blob, file: new File([blob], fileName, { type: 'application/pdf' }), fileName, pageCount: pdf.pageCount };
}

export function downloadInvoice(file: InvoiceFile): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A phone (touch first) that can hand a PDF to the share sheet. */
export function canShareInvoice(file: InvoiceFile): boolean {
  if (typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [file.file] });
  } catch {
    return false;
  }
}

export async function shareInvoice(file: InvoiceFile): Promise<boolean> {
  try {
    await navigator.share({ files: [file.file], title: file.fileName });
    return true;
  } catch {
    return false;
  }
}

function isPhone(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Print. On a PC the PDF opens in Chrome's print window (choose "Actual
 * size"; the PDF also asks for no scaling). A phone cannot print a PDF
 * from a page, so it gets the share sheet (Android: Print), or the PDF
 * opens in a new tab.
 */
export async function printInvoice(file: InvoiceFile): Promise<void> {
  if (isPhone()) {
    if (canShareInvoice(file) && (await shareInvoice(file))) return;
    window.open(URL.createObjectURL(file.blob), '_blank', 'noopener');
    return;
  }
  const url = URL.createObjectURL(file.blob);
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.testid = 'invoice-print-frame';
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  };
  document.body.appendChild(frame);
  // The print window holds its own copy; tidy up a while later.
  window.setTimeout(() => {
    frame.remove();
    URL.revokeObjectURL(url);
  }, 10 * 60_000);
}
