/**
 * Batch 52 Part 1.3 — the combo's link-preview picture (1200 × 630): its
 * product photos (the first 4), each shown WHOLE inside a white tile on a
 * soft light background, and a small dark glass "PICKED FOR YOU" badge.
 *
 * Drawn once in the admin's browser when the combo is made and saved as
 * one JPG, so a preview request never downloads product photos.
 */

export const COLLAGE_WIDTH = 1200;
export const COLLAGE_HEIGHT = 630;
const PAD = 28;
const GAP = 16;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where each photo tile goes for 1–4 photos. */
export function collageTiles(count: number, width = COLLAGE_WIDTH, height = COLLAGE_HEIGHT): Rect[] {
  const n = Math.max(0, Math.min(4, Math.floor(count)));
  const innerW = width - PAD * 2;
  const innerH = height - PAD * 2;
  if (n === 0) return [];
  if (n === 1) {
    const side = innerH;
    return [{ x: (width - side) / 2, y: PAD, w: side, h: side }];
  }
  if (n === 2) {
    const w = (innerW - GAP) / 2;
    return [
      { x: PAD, y: PAD, w, h: innerH },
      { x: PAD + w + GAP, y: PAD, w, h: innerH },
    ];
  }
  if (n === 3) {
    const bigW = (innerW - GAP) * 0.55;
    const smallW = innerW - GAP - bigW;
    const smallH = (innerH - GAP) / 2;
    return [
      { x: PAD, y: PAD, w: bigW, h: innerH },
      { x: PAD + bigW + GAP, y: PAD, w: smallW, h: smallH },
      { x: PAD + bigW + GAP, y: PAD + smallH + GAP, w: smallW, h: smallH },
    ];
  }
  const w = (innerW - GAP) / 2;
  const h = (innerH - GAP) / 2;
  return [
    { x: PAD, y: PAD, w, h },
    { x: PAD + w + GAP, y: PAD, w, h },
    { x: PAD, y: PAD + h + GAP, w, h },
    { x: PAD + w + GAP, y: PAD + h + GAP, w, h },
  ];
}

/** A photo fitted whole inside a box (never cropped), centred. */
export function fitInside(photoW: number, photoH: number, box: Rect, inset = 0): Rect {
  const bw = Math.max(0, box.w - inset * 2);
  const bh = Math.max(0, box.h - inset * 2);
  if (photoW <= 0 || photoH <= 0) return { x: box.x + inset, y: box.y + inset, w: 0, h: 0 };
  const scale = Math.min(bw / photoW, bh / photoH);
  const w = photoW * scale;
  const h = photoH * scale;
  return { x: box.x + inset + (bw - w) / 2, y: box.y + inset + (bh - h) / 2, w, h };
}

function loadPhoto(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // Needed to save the drawing afterwards (the shop's photos allow it).
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
}

/** Draws the collage; null when it can't be drawn (no photo loaded). */
export async function drawComboCollage(photoUrls: readonly string[]): Promise<Blob | null> {
  const urls = photoUrls.filter((u) => u !== '').slice(0, 4);
  if (urls.length === 0) return null;
  const photos = (await Promise.all(urls.map(loadPhoto))).filter((p): p is HTMLImageElement => p !== null);
  if (photos.length === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = COLLAGE_WIDTH;
  canvas.height = COLLAGE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Soft light background with a faint warm wash.
  ctx.fillStyle = '#F3F1EE';
  ctx.fillRect(0, 0, COLLAGE_WIDTH, COLLAGE_HEIGHT);
  const wash = ctx.createRadialGradient(COLLAGE_WIDTH * 0.85, 0, 0, COLLAGE_WIDTH * 0.85, 0, 700);
  wash.addColorStop(0, 'rgba(255, 122, 69, 0.10)');
  wash.addColorStop(1, 'rgba(255, 122, 69, 0)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, COLLAGE_WIDTH, COLLAGE_HEIGHT);

  collageTiles(photos.length).forEach((tile, i) => {
    const photo = photos[i];
    ctx.save();
    ctx.shadowColor = 'rgba(17, 17, 17, 0.08)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#FFFFFF';
    roundRect(ctx, tile, 22);
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, tile, 22);
    ctx.clip();
    const fit = fitInside(photo.naturalWidth, photo.naturalHeight, tile, 10);
    ctx.drawImage(photo, fit.x, fit.y, fit.w, fit.h);
    ctx.restore();
  });

  // "PICKED FOR YOU" — small dark glass badge, bottom left.
  if (document.fonts) await document.fonts.ready;
  ctx.font = '700 22px "Plus Jakarta Sans", system-ui, sans-serif';
  const label = 'PICKED FOR YOU';
  const spacing = 2.5;
  const textW = [...label].reduce((sum, ch) => sum + ctx.measureText(ch).width + spacing, -spacing);
  const badge: Rect = { x: PAD + 18, y: COLLAGE_HEIGHT - PAD - 18 - 52, w: textW + 44, h: 52 };
  ctx.fillStyle = 'rgba(17, 17, 17, 0.78)';
  roundRect(ctx, badge, 26);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#FFFFFF';
  ctx.textBaseline = 'middle';
  let x = badge.x + 22;
  for (const ch of label) {
    ctx.fillText(ch, x, badge.y + badge.h / 2 + 1);
    x += ctx.measureText(ch).width + spacing;
  }

  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.86);
    } catch {
      // A photo without permission to be re-saved "taints" the drawing.
      resolve(null);
    }
  });
}
