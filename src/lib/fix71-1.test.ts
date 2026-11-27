import { describe, expect, it } from 'vitest';
import { pillKeyframes } from './bottomNav';

// Fix 71.1: the bottom bar's liquid pill slide.

function transformOf(frame: Keyframe): string {
  return String(frame.transform);
}

describe('pillKeyframes', () => {
  const from = { left: 6, width: 120 };
  const to = { left: 186, width: 120 };

  it('starts at the old tab, sized to it', () => {
    const narrowTo = { left: 186, width: 100 };
    const [first] = pillKeyframes(from, narrowTo);
    expect(transformOf(first)).toBe(`translate3d(6px, 0, 0) scale(${120 / 100}, 1)`);
  });

  it('ends at the new tab with no scale', () => {
    const frames = pillKeyframes(from, to);
    expect(transformOf(frames[frames.length - 1])).toBe('translate3d(186px, 0, 0) scale(1, 1)');
  });

  it('stretches and squashes in the middle', () => {
    const [, mid] = pillKeyframes(from, { left: 106, width: 120 });
    expect(mid.offset).toBe(0.45);
    const match = /scale\(([\d.]+), ([\d.]+)\)/.exec(transformOf(mid));
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeCloseTo(1 + 100 / 500, 5);
    expect(Number(match?.[2])).toBe(0.88);
  });

  it('caps the stretch at 1.3 on a long trip', () => {
    const [, mid] = pillKeyframes({ left: 0, width: 120 }, { left: 900, width: 120 });
    const match = /scale\(([\d.]+), ([\d.]+)\)/.exec(transformOf(mid));
    expect(Number(match?.[1])).toBeCloseTo(1.3, 5);
  });
});
