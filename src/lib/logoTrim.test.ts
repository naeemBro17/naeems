import { describe, expect, it } from 'vitest';
import { findContentBox, fitWidth } from './logoTrim';

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

describe('logo auto-trim', () => {
  it('trims a transparent border', () => {
    const data = image(20, 10, [0, 0, 0, 0], [200, 0, 0, 255], { x: 4, y: 2, w: 10, h: 5 });
    expect(findContentBox(data, 20, 10)).toEqual({ x: 4, y: 2, width: 10, height: 5 });
  });

  it('keeps a white logo on transparency (dark-mode logo)', () => {
    const data = image(20, 10, [0, 0, 0, 0], [255, 255, 255, 255], { x: 3, y: 3, w: 6, h: 4 });
    expect(findContentBox(data, 20, 10)).toEqual({ x: 3, y: 3, width: 6, height: 4 });
  });

  it('trims a white border on an opaque logo (JPG)', () => {
    const data = image(20, 10, [255, 255, 255, 255], [10, 10, 10, 255], { x: 5, y: 1, w: 8, h: 8 });
    expect(findContentBox(data, 20, 10)).toEqual({ x: 5, y: 1, width: 8, height: 8 });
  });

  it('an empty picture has no content', () => {
    expect(findContentBox(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBeNull();
  });

  it('resizes to at most 800px wide, never up', () => {
    expect(fitWidth(1600, 400, 800)).toEqual({ width: 800, height: 200 });
    expect(fitWidth(300, 100, 800)).toEqual({ width: 300, height: 100 });
  });
});
