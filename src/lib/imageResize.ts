export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
/** Batch 40: the "large" photo — the product page and its zoom. 1400 px
 *  (was 1200) so it stays sharp on a 3× phone screen; a smaller original is
 *  never enlarged. */
export const MAX_IMAGE_WIDTH = 1400;
export const WEBP_QUALITY = 0.85;

/** Small "card" size — grid cards, bento tiles, search results, cart
 *  thumbnails. A card is at most ~180 px wide on a phone, 480 px covers a
 *  2.6× screen (Batch 40: was 400 px). */
export const CARD_IMAGE_WIDTH = 480;
export const CARD_WEBP_QUALITY = 0.82;

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Fix 68.1: the type a photo's name stands for, or null. Some phone
 *  pickers hand over a normal JPG with an empty file type. */
const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function imageTypeFromName(name: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? TYPE_BY_EXTENSION[match[1].toLowerCase()] ?? null : null;
}

/** A file with a type must be JPG, PNG or WebP; a file with an empty type
 *  (some phone pickers) is accepted when its name ends in one of those. */
export function isAcceptedImageType(file: File): boolean {
  if (file.type === '') return imageTypeFromName(file.name) !== null;
  return ACCEPTED_TYPES.includes(file.type);
}

/** The same file with the type its name stands for, when the picker gave
 *  it none, so the browser knows how to open it. */
export function withImageType(file: File): File {
  if (file.type !== '') return file;
  const type = imageTypeFromName(file.name);
  return type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file;
}

/** Shared resize core — draws `source` onto a canvas capped at `maxWidth`
 *  (aspect ratio preserved) and encodes it as WebP at `quality`. Accepts any
 *  Blob, not just a file picker's File, so the same code path resizes a
 *  freshly chosen photo AND an existing photo re-fetched over the network
 *  (see generateCardThumb, used by the one-time thumbnail backfill). */
function resizeToWidth(source: Blob, maxWidth: number, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(source);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const width = Math.round(img.naturalWidth * scale);
      const height = Math.round(img.naturalHeight * scale);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas is not supported in this browser.'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Could not convert image to WebP.'));
          }
        },
        'image/webp',
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read the selected image.'));
    };

    img.src = objectUrl;
  });
}

/**
 * Resize an image file client-side using an HTML Canvas:
 * max 1400px wide (aspect ratio preserved), WebP format, 0.85 quality.
 */
export function resizeImage(file: Blob): Promise<Blob> {
  return resizeToWidth(file, MAX_IMAGE_WIDTH, WEBP_QUALITY);
}

/** Small-card version of the same image — max 480px wide, WebP, 0.82 quality. */
export function resizeImageCard(file: Blob): Promise<Blob> {
  return resizeToWidth(file, CARD_IMAGE_WIDTH, CARD_WEBP_QUALITY);
}

/** Batch 31 Part 8: Browse circle version — max 160px wide, WebP, 0.8 quality. */
export const CIRCLE_IMAGE_WIDTH = 160;
export function resizeImageCircle(file: Blob): Promise<Blob> {
  return resizeToWidth(file, CIRCLE_IMAGE_WIDTH, CARD_WEBP_QUALITY);
}

/** Batch 45: a lot receipt photo — longest side 1600 px first (text stays
 *  readable), smaller until it is under RECEIPT_PHOTO_MAX_BYTES. A portrait
 *  photo is limited by its height, so its width is worked out from it. */
export const RECEIPT_PHOTO_MAX_BYTES = 300 * 1024;
export const RECEIPT_PHOTO_TRIES: readonly { longest: number; quality: number }[] = [
  { longest: 1600, quality: 0.72 },
  { longest: 1600, quality: 0.6 },
  { longest: 1300, quality: 0.6 },
  { longest: 1100, quality: 0.55 },
  { longest: 900, quality: 0.5 },
];

function imageSize(source: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read the selected image.'));
    };
    img.src = objectUrl;
  });
}

export async function resizeReceiptPhoto(file: Blob): Promise<Blob> {
  const { width, height } = await imageSize(file);
  let last: Blob | null = null;
  for (const t of RECEIPT_PHOTO_TRIES) {
    const maxWidth = height > width ? Math.round((t.longest * width) / height) : t.longest;
    last = await resizeToWidth(file, Math.max(1, maxWidth), t.quality);
    if (last.size <= RECEIPT_PHOTO_MAX_BYTES) return last;
  }
  if (last) return last;
  throw new Error('This photo could not be made small enough.');
}

/** Batch 41: a bill photo is kept under this size (WebP). */
export const BILL_PHOTO_MAX_BYTES = 150 * 1024;

/** The sizes tried for a bill photo, largest first: readable text first,
 *  smaller until it fits. */
export const BILL_PHOTO_TRIES: readonly { width: number; quality: number }[] = [
  { width: 1200, quality: 0.7 },
  { width: 1000, quality: 0.6 },
  { width: 800, quality: 0.55 },
  { width: 640, quality: 0.5 },
  { width: 480, quality: 0.45 },
];

/** Batch 41: a bill photo as WebP under BILL_PHOTO_MAX_BYTES (the first
 *  size of BILL_PHOTO_TRIES that fits). */
export async function resizeBillPhoto(file: Blob): Promise<Blob> {
  for (const t of BILL_PHOTO_TRIES) {
    const blob = await resizeToWidth(file, t.width, t.quality);
    if (blob.size <= BILL_PHOTO_MAX_BYTES) return blob;
  }
  throw new Error('This photo could not be made small enough. Try a photo of just the bill.');
}

/** Fix 68.1: which step of making a product photo failed. "decode": the
 *  photo could not be opened; "memory": a canvas or its file could not be
 *  made (what a phone does when it runs out of memory). */
export type PhotoStepKind = 'decode' | 'memory';

export class PhotoStepError extends Error {
  kind: PhotoStepKind;

  constructor(message: string, kind: PhotoStepKind) {
    super(message);
    this.name = 'PhotoStepError';
    this.kind = kind;
  }
}

/** Fix 68.1: a product photo's two files, large (1400 px) and card (480 px). */
export interface ProductPhotoPair {
  large: Blob;
  card: Blob;
}

interface DecodedPhoto {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/** Reads the photo's header (its size, already turned the right way up).
 *  The pixels are only decoded when the image is drawn. */
function loadImageElement(source: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new PhotoStepError('Reading the photo failed: the browser could not open it.', 'decode'));
    };
    img.src = objectUrl;
  });
}

/** The size of the large copy: MAX_IMAGE_WIDTH wide at most, never enlarged. */
function largeSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_IMAGE_WIDTH / width);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Decodes the photo once. A big photo is decoded straight at the large size
 * by createImageBitmap, so the phone never holds the full camera-size pixels.
 * Without createImageBitmap (or when it fails, or gives a different size
 * than asked) the <img> already loaded for the size is drawn instead.
 */
async function decodeProductPhoto(file: Blob): Promise<DecodedPhoto> {
  const img = await loadImageElement(file);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (width < 1 || height < 1) {
    throw new PhotoStepError('Reading the photo failed: it has no size.', 'decode');
  }
  const target = largeSize(width, height);
  if (typeof createImageBitmap === 'function') {
    try {
      const options: ImageBitmapOptions =
        target.width < width
          ? {
              imageOrientation: 'from-image',
              resizeWidth: target.width,
              resizeHeight: target.height,
              resizeQuality: 'high',
            }
          : { imageOrientation: 'from-image' };
      const bitmap = await createImageBitmap(file, options);
      // A browser that sized the photo before turning it upright would
      // squash it; its size then differs from the one asked for.
      if (Math.abs(bitmap.width - target.width) <= 1 && Math.abs(bitmap.height - target.height) <= 1) {
        return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
      }
      bitmap.close();
    } catch {
      // Falls back to drawing the <img> below.
    }
  }
  return {
    source: img,
    width,
    height,
    release: () => {
      img.src = '';
    },
  };
}

function freeCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function makeCanvas(
  width: number,
  height: number,
  step: string
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    freeCanvas(canvas);
    throw new PhotoStepError(`${step} failed: the browser could not make a ${width} x ${height} canvas.`, 'memory');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** WebP, or JPEG for a browser that cannot make WebP (it hands back a PNG
 *  instead). `type` makes the card the same format as the large file. */
async function encodePhoto(canvas: HTMLCanvasElement, quality: number, step: string, type = 'image/webp'): Promise<Blob> {
  let blob = await canvasToBlob(canvas, type, quality);
  if (blob && type === 'image/webp' && blob.type !== 'image/webp') {
    blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  }
  if (!blob) {
    throw new PhotoStepError(`${step} failed: the browser could not turn the picture into a file.`, 'memory');
  }
  return blob;
}

/**
 * Fix 68.1: the large (1400 px, WebP 0.85) and card (480 px, WebP 0.82)
 * files of a new product photo, made one step at a time so a phone holds as
 * little as possible: the photo is decoded once, the card is drawn from the
 * large canvas (not the original), the two files are made one after the
 * other, and each picture is freed as soon as it has been used.
 */
export async function resizeProductPhotoPair(file: Blob): Promise<ProductPhotoPair> {
  const decoded = await decodeProductPhoto(file);
  const size = largeSize(decoded.width, decoded.height);
  let largeCanvas: HTMLCanvasElement;
  try {
    const made = makeCanvas(size.width, size.height, 'Making the large photo');
    largeCanvas = made.canvas;
    made.ctx.drawImage(decoded.source, 0, 0, size.width, size.height);
  } finally {
    decoded.release();
  }

  let large: Blob;
  let cardCanvas: HTMLCanvasElement;
  try {
    large = await encodePhoto(largeCanvas, WEBP_QUALITY, 'Saving the large photo');
    const scale = Math.min(1, CARD_IMAGE_WIDTH / size.width);
    const cardWidth = Math.max(1, Math.round(size.width * scale));
    const cardHeight = Math.max(1, Math.round(size.height * scale));
    const made = makeCanvas(cardWidth, cardHeight, 'Making the card photo');
    cardCanvas = made.canvas;
    made.ctx.drawImage(largeCanvas, 0, 0, cardWidth, cardHeight);
  } finally {
    freeCanvas(largeCanvas);
  }

  try {
    const card = await encodePhoto(cardCanvas, CARD_WEBP_QUALITY, 'Saving the card photo', large.type);
    return { large, card };
  } finally {
    freeCanvas(cardCanvas);
  }
}
