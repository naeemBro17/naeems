/* Brand logo clean-up shared by the admin upload and the shop's display
   (Batch 29 Part 5). Pure pixel functions — no DOM — so the same code runs
   on the main thread, inside a Web Worker and in unit tests.

   A logo is one of:
   - transparent: already see-through around it → only the empty edges
     are trimmed.
   - white / black background: a solid near-white or near-black backdrop
     (common for JPGs and "white version for dark mode" exports) → that
     backdrop is turned see-through from the edges inwards (never inside
     letters), with soft anti-aliased edges, then trimmed. This is what
     makes a black-background white logo the same size as its normal twin.
   - colour background: a solid brand colour behind the logo (e.g. a yellow
     or light-blue box) → the colour is KEPT: the card itself takes that
     colour, so there is no inner box, in light and dark mode alike.
   - plain: anything else (e.g. a photo) → shown as it is. */

export type Rgb = [number, number, number];

export type LogoBackground =
  | { kind: 'transparent' }
  | { kind: 'white'; color: Rgb }
  | { kind: 'black'; color: Rgb }
  | { kind: 'colour'; color: Rgb }
  | { kind: 'plain' };

/** Edge pixels below this alpha count as see-through. */
const OPAQUE_ALPHA = 250;
/** Share of edge pixels that may be see-through and still call it opaque. */
const MAX_SEE_THROUGH_EDGE = 0.02;
/** Two colours this close (largest channel difference) count as the same. */
export const SAME_COLOUR = 28;
/** Share of the edge that must be one colour to call it a solid background. */
const SOLID_EDGE_SHARE = 0.6;
/** Every channel at least this → near-white; at most NEAR_BLACK → near-black. */
const NEAR_WHITE = 225;
const NEAR_BLACK = 35;
/** A pixel needing at most this much opacity over the backdrop colour is
 *  "backdrop" for the flood fill (the soft edge beyond it is kept, faded). */
const FLOOD_ALPHA = 0.4;
/** Alpha below this counts as empty when trimming. */
const TRIM_ALPHA = 16;

function maxDiff(data: Uint8ClampedArray, offset: number, color: Rgb): number {
  return Math.max(
    Math.abs(data[offset] - color[0]),
    Math.abs(data[offset + 1] - color[1]),
    Math.abs(data[offset + 2] - color[2])
  );
}

/** Byte offsets of every pixel on the image's outer edge (each once). */
function edgeOffsets(width: number, height: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < width; x += 1) {
    out.push(x * 4);
    if (height > 1) out.push(((height - 1) * width + x) * 4);
  }
  for (let y = 1; y < height - 1; y += 1) {
    out.push(y * width * 4);
    if (width > 1) out.push((y * width + width - 1) * 4);
  }
  return out;
}

/**
 * What is behind the logo, read from the image's outer edge. Uses the whole
 * edge rather than only the four corner pixels, so a letter's soft edge that
 * happens to touch one corner doesn't hide an otherwise solid backdrop.
 */
export function detectBackground(data: Uint8ClampedArray, width: number, height: number): LogoBackground {
  const edge = edgeOffsets(width, height);
  if (edge.length === 0) return { kind: 'plain' };

  let seeThrough = 0;
  for (const o of edge) if (data[o + 3] < OPAQUE_ALPHA) seeThrough += 1;
  if (seeThrough / edge.length > MAX_SEE_THROUGH_EDGE) return { kind: 'transparent' };

  // The most common (coarsely bucketed) edge colour, averaged.
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const o of edge) {
    const key = ((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1;
    bucket.r += data[o];
    bucket.g += data[o + 1];
    bucket.b += data[o + 2];
    buckets.set(key, bucket);
  }
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const bucket of buckets.values()) if (bucket.n > best.n) best = bucket;
  const color: Rgb = [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];

  let same = 0;
  for (const o of edge) if (maxDiff(data, o, color) <= SAME_COLOUR) same += 1;
  if (same / edge.length < SOLID_EDGE_SHARE) return { kind: 'plain' };

  if (Math.min(...color) >= NEAR_WHITE) return { kind: 'white', color };
  if (Math.max(...color) <= NEAR_BLACK) return { kind: 'black', color };
  return { kind: 'colour', color };
}

/** How opaque a pixel must be over `bg` to show its colour (0–1), per the
 *  usual "colour to alpha" rule: the largest per-channel share. */
function alphaOver(data: Uint8ClampedArray, offset: number, bg: Rgb): number {
  let alpha = 0;
  for (let c = 0; c < 3; c += 1) {
    const v = data[offset + c];
    const b = bg[c];
    let a = 0;
    if (v > b) a = (v - b) / (255 - b);
    else if (v < b) a = (b - v) / b;
    if (a > alpha) alpha = a;
  }
  return alpha;
}

/** Removes `bg` from one pixel: the backdrop becomes see-through and the
 *  pixel keeps only its own colour (so soft edges never get a halo). */
function unblend(data: Uint8ClampedArray, offset: number, bg: Rgb): void {
  const alpha = alphaOver(data, offset, bg);
  if (alpha <= 0) {
    data[offset + 3] = 0;
    return;
  }
  for (let c = 0; c < 3; c += 1) {
    const b = bg[c];
    data[offset + c] = Math.max(0, Math.min(255, Math.round(b + (data[offset + c] - b) / alpha)));
  }
  data[offset + 3] = Math.round(data[offset + 3] * alpha);
}

/**
 * Makes a solid backdrop see-through, in place. Starts from the edge and
 * only spreads through backdrop-coloured pixels, so the inside of a letter
 * (the hole in an "O") is never touched. The ring of soft pixels where the
 * backdrop meets the logo is faded, not cut, so edges stay smooth.
 */
export function clearBackground(data: Uint8ClampedArray, width: number, height: number, bg: Rgb): void {
  const total = width * height;
  // 0 = untouched, 1 = backdrop (flooded), 2 = soft edge next to it.
  const mark = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const isBackdrop = (p: number): boolean => alphaOver(data, p * 4, bg) <= FLOOD_ALPHA;

  for (const o of edgeOffsets(width, height)) {
    const p = o / 4;
    if (mark[p] === 0 && isBackdrop(p)) {
      mark[p] = 1;
      queue[tail] = p;
      tail += 1;
    }
  }

  while (head < tail) {
    const p = queue[head];
    head += 1;
    const x = p % width;
    const neighbours = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width];
    for (const n of neighbours) {
      if (n < 0 || n >= total || mark[n] !== 0) continue;
      if (isBackdrop(n)) {
        mark[n] = 1;
        queue[tail] = n;
        tail += 1;
      } else {
        mark[n] = 2;
      }
    }
  }

  for (let p = 0; p < total; p += 1) if (mark[p] !== 0) unblend(data, p * 4, bg);
}

export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The smallest box holding every non-empty pixel. `isEmpty` decides what
 *  "empty" means (see-through, or the backdrop colour). Null = all empty. */
export function contentBox(
  width: number,
  height: number,
  isEmpty: (offset: number) => boolean
): ContentBox | null {
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

/** The box around everything that isn't see-through. */
export function opaqueBox(data: Uint8ClampedArray, width: number, height: number): ContentBox | null {
  return contentBox(width, height, (o) => data[o + 3] < TRIM_ALPHA);
}

/** Grows a box by `share` of its larger side on every side, kept inside the
 *  image — a coloured-background logo keeps a frame of its own colour, so
 *  it is still recognised as one when the shop reads it again. */
export function padBox(box: ContentBox, share: number, width: number, height: number): ContentBox {
  const pad = Math.round(Math.max(box.width, box.height) * share);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return {
    x,
    y,
    width: Math.min(width, box.x + box.width + pad) - x,
    height: Math.min(height, box.y + box.height + pad) - y,
  };
}

export type LogoKind = 'transparent' | 'cleared' | 'colour' | 'plain';

export interface ProcessedLogo {
  kind: LogoKind;
  /** The card colour for a colour-background logo (CSS rgb()), else null. */
  background: string | null;
  /** The part of the (now cleaned) pixels to show; null = show the original
   *  file unchanged (nothing to clean or trim). */
  box: ContentBox | null;
}

export function rgbCss(color: Rgb): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/**
 * The shop's display-time clean-up, in place on `data`: works out the kind,
 * clears a solid backdrop (white, black or a brand colour — the colour is
 * reported so the card can take it) and returns the box to keep.
 */
export function processLogoPixels(data: Uint8ClampedArray, width: number, height: number): ProcessedLogo {
  const bg = detectBackground(data, width, height);
  if (bg.kind === 'plain') return { kind: 'plain', background: null, box: null };
  if (bg.kind === 'transparent') {
    const box = opaqueBox(data, width, height);
    const untouched = !box || (box.x === 0 && box.y === 0 && box.width === width && box.height === height);
    return { kind: 'transparent', background: null, box: untouched ? null : box };
  }
  clearBackground(data, width, height, bg.color);
  const box = opaqueBox(data, width, height) ?? { x: 0, y: 0, width, height };
  if (bg.kind === 'colour') return { kind: 'colour', background: rgbCss(bg.color), box };
  return { kind: 'cleared', background: null, box };
}

/**
 * The admin upload's clean-up (no DOM): returns the box to save and whether
 * the pixels were cleared in place. A white or black backdrop is removed for
 * good. A brand-colour backdrop is NOT removed — the file keeps it (with a
 * thin frame of that colour) so the shop can still read the colour and fill
 * the card with it; only the extra margin is trimmed.
 */
export function prepareLogoUpload(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { box: ContentBox; cleared: boolean } {
  const full = { x: 0, y: 0, width, height };
  const bg = detectBackground(data, width, height);
  if (bg.kind === 'white' || bg.kind === 'black') {
    clearBackground(data, width, height, bg.color);
    return { box: opaqueBox(data, width, height) ?? full, cleared: true };
  }
  if (bg.kind === 'colour') {
    const color = bg.color;
    const box = contentBox(width, height, (o) => maxDiff(data, o, color) <= SAME_COLOUR);
    return { box: box ? padBox(box, 0.08, width, height) : full, cleared: false };
  }
  if (bg.kind === 'transparent') return { box: opaqueBox(data, width, height) ?? full, cleared: false };
  return { box: full, cleared: false };
}
