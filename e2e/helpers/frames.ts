import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';

interface FrameSample {
  atMs: number;
  meanLuminance: number;
  navVisible: boolean | null;
}

/** 0 (black) to 255 (white) average across every pixel's perceived brightness. */
function meanLuminance(png: PNG): number {
  let sum = 0;
  const pixelCount = png.width * png.height;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return sum / pixelCount;
}

/**
 * Clicks `trigger`, then samples the viewport every ~40ms for `windowMs` and
 * asserts none of those frames are a near-black or near-blank flash — the
 * exact bug class reports/batch-21.txt Part 1 fixed (the new page painting
 * once, fully, before its animation class ever arrived). Also checks the
 * bottom nav (when `expectNavVisible` is true) never disappears mid-flight,
 * per Part 1 point 6.
 *
 * A real animation legitimately dips in brightness for a crossfade — the
 * threshold is "near black" (mean luminance under 12/255, i.e. an almost
 * entirely black frame), not "any darkening", so a normal fade doesn't
 * false-positive.
 */
export async function assertCleanTransition(
  page: Page,
  trigger: () => Promise<void>,
  options: { windowMs?: number; expectNavVisible?: boolean } = {}
): Promise<FrameSample[]> {
  const windowMs = options.windowMs ?? 450;
  const sampleEveryMs = 40;
  const samples: FrameSample[] = [];
  const start = Date.now();

  await trigger();

  while (Date.now() - start < windowMs) {
    const buffer = await page.screenshot();
    const png = PNG.sync.read(buffer);
    let navVisible: boolean | null = null;
    if (options.expectNavVisible) {
      navVisible = await page
        .locator('.bottom-nav')
        .isVisible()
        .catch(() => false);
    }
    samples.push({ atMs: Date.now() - start, meanLuminance: meanLuminance(png), navVisible });
    await page.waitForTimeout(sampleEveryMs);
  }

  const blackFrames = samples.filter((s) => s.meanLuminance < 12);
  if (blackFrames.length > 0) {
    throw new Error(
      `Transition showed ${blackFrames.length} near-black frame(s) at ${blackFrames
        .map((f) => `${f.atMs}ms`)
        .join(', ')} (mean luminance under 12/255).`
    );
  }

  if (options.expectNavVisible) {
    const navMissing = samples.filter((s) => s.navVisible === false);
    if (navMissing.length > 0) {
      throw new Error(
        `Bottom nav disappeared during the transition at ${navMissing
          .map((f) => `${f.atMs}ms`)
          .join(', ')}.`
      );
    }
  }

  return samples;
}
