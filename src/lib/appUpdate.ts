/**
 * Batch 31 Part 7: new versions of the app arrive quickly, but never in the
 * middle of something.
 *
 * The service worker is checked for a new version when the app opens, each
 * time it comes back to the foreground, and every 30 minutes while it is
 * open. A new version is downloaded in the background and waits. It is
 * switched on (one reload) only at a safe moment:
 *   - the app was put in the background, or
 *   - the next page change, or
 *   - right away, if the app has only just opened and nothing was touched.
 * Never on the cart or checkout pages, never while a sheet / dialog is
 * open, never while a text field has the cursor, and never after something
 * was typed on the current page (an unsaved form, e.g. admin editing) —
 * that waits for the next page change. After the reload a small "Updated"
 * toast is shown once.
 */

/** Coming back to the app checks again, but not more than once a minute. */
const MIN_CHECK_GAP_MS = 60 * 1000;
export const CHECK_EVERY_MS = 30 * 60 * 1000;
const UPDATED_FLAG = 'naeems-app-updated';

/** Cart and checkout: an update is never applied on these pages. */
export function isCheckoutPath(pathname: string): boolean {
  return /^\/(cart|checkout)(\/|$)/.test(pathname);
}

export interface PageState {
  pathname: string;
  /** A sheet or dialog is open. */
  dialogOpen: boolean;
  /** A text field / select has the cursor. */
  editing: boolean;
  /** Something was typed on this page since it opened. */
  typedOnPage: boolean;
}

/** Whether reloading now could lose anything or interrupt a purchase. */
export function isSafeMoment(state: PageState): boolean {
  return !isCheckoutPath(state.pathname) && !state.dialogOpen && !state.editing && !state.typedOnPage;
}

export interface UpdateEnvironment {
  /** Switches on the waiting version and reloads the page. */
  applyUpdate: () => void;
  /** Asks the server whether a new version exists. */
  checkForUpdate: () => void;
  pageState: () => PageState;
  isHidden: () => boolean;
  now: () => number;
}

/**
 * The decisions, without the browser. main.tsx wires it to the service
 * worker, the history and the document (startAppUpdates below).
 */
export class AppUpdateController {
  private updateReady = false;
  private applied = false;
  private touched = false;
  private typed = false;
  private lastCheck = 0;

  constructor(private readonly env: UpdateEnvironment) {}

  state(): PageState {
    return { ...this.env.pageState(), typedOnPage: this.typed };
  }

  /** The new version is downloaded and waiting. */
  onUpdateReady(): void {
    this.updateReady = true;
    if (this.env.isHidden() || !this.touched) this.tryApply();
  }

  /** The person tapped or pressed a key somewhere (the app is in use). */
  onInteraction(): void {
    this.touched = true;
  }

  /** Something was typed into a field on the current page. */
  onTyped(): void {
    this.touched = true;
    this.typed = true;
  }

  /** The page changed (in-app navigation). */
  onNavigate(): void {
    this.typed = false;
    this.tryApply();
  }

  onHidden(): void {
    this.tryApply();
  }

  onVisible(): void {
    this.check();
  }

  /** Every 30 minutes while open. */
  onTimer(): void {
    if (!this.env.isHidden()) this.check(true);
  }

  check(force = false): void {
    const now = this.env.now();
    if (!force && now - this.lastCheck < MIN_CHECK_GAP_MS) return;
    this.lastCheck = now;
    this.env.checkForUpdate();
  }

  private tryApply(): void {
    if (!this.updateReady || this.applied) return;
    if (!isSafeMoment(this.state())) return;
    this.applied = true;
    this.env.applyUpdate();
  }
}

export function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(el.type);
}

/** Read once at start-up: true right after an update reload. */
export function consumeUpdatedFlag(): boolean {
  try {
    const was = window.sessionStorage.getItem(UPDATED_FLAG) === '1';
    if (was) window.sessionStorage.removeItem(UPDATED_FLAG);
    return was;
  } catch {
    return false;
  }
}

export function markUpdated(): void {
  try {
    window.sessionStorage.setItem(UPDATED_FLAG, '1');
  } catch {
    // Private mode: the update still happens, just without the toast.
  }
}
