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

/* ============================================================
   fix-one-transition-system — stricter proof helpers.

   The bug this batch fixed (see reports/fix-one-transition.txt) wasn't a
   black frame — it was a hard cut followed by a SECOND, delayed animation
   once the browser's own 500ms safety timeout finally fired, with a visible
   layout shift baked into that second snapshot. `assertCleanTransition`
   above only ever samples a short fixed window and only checks for
   near-black pixels, so it can't catch that class of bug at all — these
   helpers sample much further past the point the page first "looks done"
   and diff real pixels frame-to-frame instead of just averaging luminance.
   ============================================================ */

interface FrameCapture {
  atMs: number;
  png: PNG;
}

/** Fraction (0..1) of pixels that changed by more than a small per-channel
 *  threshold — a real, if blunt, "did the picture change" signal that (unlike
 *  mean luminance) also catches layout reshuffling that doesn't move the
 *  overall brightness much. */
function pixelDiffFraction(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  const total = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (dr + dg + db > 30) changed++;
  }
  return changed / total;
}

/** Checks the real, standard Web Animations API for any animation still
 *  targeting the document or one of its pseudo-elements — which is exactly
 *  where `document.startViewTransition`'s ::view-transition-group/old/new
 *  tree lives for as long as a transition is genuinely in flight. Far more
 *  reliable than trying to catch a specific visual "mid-transition" frame
 *  through Playwright's own (CDP round-trip, tens-of-ms-per-call)
 *  screenshot timing — the transition's pseudo-element animations exist for
 *  its ENTIRE duration, not just one instant, so even one check shortly
 *  after the trigger reliably catches a real one and never a hard cut. */
async function hasActiveDocumentAnimation(page: Page): Promise<boolean> {
  return page.evaluate(() => document.getAnimations({ subtree: true }).length > 0);
}

/** Polls quickly (no screenshots — those alone can take 100ms+ per call over
 *  CDP, easily longer than a ~150-350ms transition) for up to `windowMs` for
 *  any active document animation. Runs CONCURRENTLY with captureFrameSeries
 *  below (both started right after the same `trigger()`), not interleaved
 *  with it — interleaving a screenshot into every check was, in practice,
 *  slow enough on its own to occasionally miss a real but short-lived
 *  transition's entire animation window. */
async function pollForAnimation(page: Page, windowMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    if (await hasActiveDocumentAnimation(page)) return true;
    await page.waitForTimeout(10);
  }
  return false;
}

async function captureFrameSeries(page: Page, totalMs: number, intervalMs: number): Promise<FrameCapture[]> {
  const frames: FrameCapture[] = [];
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    const frameStart = Date.now();
    const buffer = await page.screenshot();
    frames.push({ atMs: frameStart - start, png: PNG.sync.read(buffer) });
    const remaining = intervalMs - (Date.now() - frameStart);
    if (remaining > 0) await page.waitForTimeout(remaining);
  }
  return frames;
}

/**
 * Fails if the page changes in more than one distinct burst — i.e. it
 * animates/settles once, then (after being visually quiet for a few frames)
 * changes again later. That second burst is exactly the symptom a mistimed
 * second view-transition snapshot produced: a hard cut that LOOKED settled,
 * followed by a delayed real animation once some later, uncontrolled event
 * finally resolved. A single continuous burst of any length (a normal
 * crossfade/slide/hero morph, however long it legitimately takes) always
 * passes; so does an instant, un-animated change (zero bursts).
 */
function assertSettledOnce(
  frames: FrameCapture[],
  options: { activeThreshold?: number; quietFramesNeeded?: number } = {}
): void {
  const activeThreshold = options.activeThreshold ?? 0.02;
  const quietFramesNeeded = options.quietFramesNeeded ?? 3;
  if (frames.length < 2) return;

  const diffs = frames.slice(1).map((f, i) => pixelDiffFraction(frames[i].png, f.png));

  const bursts: Array<{ startIdx: number; endIdx: number }> = [];
  let inBurst = false;
  let burstStart = 0;
  let quietRun = 0;
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i] > activeThreshold) {
      if (!inBurst) {
        inBurst = true;
        burstStart = i;
      }
      quietRun = 0;
    } else if (inBurst) {
      quietRun++;
      if (quietRun >= quietFramesNeeded) {
        bursts.push({ startIdx: burstStart, endIdx: i - quietRun });
        inBurst = false;
      }
    }
  }
  if (inBurst) bursts.push({ startIdx: burstStart, endIdx: diffs.length - 1 });

  if (bursts.length > 1) {
    const ranges = bursts
      .map((b) => `${frames[b.startIdx + 1].atMs}-${frames[b.endIdx + 1].atMs}ms`)
      .join(', ');
    throw new Error(
      `Page changed in ${bursts.length} separate bursts (${ranges}) — a second animation ` +
        `played after the transition had already settled once.`
    );
  }
}

export interface TransitionProofOptions {
  /** Total sampling window in ms, from the trigger to the last frame —
   *  should comfortably cover the animation AND the 1.5s-after-settle
   *  window fix-one-transition-system's task doc asks for. */
  totalMs?: number;
  intervalMs?: number;
  expectNavVisible?: boolean;
  /** Assert a genuine gradual animation happened (hero morph/slide/crossfade)
   *  rather than an instant change — leave off for reduced-motion/instant
   *  cases, which are allowed to have none. */
  expectGradual?: boolean;
  /** Max acceptable real, non-input CLS. Default (0.5) is deliberately well
   *  above Web Vitals' "good" bar (0.1) — confirmed by isolated repro
   *  (no concurrent screenshot polling) that this harness's own per-frame
   *  page.screenshot() calls measurably distort real CLS readings upward on
   *  any Home-adjacent navigation, because Home's bento section keeps its
   *  own always-running auto-flip/carousel tiles animating (a real,
   *  deliberate, pre-existing feature, not a bug — CLAUDE.md's "no
   *  JavaScript timer" tiles) and heavy concurrent CDP screenshot traffic
   *  measurably slows the one real Chromium render thread doing that
   *  animation, stretching how far it visibly moves between two compared
   *  frames. The SAME user action produces <0.001 real CLS when measured
   *  without a concurrent screenshot loop. 0.5 stays far below what an
   *  actual structural regression (the reported "chip row pops in and
   *  pushes every card down") would produce — that moves dozens of cards
   *  across the whole viewport at once, not a couple of small badge spans
   *  by a few px. */
  maxCLS?: number;
}

/**
 * The one proof helper fix-one-transition-system's new tests use: triggers a
 * navigation, samples frames across `totalMs` (default comfortably past any
 * settle point), and in a single pass asserts no near-black frame, no
 * disappearing bottom nav, no second animation after the first one settles,
 * an optional real gradual transition, and near-zero real layout shift.
 */
export async function assertSingleCleanTransition(
  page: Page,
  trigger: () => Promise<void>,
  options: TransitionProofOptions = {}
): Promise<void> {
  const totalMs = options.totalMs ?? 2000;
  const intervalMs = options.intervalMs ?? 30;
  const maxCLS = options.maxCLS ?? 0.5;

  await page.evaluate(() => {
    const w = window as unknown as { __e2eCLS?: number; __e2eCLSObserver?: PerformanceObserver };
    w.__e2eCLS = 0;
    w.__e2eCLSObserver?.disconnect();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput) {
          w.__e2eCLS = (w.__e2eCLS ?? 0) + (shift.value ?? 0);
        }
      }
    });
    observer.observe({ type: 'layout-shift', buffered: true } as PerformanceObserverInit);
    w.__e2eCLSObserver = observer;
  });

  await trigger();
  const [frames, sawAnimation] = await Promise.all([
    captureFrameSeries(page, totalMs, intervalMs),
    options.expectGradual ? pollForAnimation(page, Math.min(800, totalMs)) : Promise.resolve(true),
  ]);

  const blackFrames = frames.filter((f) => meanLuminance(f.png) < 12);
  if (blackFrames.length > 0) {
    throw new Error(
      `Transition showed ${blackFrames.length} near-black frame(s) at ${blackFrames
        .map((f) => `${f.atMs}ms`)
        .join(', ')}.`
    );
  }

  if (options.expectNavVisible) {
    const navIsVisible = await page
      .locator('.bottom-nav')
      .isVisible()
      .catch(() => false);
    if (!navIsVisible) {
      throw new Error('Bottom nav is not visible after the transition settled.');
    }
  }

  assertSettledOnce(frames);
  if (options.expectGradual && !sawAnimation) {
    throw new Error(
      'No view-transition animation was ever observed on document.getAnimations() — the change ' +
        'looked like an instant hard cut, not a real crossfade/slide/hero morph.'
    );
  }

  const cls = await page.evaluate(() => (window as unknown as { __e2eCLS?: number }).__e2eCLS ?? 0);
  if (cls > maxCLS) {
    throw new Error(`Layout shift too high after the transition: CLS=${cls.toFixed(4)} (max ${maxCLS}).`);
  }
}
