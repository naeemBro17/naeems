import { processLogoPixels, type LogoKind } from './logoProcess';

/* Decode → clean → encode one logo file, for the shop's display-time
   clean-up of logos uploaded before Batch 29 (see lib/brandLogoCache.ts).
   Runs inside the logo Web Worker, or on the main thread when a phone has
   no worker canvas. */

export interface CleanedLogo {
  kind: LogoKind;
  /** Card colour (CSS) for a colour-background logo, else null. */
  background: string | null;
  /** The cleaned picture; null = the original file is fine as it is. */
  blob: Blob | null;
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

interface AnyCanvas {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: Canvas2D;
}

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not supported.');
  return { canvas, ctx };
}

function encode(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  // Checked this way round: there is no HTMLCanvasElement inside a worker.
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
  }
  const element = canvas as HTMLCanvasElement;
  return new Promise((resolve, reject) => {
    element.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode.'))), 'image/webp', 0.92);
  });
}

export async function cleanLogoBlob(file: Blob): Promise<CleanedLogo> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const source = makeCanvas(width, height);
  source.ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = source.ctx.getImageData(0, 0, width, height);
  const result = processLogoPixels(pixels.data, width, height);
  if (!result.box) return { kind: result.kind, background: result.background, blob: null };

  source.ctx.putImageData(pixels, 0, 0);
  const { x, y, width: w, height: h } = result.box;
  const out = makeCanvas(w, h);
  out.ctx.drawImage(source.canvas, x, y, w, h, 0, 0, w, h);
  return { kind: result.kind, background: result.background, blob: await encode(out.canvas) };
}
