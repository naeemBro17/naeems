import type { Page } from '@playwright/test';
import { E2E_EMAIL, E2E_PASSWORD, SUPABASE_ANON_KEY, SUPABASE_URL, supabaseProjectRef } from './env';

/**
 * There is deliberately no email/password form anywhere in the site's UI —
 * real customers only ever see "Continue with Google" (reports/batch-21.txt
 * Part 3). So a logged-in test signs in the standard "skip the UI" Playwright
 * way: call Supabase's own password-grant endpoint directly from Node, then
 * write the resulting session into localStorage under the exact key
 * supabase-js reads on boot, before the page's first script ever runs. The
 * app never knows the difference between this and a real interactive sign-in
 * — same session shape, same supabase-js client picking it up via getSession().
 */
export async function signInAsTestCustomer(page: Page): Promise<void> {
  if (!E2E_EMAIL || !E2E_PASSWORD) {
    throw new Error(
      'Missing .env.e2e — run the test-account setup first (see reports/batch-21.txt Part 3).'
    );
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`Test-customer sign-in failed: HTTP ${res.status}`);
  }
  const token = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    user: unknown;
  };

  const storageKey = `sb-${supabaseProjectRef()}-auth-token`;
  const session = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_in: token.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
    token_type: token.token_type,
    user: token.user,
  };

  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(session)]
  );
}
