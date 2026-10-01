/* Brand logos auto-fit, whatever Naeem uploads (Batch 26 Part 2): empty
   borders trimmed, at most 800px wide, transparency kept, compressed. All
   in the browser, before upload. */

export const LOGO_MAX_WIDTH = 800;
export const LOGO_WEBP_QUALITY = 0.9;

/** Alpha below this counts as "see-through" (empty). */
const ALPHA_EMPTY = 16;
/** Each of R, G and B above this counts as "white" (empty) — only for a
 *  logo with no transparency at all, such as a JPG on a white background. */
const WHITE_EMPTY = 245;

export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The smallest box holding every non-empty pixel of an RGBA image. A logo
 * with any transparency is trimmed by transparency only (so a white logo
 * for dark mode keeps its white). A fully opaque logo is trimmed of its
 * white border instead. Null when the whole image is empty.
 */
export function findContentBox(data: Uint8ClampedArray, width: number, height: number): ContentBox | null {
  let hasTransparency = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      hasTransparency = true;
      break;
    }
  }

  const isEmpty = (offset: number): boolean => {
    if (data[offset + 3] < ALPHA_EMPTY) return true;
    if (hasTransparency) return false;
    return data[offset] > WHITE_EMPTY && data[offset + 1] > WHITE_EMPTY && data[offset + 2] > WHITE_EMPTY;
  };

  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    let rowHasContent = false;
    for (let x = 0; x < width; x += 1) {
      if (!isEmpty(row + x * 4)) {
        rowHasContent = true;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (rowHasContent) {
      if (top === -1) top = y;
      bottom = y;
    }
  }
  if (top === -1) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Scale a box down (never up) to fit `maxWidth`. */
export function fitWidth(width: number, height: number, maxWidth: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the selected image.'));
    };
    img.src = url;
  });
}

function toWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not convert the logo.'))),
      'image/webp',
      quality
    );
  });
}

/** Trim, resize to at most 800px wide, keep transparency, compress (WebP). */
export async function trimLogo(file: Blob): Promise<Blob> {
  const img = await loadImage(file);
  const source = document.createElement('canvas');
  source.width = img.naturalWidth;
  source.height = img.naturalHeight;
  const sctx = source.getContext('2d', { willReadFrequently: true });
  if (!sctx) throw new Error('Canvas is not supported in this browser.');
  sctx.drawImage(img, 0, 0);
  const pixels = sctx.getImageData(0, 0, source.width, source.height);
  const box = findContentBox(pixels.data, source.width, source.height) ?? {
    x: 0,
    y: 0,
    width: source.width,
    height: source.height,
  };

  const size = fitWidth(box.width, box.height, LOGO_MAX_WIDTH);
  const out = document.createElement('canvas');
  out.width = size.width;
  out.height = size.height;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('Canvas is not supported in this browser.');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, size.width, size.height);
  return toWebp(out, LOGO_WEBP_QUALITY);
}
