/* Batch 41: runs in the test browser (served by the Vite dev server that
   e2e/batch-41.spec.ts starts). Calls the shop's own bill-photo code
   (src/lib) directly; the test answers Storage itself. */
import { resizeBillPhoto } from '../../src/lib/imageResize';
import { uploadBillPhoto } from '../../src/lib/money/bills';

/** A heavy phone photo of a bill: noise everywhere (hard to compress) and
 *  lines of text. */
async function billPhoto(width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const image = ctx.createImageData(width, height);
  let seed = 7;
  for (let i = 0; i < image.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const v = 200 + (seed % 55);
    image.data[i] = v;
    image.data[i + 1] = v - (seed % 20);
    image.data[i + 2] = v - (seed % 35);
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  ctx.fillStyle = '#222';
  ctx.font = `${Math.round(width / 28)}px sans-serif`;
  for (let line = 1; line < 20; line += 1) ctx.fillText(`Item ${line} ........ Tk ${line * 120}`, width * 0.08, (height / 21) * line);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.98 });
}

export async function billSize(): Promise<{ original: number; small: number; type: string; width: number }> {
  const photo = await billPhoto(4000, 3000);
  const small = await resizeBillPhoto(photo);
  const bitmap = await createImageBitmap(small);
  const width = bitmap.width;
  bitmap.close();
  return { original: photo.size, small: small.size, type: small.type, width };
}

export async function billUploadTwice(): Promise<(string | null)[]> {
  const photo = await billPhoto(2000, 1500);
  const a = await uploadBillPhoto(photo, '2026-10-11');
  const b = await uploadBillPhoto(photo, '2026-10-11');
  return [a.path, b.path];
}
