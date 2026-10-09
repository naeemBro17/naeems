import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import { INVOICE_FONT_FILES, type InvoiceFontFiles, type InvoiceWeight } from '../../src/lib/invoice/invoiceFonts';

// Batch 37: reads the invoice fonts from public/, turns a PDF page into an
// image (pdf.js + @napi-rs/canvas) and reads barcodes / QR codes from it
// (ZXing) — the same way a rider's scanner would see the printed page.

const FONT_DIR = join(process.cwd(), 'public', 'fonts', 'invoice');

export function fontFilesFromDisk(): InvoiceFontFiles {
  const cache = new Map<string, Uint8Array>();
  const read = (file: string) => {
    let bytes = cache.get(file);
    if (!bytes) {
      bytes = new Uint8Array(readFileSync(join(FONT_DIR, file)));
      cache.set(file, bytes);
    }
    return bytes;
  };
  const family = (names: Record<InvoiceWeight, string>) =>
    Object.fromEntries(Object.entries(names).map(([w, f]) => [w, read(f)])) as Record<InvoiceWeight, Uint8Array>;
  return { latin: family(INVOICE_FONT_FILES.latin), bengali: family(INVOICE_FONT_FILES.bengali) };
}

export interface PageImage {
  png: Buffer;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Pixels per PDF point. */
  scale: number;
}

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const count = pdf.numPages;
  await pdf.cleanup();
  return count;
}

/** Every text piece on a page, in drawing order. */
export async function pdfPageText(bytes: Uint8Array, pageNo = 1): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await pdf.getPage(pageNo);
  const content = await page.getTextContent();
  const items = content.items.map((i) => ('str' in i ? i.str : '')).filter((s) => s !== '');
  await pdf.cleanup();
  return items;
}

export async function renderPdfPage(bytes: Uint8Array, pageNo = 1, scale = 3): Promise<PageImage> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await pdf.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const image: PageImage = {
    png: canvas.toBuffer('image/png'),
    width: canvas.width,
    height: canvas.height,
    rgba: new Uint8ClampedArray(data),
    scale,
  };
  await pdf.cleanup();
  return image;
}

/** Reads one code inside a rectangle given in PDF points from the top-left. */
export function decodeRegion(
  image: PageImage,
  region: { x: number; top: number; width: number; height: number },
  format: 'code128' | 'qr'
): string | null {
  const x0 = Math.max(0, Math.floor(region.x * image.scale));
  const y0 = Math.max(0, Math.floor(region.top * image.scale));
  const w = Math.min(image.width - x0, Math.ceil(region.width * image.scale));
  const h = Math.min(image.height - y0, Math.ceil(region.height * image.scale));
  const lum = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = ((y0 + y) * image.width + (x0 + x)) * 4;
      lum[y * w + x] = Math.round(0.299 * image.rgba[i] + 0.587 * image.rgba[i + 1] + 0.114 * image.rgba[i + 2]);
    }
  }
  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [format === 'qr' ? BarcodeFormat.QR_CODE : BarcodeFormat.CODE_128]],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  reader.setHints(hints);
  try {
    return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, w, h)))).getText();
  } catch {
    return null;
  }
}

/** Where the label's barcode and the community QR are drawn (points). */
export const BARCODE_REGION = { x: 20, top: 140, width: 270, height: 56 };
export const QR_REGION = { x: 400, top: 630, width: 175, height: 128 };
