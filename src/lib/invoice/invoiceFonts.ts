// Batch 37: the invoice font files (in public/fonts/invoice) — kept apart
// from renderInvoice.ts so screens can name them without loading the PDF code.

export type InvoiceWeight = 'regular' | 'medium' | 'semibold' | 'bold' | 'extrabold';

/** Raw font files: Latin = Plus Jakarta Sans, Bengali = Noto Sans Bengali. */
export type InvoiceFontFiles = Record<'latin' | 'bengali', Record<InvoiceWeight, Uint8Array>>;

/** Where the files live in /public, by family and weight. */
export const INVOICE_FONT_FILES: Record<'latin' | 'bengali', Record<InvoiceWeight, string>> = {
  latin: {
    regular: 'PlusJakartaSans-Regular.ttf',
    medium: 'PlusJakartaSans-Medium.ttf',
    semibold: 'PlusJakartaSans-SemiBold.ttf',
    bold: 'PlusJakartaSans-Bold.ttf',
    extrabold: 'PlusJakartaSans-ExtraBold.ttf',
  },
  bengali: {
    regular: 'NotoSansBengali-Regular.ttf',
    medium: 'NotoSansBengali-Medium.ttf',
    semibold: 'NotoSansBengali-SemiBold.ttf',
    bold: 'NotoSansBengali-Bold.ttf',
    extrabold: 'NotoSansBengali-ExtraBold.ttf',
  },
};
