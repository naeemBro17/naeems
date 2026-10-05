import { prepareLogoUpload } from './logoProcess';

/* Brand logos auto-fit, whatever Naeem uploads (Batch 26 Part 2): empty
   borders trimmed, at most 800px wide, transparency kept, compressed. All
   in the browser, before upload. Batch 29: a solid white or black backdrop
   is made see-through first; a brand-colour backdrop is kept (the shop
   fills the card with it) — see lib/logoProcess.ts. */

export const LOGO_MAX_WIDTH = 800;
export const LOGO_WEBP_QUALITY = 0.9;

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
  const { box, cleared } = prepareLogoUpload(pixels.data, source.width, source.height);
  if (cleared) sctx.putImageData(pixels, 0, 0);

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
