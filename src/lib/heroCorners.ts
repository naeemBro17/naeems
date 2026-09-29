/**
 * Rounded corners for the product hero morph (Batch 23 Part 1).
 *
 * The browser's snapshot of a hero element only contains that element's own
 * painting. A grid card's image box has no radius of its own — its top
 * corners are rounded by the card around it (border-radius + overflow
 * hidden) — so the snapshot is a sharp rectangle, and the real card's round
 * corners "snapped in" the moment the transition ended.
 *
 * The fix: measure the corners the shopper actually SEES on each end (the
 * element's own radius, or the radius of a clipping ancestor whose corner it
 * sits in), clip the morph's group to those corners, and animate them from
 * the old end's value to the new end's with the exact same duration and
 * easing as the morph itself — so the first and last frames match the real
 * pages.
 */

/** Must match `html.vt-hero ::view-transition-group(*)` in app.css. */
export const HERO_MORPH_MS = 320;
export const HERO_MORPH_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

/** Corners closer than this (px) count as the same corner — covers sub-pixel
 *  layout and a 1px card border. */
const CORNER_TOLERANCE_PX = 1.5;

/** First length of a computed corner radius ("18px", "18px 18px", "50%"). */
function radiusPx(value: string, basis: number): number {
  const first = value.trim().split(/\s+/)[0] ?? '0';
  const amount = Number.parseFloat(first);
  if (!Number.isFinite(amount)) return 0;
  return first.endsWith('%') ? (amount / 100) * basis : amount;
}

function ownRadii(style: CSSStyleDeclaration, width: number): CornerRadii {
  return {
    topLeft: radiusPx(style.borderTopLeftRadius, width),
    topRight: radiusPx(style.borderTopRightRadius, width),
    bottomRight: radiusPx(style.borderBottomRightRadius, width),
    bottomLeft: radiusPx(style.borderBottomLeftRadius, width),
  };
}

function clips(style: CSSStyleDeclaration): boolean {
  return style.overflowX !== 'visible' || style.overflowY !== 'visible';
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= CORNER_TOLERANCE_PX;
}

/**
 * The corner radii an element visibly has on screen: its own, or — for any
 * corner it shares with a clipping ancestor's inner (padding-box) corner —
 * that ancestor's inner radius, whichever is larger.
 */
export function visibleCornerRadii(el: HTMLElement): CornerRadii {
  const rect = el.getBoundingClientRect();
  const radii = ownRadii(getComputedStyle(el), rect.width);

  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const style = getComputedStyle(a);
    if (!clips(style)) continue;
    const outer = a.getBoundingClientRect();
    const border = {
      top: Number.parseFloat(style.borderTopWidth) || 0,
      right: Number.parseFloat(style.borderRightWidth) || 0,
      bottom: Number.parseFloat(style.borderBottomWidth) || 0,
      left: Number.parseFloat(style.borderLeftWidth) || 0,
    };
    const inner = {
      top: outer.top + border.top,
      right: outer.right - border.right,
      bottom: outer.bottom - border.bottom,
      left: outer.left + border.left,
    };
    const theirs = ownRadii(style, outer.width);
    const innerRadius = (r: number, b1: number, b2: number) => Math.max(0, r - Math.max(b1, b2));
    const top = near(rect.top, inner.top);
    const bottom = near(rect.bottom, inner.bottom);
    const left = near(rect.left, inner.left);
    const right = near(rect.right, inner.right);
    if (top && left) {
      radii.topLeft = Math.max(radii.topLeft, innerRadius(theirs.topLeft, border.top, border.left));
    }
    if (top && right) {
      radii.topRight = Math.max(radii.topRight, innerRadius(theirs.topRight, border.top, border.right));
    }
    if (bottom && right) {
      radii.bottomRight = Math.max(
        radii.bottomRight,
        innerRadius(theirs.bottomRight, border.bottom, border.right)
      );
    }
    if (bottom && left) {
      radii.bottomLeft = Math.max(
        radii.bottomLeft,
        innerRadius(theirs.bottomLeft, border.bottom, border.left)
      );
    }
  }
  return radii;
}

/** The two promises of a started View Transition this module waits on. */
interface TransitionPromises {
  ready: Promise<void>;
  finished: Promise<void>;
}

/** The element currently carrying `name` as its inline view-transition-name. */
export function elementWithTransitionName(name: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('[style*="view-transition-name"]');
  for (const el of Array.from(candidates)) {
    if (el.style.getPropertyValue('view-transition-name') === name) return el;
  }
  return null;
}

function keyframe(r: CornerRadii): Keyframe {
  return {
    borderTopLeftRadius: `${r.topLeft}px`,
    borderTopRightRadius: `${r.topRight}px`,
    borderBottomRightRadius: `${r.bottomRight}px`,
    borderBottomLeftRadius: `${r.bottomLeft}px`,
  };
}

/**
 * Call right BEFORE `document.startViewTransition` (the "old" page is still
 * on screen): measures the old end's corners and returns a function to call
 * with the started transition, which clips the group from the very first
 * frame and animates its corners to the new end's once the new page exists.
 * Does nothing when no element carries `name` on either side (a plain
 * crossfade — there is no morph to round).
 */
export function prepareHeroCornerMorph(name: string): (transition: TransitionPromises) => void {
  const from = elementWithTransitionName(name);
  if (!from) return () => undefined;
  const fromRadii = visibleCornerRadii(from);
  const pseudoElement = `::view-transition-group(${name})`;

  // Static clip for the group, so even the frame the pseudo-elements first
  // exist on already shows the old end's real corners.
  const style = document.createElement('style');
  style.textContent = `${pseudoElement}{overflow:clip;${Object.entries({
    'border-top-left-radius': fromRadii.topLeft,
    'border-top-right-radius': fromRadii.topRight,
    'border-bottom-right-radius': fromRadii.bottomRight,
    'border-bottom-left-radius': fromRadii.bottomLeft,
  })
    .map(([prop, px]) => `${prop}:${px}px`)
    .join(';')}}`;
  document.head.appendChild(style);

  return (transition) => {
    let corners: Animation | null = null;
    // 'forwards' holds the final corners until the pseudo-elements are gone;
    // cancelled then so the finished animation doesn't linger on <html>.
    const cleanup = () => {
      corners?.cancel();
      style.remove();
    };
    transition.finished.then(cleanup, cleanup);
    transition.ready
      .then(() => {
        const to = elementWithTransitionName(name);
        if (!to) return;
        corners = document.documentElement.animate(
          [keyframe(fromRadii), keyframe(visibleCornerRadii(to))],
          { duration: HERO_MORPH_MS, easing: HERO_MORPH_EASING, fill: 'forwards', pseudoElement }
        );
      })
      .catch(() => undefined);
  };
}
