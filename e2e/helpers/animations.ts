import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The phone-back reverse-hero switch, read straight from the source file so
 * the tests always check the behaviour that actually ships (fix/back-known-
 * good Part 3): OFF = phone back must be an instant switch with nothing
 * animating afterwards; ON = it must be a real reverse hero captured from the
 * product page, and still nothing afterwards.
 */
export function phoneBackHeroEnabled(): boolean {
  const source = readFileSync(
    resolve(__dirname, '..', '..', 'src', 'lib', 'phoneBackTransition.ts'),
    'utf8'
  );
  const match = /PHONE_BACK_HERO_ENABLED\s*=\s*(true|false)/.exec(source);
  if (!match) throw new Error('Could not read PHONE_BACK_HERO_ENABLED from phoneBackTransition.ts');
  return match[1] === 'true';
}

/**
 * Widgets that animate on their own timer whatever the navigation did — the
 * bento flip tile (an infinite CSS animation), the bento carousel tile and
 * the hero banner's autoplay (its dots transition every few seconds).
 * Everything else counts: an
 * animation anywhere else after a Back has settled is exactly the "ghost
 * crossfade / chip row pops in / corners flicker" bug from Naeem's phone.
 */
const SELF_RUNNING_SELECTOR = '.hero-banner, .bento-flipper, .bento-tile--carousel';

export interface StrayAnimation {
  atMs: number;
  what: string;
}

/**
 * Runs INSIDE the page (a requestAnimationFrame loop, so it's immune to the
 * test runner being slow under load): starting `delayMs` after the call,
 * records every animation or transition that is running at any frame during
 * `windowMs`, other than the self-running widgets above and infinite loops.
 * Call it right after a navigation has been handed to the page.
 */
export async function collectStrayAnimations(
  page: Page,
  { delayMs = 50, windowMs = 1500 }: { delayMs?: number; windowMs?: number } = {}
): Promise<StrayAnimation[]> {
  return page.evaluate(
    async ({ delayMs: delay, windowMs: span, selfRunning }) => {
      const found = new Map<string, number>();
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, delay));
      const end = performance.now() + span;
      while (performance.now() < end) {
        for (const animation of document.getAnimations()) {
          if (animation.playState !== 'running') continue;
          const effect = animation.effect as KeyframeEffect | null;
          if (!effect) continue;
          if (effect.getTiming().iterations === Infinity) continue;
          const target = effect.target as Element | null;
          if (target && !effect.pseudoElement && target.closest(selfRunning)) continue;
          const name =
            animation instanceof CSSAnimation
              ? animation.animationName
              : animation instanceof CSSTransition
                ? `transition:${animation.transitionProperty}`
                : 'script-animation';
          const where = effect.pseudoElement ?? (target ? `.${target.className}` : '?');
          const key = `${name} on ${where}`;
          if (!found.has(key)) found.set(key, Math.round(performance.now() - t0));
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      return Array.from(found.entries()).map(([what, atMs]) => ({ what, atMs }));
    },
    { delayMs, windowMs, selfRunning: SELF_RUNNING_SELECTOR }
  );
}

export interface ViewTransitionRecord {
  /** Every ::view-transition-* pseudo animation seen, by pseudo-element. */
  pseudos: string[];
  /** window.scrollY the moment the transition's page update finished — the
   *  state the browser's "after" picture (the first new frame) is taken from. */
  scrollYAfterUpdate: number | null;
  /** For a product hero group: its keyframed start/end width in px, and
   *  its live width sampled on every frame while it animated. */
  hero: { name: string; fromWidth: number; toWidth: number; samples: number[] } | null;
}

/**
 * Installs (before the page's own scripts run) a wrapper around
 * document.startViewTransition that records what each real View Transition
 * actually animated — read back with readViewTransitions. This is the proof
 * the old suite lacked: it counted ANY animation (the bento tile's infinite
 * flip made "an animation happened" always true on Home), so a hard cut plus
 * a ghost crossfade still passed.
 */
export async function recordViewTransitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __vtRecords: unknown[] };
    w.__vtRecords = [];
    const original = document.startViewTransition?.bind(document);
    if (!original) return;
    document.startViewTransition = ((update?: ViewTransitionUpdateCallback) => {
      const transition = original(update);
      const record: {
        pseudos: string[];
        scrollYAfterUpdate: number | null;
        hero: { name: string; fromWidth: number; toWidth: number; samples: number[] } | null;
      } = { pseudos: [], scrollYAfterUpdate: null, hero: null };
      w.__vtRecords.push(record);
      transition.updateCallbackDone
        .then(() => {
          record.scrollYAfterUpdate = window.scrollY;
        })
        .catch(() => undefined);
      transition.ready
        .then(async () => {
          const animations = document.getAnimations();
          for (const animation of animations) {
            const effect = animation.effect as KeyframeEffect | null;
            if (effect?.pseudoElement?.startsWith('::view-transition')) {
              record.pseudos.push(effect.pseudoElement);
            }
          }
          const heroGroup = animations.find((animation) => {
            const pseudo = (animation.effect as KeyframeEffect | null)?.pseudoElement ?? '';
            return pseudo.startsWith('::view-transition-group(product-hero-');
          });
          if (!heroGroup) return;
          const effect = heroGroup.effect as KeyframeEffect;
          const frames = effect.getKeyframes();
          const px = (value: unknown) => Number.parseFloat(String(value ?? 'NaN'));
          const pseudo = effect.pseudoElement ?? '';
          record.hero = {
            name: pseudo,
            fromWidth: px(frames[0]?.width),
            toWidth: px(frames[frames.length - 1]?.width),
            samples: [],
          };
          // Sampled on the page's own frames until the transition ends — a
          // single fixed-time sample could land before the first animated
          // frame when the machine is busy.
          let done = false;
          transition.finished.then(
            () => (done = true),
            () => (done = true)
          );
          while (!done) {
            const width = px(getComputedStyle(document.documentElement, pseudo).width);
            if (Number.isFinite(width)) record.hero.samples.push(width);
            await new Promise((r) => requestAnimationFrame(r));
          }
        })
        .catch(() => undefined);
      return transition;
    }) as typeof document.startViewTransition;
  });
}

export async function readViewTransitions(page: Page): Promise<ViewTransitionRecord[]> {
  return page.evaluate(
    () => (window as unknown as { __vtRecords: ViewTransitionRecord[] }).__vtRecords ?? []
  );
}

/** Resolves once no ::view-transition pseudo animation is running — a real
 *  signal to wait on instead of a fixed timeout. */
export async function waitForViewTransitionsToFinish(page: Page, timeoutMs = 5000): Promise<void> {
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some((a) => ((a.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')) &&
      !Array.from(document.documentElement.classList).some((c) => c.startsWith('vt-')),
    undefined,
    { timeout: timeoutMs }
  );
}
