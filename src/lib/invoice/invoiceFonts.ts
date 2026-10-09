// Batch 37: the invoice font files (in public/fonts/invoice) — kept apart
// from renderInvoice.ts so screens can name them without loading the PDF code.

export type InvoiceWeight = 'regular' | 'medium' | 'semibold' | 'bold' | 'extrabold';

/** Raw font files: Latin = Plus Jakarta Sans, Bengali = Hind Siliguri. */
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
    regular: 'HindSiliguri-Regular.ttf',
    medium: 'HindSiliguri-Medium.ttf',
    semibold: 'HindSiliguri-SemiBold.ttf',
    bold: 'HindSiliguri-Bold.ttf',
    // Hind Siliguri stops at Bold.
    extrabold: 'HindSiliguri-Bold.ttf',
  },
};
