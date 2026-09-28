/**
 * Minimal ambient types for the browser's Navigation API — TypeScript's
 * bundled DOM lib doesn't ship these yet. Only the shapes lib/navigationTransitions.ts
 * actually reads/calls are declared; this is not a full spec surface.
 * See https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API
 */

interface NavigationHistoryEntry {
  readonly url: string | null;
  readonly index: number;
  getState(): unknown;
}

interface NavigationDestination {
  readonly url: string;
  readonly index: number;
  getState(): unknown;
}

interface NavigationInterceptOptions {
  handler?: () => Promise<void> | void;
}

interface NavigateEvent extends Event {
  readonly canIntercept: boolean;
  readonly hashChange: boolean;
  readonly downloadRequest: string | null;
  readonly navigationType: 'push' | 'replace' | 'reload' | 'traverse';
  readonly destination: NavigationDestination;
  intercept(options?: NavigationInterceptOptions): void;
}

interface Navigation extends EventTarget {
  readonly currentEntry: NavigationHistoryEntry | null;
  addEventListener(
    type: 'navigate',
    listener: (event: NavigateEvent) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
  removeEventListener(
    type: 'navigate',
    listener: (event: NavigateEvent) => void,
    options?: boolean | EventListenerOptions
  ): void;
}

interface Window {
  readonly navigation?: Navigation;
}
