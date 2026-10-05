import { describe, expect, it } from 'vitest';
import { fitWidth } from './logoTrim';
import { detectBackground, opaqueBox, prepareLogoUpload, processLogoPixels } from './logoProcess';

/** w×h RGBA image filled with `bg`, with a `fg` rectangle. */
function image(w: number, h: number, bg: number[], fg: number[], box: { x: number; y: number; w: number; h: number }) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      data.set(inside ? fg : bg, (y * w + x) * 4);
    }
  }
  return data;
}

function alphaAt(data: Uint8ClampedArray, w: number, x: number, y: number): number {
  return data[(y * w + x) * 4 + 3];
}

describe('logo auto-trim (upload)', () => {
  it('trims a transparent border', () => {
    const data = image(20, 10, [0, 0, 0, 0], [200, 0, 0, 255], { x: 4, y: 2, w: 10, h: 5 });
    expect(prepareLogoUpload(data, 20, 10)).toEqual({ box: { x: 4, y: 2, width: 10, height: 5 }, cleared: false });
  });

  it('keeps a white logo on transparency (dark-mode logo)', () => {
    const data = image(20, 10, [0, 0, 0, 0], [255, 255, 255, 255], { x: 3, y: 3, w: 6, h: 4 });
    expect(prepareLogoUpload(data, 20, 10).box).toEqual({ x: 3, y: 3, width: 6, height: 4 });
  });

  it('removes a white backdrop on an opaque logo (JPG) and trims', () => {
    const data = image(20, 10, [255, 255, 255, 255], [10, 10, 10, 255], { x: 5, y: 1, w: 8, h: 8 });
    const result = prepareLogoUpload(data, 20, 10);
    expect(result).toEqual({ box: { x: 5, y: 1, width: 8, height: 8 }, cleared: true });
    expect(alphaAt(data, 20, 0, 0)).toBe(0);
    expect(alphaAt(data, 20, 6, 3)).toBe(255);
  });

  it('removes a black backdrop behind a white logo, same box as its white-backdrop twin', () => {
    const onBlack = image(30, 12, [0, 0, 0, 255], [255, 255, 255, 255], { x: 6, y: 2, w: 14, h: 7 });
    const onWhite = image(30, 12, [255, 255, 255, 255], [20, 20, 20, 255], { x: 6, y: 2, w: 14, h: 7 });
    expect(prepareLogoUpload(onBlack, 30, 12).box).toEqual(prepareLogoUpload(onWhite, 30, 12).box);
    expect(alphaAt(onBlack, 30, 0, 0)).toBe(0);
  });

  it('keeps a brand-colour backdrop, trimming only the extra margin', () => {
    const data = image(40, 20, [120, 190, 230, 255], [255, 255, 255, 255], { x: 10, y: 6, w: 20, h: 8 });
    const result = prepareLogoUpload(data, 40, 20);
    expect(result.cleared).toBe(false);
    expect(alphaAt(data, 40, 0, 0)).toBe(255);
    // Content plus an 8% frame of its own colour.
    expect(result.box).toEqual({ x: 8, y: 4, width: 24, height: 12 });
  });

  it('an empty picture keeps its full size', () => {
    expect(prepareLogoUpload(new Uint8ClampedArray(4 * 4 * 4), 4, 4).box).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(opaqueBox(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBeNull();
  });

  it('resizes to at most 800px wide, never up', () => {
    expect(fitWidth(1600, 400, 800)).toEqual({ width: 800, height: 200 });
    expect(fitWidth(300, 100, 800)).toEqual({ width: 300, height: 100 });
  });
});

describe('logo backdrop detection and display clean-up', () => {
  it('reads the backdrop from the whole edge, not one corner', () => {
    const data = image(20, 10, [255, 255, 255, 255], [10, 120, 200, 255], { x: 4, y: 2, w: 10, h: 5 });
    // A soft blue letter edge touching the top-left corner pixel.
    data.set([180, 255, 255, 255], 0);
    expect(detectBackground(data, 20, 10)).toEqual({ kind: 'white', color: [255, 255, 255] });
  });

  it('classifies transparent, black, colour and plain', () => {
    expect(detectBackground(image(8, 8, [0, 0, 0, 0], [9, 9, 9, 255], { x: 2, y: 2, w: 3, h: 3 }), 8, 8).kind).toBe(
      'transparent'
    );
    expect(detectBackground(image(8, 8, [3, 3, 3, 255], [250, 250, 250, 255], { x: 2, y: 2, w: 3, h: 3 }), 8, 8).kind).toBe(
      'black'
    );
    expect(detectBackground(image(8, 8, [255, 186, 38, 255], [255, 255, 255, 255], { x: 2, y: 2, w: 3, h: 3 }), 8, 8)).toEqual({
      kind: 'colour',
      color: [255, 186, 38],
    });
    // Every edge pixel a different colour (like a photo).
    const photo = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < 64; i += 1) photo.set([(i * 37) % 256, (i * 91) % 256, (i * 53) % 256, 255], i * 4);
    expect(detectBackground(photo, 8, 8).kind).toBe('plain');
  });

  it('never clears the inside of a letter (the hole in an "O")', () => {
    // A dark ring with a white hole, on white.
    const data = image(12, 12, [255, 255, 255, 255], [0, 0, 0, 255], { x: 2, y: 2, w: 8, h: 8 });
    data.set([255, 255, 255, 255], (6 * 12 + 6) * 4);
    const result = processLogoPixels(data, 12, 12);
    expect(result.kind).toBe('cleared');
    expect(alphaAt(data, 12, 0, 0)).toBe(0);
    expect(alphaAt(data, 12, 6, 6)).toBe(255);
    expect(result.box).toEqual({ x: 2, y: 2, width: 8, height: 8 });
  });

  it('fades the soft edge instead of cutting it, with no halo', () => {
    // Background white; a mid-grey (50% black over white) pixel at the edge of a black block.
    const data = image(10, 10, [255, 255, 255, 255], [0, 0, 0, 255], { x: 4, y: 4, w: 2, h: 2 });
    data.set([128, 128, 128, 255], (4 * 10 + 3) * 4);
    processLogoPixels(data, 10, 10);
    const o = (4 * 10 + 3) * 4;
    expect(data[o + 3]).toBeGreaterThan(100);
    expect(data[o + 3]).toBeLessThan(155);
    // The kept colour is the logo's own (black), not grey mixed with white.
    expect(data[o]).toBeLessThan(10);
  });

  it('a colour backdrop reports its colour for the card', () => {
    const data = image(20, 10, [120, 190, 230, 255], [255, 255, 255, 255], { x: 5, y: 3, w: 10, h: 4 });
    const result = processLogoPixels(data, 20, 10);
    expect(result).toEqual({ kind: 'colour', background: 'rgb(120, 190, 230)', box: { x: 5, y: 3, width: 10, height: 4 } });
  });

  it('an already-trimmed transparent logo needs no new file', () => {
    const data = image(6, 6, [0, 0, 0, 0], [10, 10, 10, 255], { x: 0, y: 0, w: 6, h: 6 });
    data.set([0, 0, 0, 0], 0);
    expect(processLogoPixels(data, 6, 6)).toEqual({ kind: 'transparent', background: null, box: null });
  });
});
