// Batch 43 Part 4: makes the investor report PDF in the browser (the PDF
// code and fonts load only when asked for) and hands it over: Download, or
// the phone's Share sheet.
import { loadInvoiceFonts } from '../invoice/invoiceOutput';
import type { InvestorReportModel } from './investorReport';

export interface InvestorFile {
  blob: Blob;
  file: File;
  fileName: string;
  pageCount: number;
}

export async function makeInvestorFile(model: InvestorReportModel, fileName: string): Promise<InvestorFile> {
  const [{ buildInvestorPdf }, fonts] = await Promise.all([import('./investorPdf'), loadInvoiceFonts()]);
  const pdf = await buildInvestorPdf(model, fonts);
  const blob = new Blob([pdf.bytes as BlobPart], { type: 'application/pdf' });
  return { blob, file: new File([blob], fileName, { type: 'application/pdf' }), fileName, pageCount: pdf.pageCount };
}

export function canShareFile(file: File): boolean {
  if (typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** True when the share sheet took it (false: cancelled or not possible). */
export async function shareFile(file: File, title: string): Promise<boolean> {
  try {
    await navigator.share({ files: [file], title });
    return true;
  } catch {
    return false;
  }
}
