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
   *  its live width sampled on every frame while it animated. `radii` is
   *  the group's live top-left corner radius on those same frames, and
   *  `fromRadius`/`toRadius` the real on-page element's visible top-left
   *  radius just before the transition and just after it finished — the
   *  first and last frames must equal them (Batch 23 Part 1). */
  hero: HeroRecord | null;
}

export interface HeroRecord {
  name: string;
  fromWidth: number;
  toWidth: number;
  samples: number[];
  radii: number[];
  fromRadius: number | null;
  toRadius: number | null;
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
    // The visible top-left corner radius of whichever element carries a
    // product-hero name: its own radius, or a clipping ancestor's inner
    // radius when it sits in that ancestor's corner (the grid card).
    const visibleTopLeftRadius = (): number | null => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('[style*="view-transition-name"]')).find(
        (candidate) => candidate.style.getPropertyValue('view-transition-name').startsWith('product-hero-')
      );
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      let radius = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const style = getComputedStyle(a);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const outer = a.getBoundingClientRect();
        const bt = Number.parseFloat(style.borderTopWidth) || 0;
        const bl = Number.parseFloat(style.borderLeftWidth) || 0;
        if (Math.abs(rect.top - (outer.top + bt)) <= 1.5 && Math.abs(rect.left - (outer.left + bl)) <= 1.5) {
          const theirs = Number.parseFloat(style.borderTopLeftRadius) || 0;
          radius = Math.max(radius, theirs - Math.max(bt, bl));
        }
      }
      return radius;
    };
    document.startViewTransition = ((update?: ViewTransitionUpdateCallback) => {
      const fromRadius = visibleTopLeftRadius();
      const transition = original(update);
      // Registered before the app's own `await transition.finished`, so it
      // measures the returned-to card before the app clears its name.
      let toRadius: number | null = null;
      const measureEnd = () => {
        toRadius = visibleTopLeftRadius();
      };
      transition.finished.then(measureEnd, measureEnd);
      const record: {
        pseudos: string[];
        scrollYAfterUpdate: number | null;
        hero: {
          name: string;
          fromWidth: number;
          toWidth: number;
          samples: number[];
          radii: number[];
          fromRadius: number | null;
          toRadius: number | null;
        } | null;
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
          // The group's size/position animation — not the corner-radius one
          // lib/heroCorners.ts runs on the same pseudo-element.
          const heroGroup = animations.find((animation) => {
            const effect = animation.effect as KeyframeEffect | null;
            const pseudo = effect?.pseudoElement ?? '';
            return (
              pseudo.startsWith('::view-transition-group(product-hero-') &&
              effect !== null &&
              effect.getKeyframes().some((frame) => frame.width !== undefined)
            );
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
            radii: [],
            fromRadius,
            toRadius: null,
          };
          // Sampled on the page's own frames until the transition ends — a
          // single fixed-time sample could land before the first animated
          // frame when the machine is busy.
          let done = false;
          const hero = record.hero;
          const settle = () => {
            done = true;
            hero.toRadius = toRadius;
          };
          transition.finished.then(settle, settle);
          while (!done) {
            const groupStyle = getComputedStyle(document.documentElement, pseudo);
            const width = px(groupStyle.width);
            if (Number.isFinite(width)) hero.samples.push(width);
            const radius = px(groupStyle.borderTopLeftRadius);
            if (Number.isFinite(radius)) hero.radii.push(radius);
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
