/**
 * Batch 47 Task 7: after logging in (or signing up — Google does both) the
 * customer goes back to the page they were on before the account page, not
 * left on the account page with Back stepping through the login. Opened
 * directly (no earlier page in this tab): the shop home.
 */
const KEY = 'login-return-path';

/** A path inside this site that is worth returning to (never the account
 *  page itself, never another site). */
export function safeReturnPath(path: string | null | undefined): string | null {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('://')) return null;
  const pathname = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (pathname === '/account' || pathname.startsWith('/admin') || pathname.startsWith('/wholesale')) return null;
  return path;
}

/** Called on every page change: the last shop page visited in this tab. */
export function rememberShopPage(path: string): void {
  const safe = safeReturnPath(path);
  if (!safe) return;
  try {
    window.sessionStorage.setItem(KEY, safe);
  } catch {
    // Storage blocked: the account page falls back to the shop home.
  }
}

/** Where to go after logging in from the account page. */
export function loginReturnPath(fromState: unknown): string {
  const fromRoute =
    typeof fromState === 'object' && fromState !== null && 'from' in fromState ? safeReturnPath(String((fromState as { from: unknown }).from)) : null;
  if (fromRoute) return fromRoute;
  try {
    return safeReturnPath(window.sessionStorage.getItem(KEY)) ?? '/';
  } catch {
    return '/';
  }
}
