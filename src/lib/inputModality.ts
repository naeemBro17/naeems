// Batch 34 Part 5: remembers whether the visitor is using the keyboard or a
// finger/mouse, on <html data-input="keyboard|pointer">. The one shared
// focus style in app.css draws its ring only in keyboard mode — a text
// field counts as ":focus-visible" even when tapped, so CSS alone cannot
// tell a tap from a Tab there.

/** Keys that move focus around the page (typing letters does not count —
 *  phone keyboards send key events too). */
const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

export function inputModalityForKey(key: string): 'keyboard' | null {
  return NAVIGATION_KEYS.has(key) ? 'keyboard' : null;
}

export function trackInputModality(root: HTMLElement = document.documentElement): void {
  const set = (value: 'keyboard' | 'pointer') => {
    if (root.dataset.input !== value) root.dataset.input = value;
  };
  window.addEventListener(
    'keydown',
    (e) => {
      if (inputModalityForKey(e.key)) set('keyboard');
    },
    { capture: true, passive: true }
  );
  window.addEventListener('pointerdown', () => set('pointer'), { capture: true, passive: true });
}
