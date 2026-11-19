/**
 * Batch 52 Part 4 — leaving Facebook's in-app browser.
 *
 * Links opened from Facebook, Messenger or Instagram open inside their own
 * browser, where Google login does not work (Google blocks it). On Android
 * the page reopens itself in Chrome once, on arrival; iPhone does not allow
 * that, so a small bar explains how to open it in Safari.
 */

export type InAppPlatform = 'android' | 'ios' | 'other';

export interface InAppInfo {
  /** Inside Facebook / Messenger / Instagram's own browser. */
  inApp: boolean;
  platform: InAppPlatform;
}

/** FBAN / FBAV / FB_IAB / FB4A / FBIOS: Facebook and Messenger;
 *  "Instagram": Instagram; "Messenger" / "MessengerForiOS": Messenger. */
const IN_APP = /FBAN|FBAV|FB_IAB|FB4A|FBIOS|FBSN|Instagram|MessengerForiOS|\bMessenger\b/i;

export function detectInAppBrowser(userAgent: string): InAppInfo {
  const inApp = IN_APP.test(userAgent);
  const platform: InAppPlatform = /Android/i.test(userAgent)
    ? 'android'
    : /iPhone|iPad|iPod/i.test(userAgent)
      ? 'ios'
      : 'other';
  return { inApp, platform };
}

/**
 * An Android "intent" link that opens the same address in Chrome; if
 * Chrome is not there, the phone goes to the normal address instead.
 */
export function androidChromeIntentUrl(href: string): string {
  const url = new URL(href);
  const scheme = url.protocol.replace(':', '');
  const rest = `${url.host}${url.pathname}${url.search}`;
  return (
    `intent://${rest}#Intent;scheme=${scheme};package=com.android.chrome;` +
    `S.browser_fallback_url=${encodeURIComponent(href)};end`
  );
}

/** Set before the jump to Chrome, so it is tried only once per visit. */
const TRIED_KEY = 'nph_inapp_chrome_tried';
/** The iPhone bar was closed (hidden for the rest of the visit). */
const CLOSED_KEY = 'nph_inapp_bar_closed';

function readFlag(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    sessionStorage.setItem(key, '1');
  } catch {
    // Without storage the bar just shows again next page; harmless.
  }
}

export function currentInApp(): InAppInfo {
  if (typeof navigator === 'undefined') return { inApp: false, platform: 'other' };
  return detectInAppBrowser(navigator.userAgent);
}

export function chromeAlreadyTried(): boolean {
  return readFlag(TRIED_KEY);
}

/** Opens this address in Chrome (Android). Returns false if already tried. */
export function reopenInChrome(force = false): boolean {
  if (!force && readFlag(TRIED_KEY)) return false;
  writeFlag(TRIED_KEY);
  window.location.href = androidChromeIntentUrl(window.location.href);
  return true;
}

export function barClosed(): boolean {
  return readFlag(CLOSED_KEY);
}

export function closeBar(): void {
  writeFlag(CLOSED_KEY);
}

/**
 * Run once at start-up, before the app draws anything: inside Facebook's
 * browser on Android, jump to Chrome (once per visit, so never a loop).
 */
export function leaveInAppBrowserOnStart(): void {
  const info = currentInApp();
  if (!info.inApp || info.platform !== 'android') return;
  reopenInChrome();
}

/* The help sheet can be asked for from anywhere (the Google login buttons). */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onInAppHelpRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Google login was tapped inside an in-app browser: Android tries Chrome
 * again; otherwise (iPhone, or Chrome did not open) the help sheet shows.
 */
export function requestInAppHelp(): void {
  const info = currentInApp();
  if (info.platform === 'android') {
    reopenInChrome(true);
    window.setTimeout(() => listeners.forEach((l) => l()), 1500);
    return;
  }
  listeners.forEach((l) => l());
}
