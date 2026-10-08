import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import {
  CODE_COOLDOWN_MS,
  MAX_WRONG_CODES,
  afterWrongCode,
  cleanCode,
  needsTwoStepCode,
  nextDeviceName,
  qrImageSrc,
  sessionAssurance,
  sessionHasVerifiedFactor,
} from './mfa';
import { inputModalityForKey } from './inputModality';
import { isAuthorizedNotifyCall, timingSafeEqual } from '../../supabase/functions/_shared/notifyAuth';

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeSession(aal: 'aal1' | 'aal2', factors: { status: 'verified' | 'unverified' }[]): Session {
  return {
    access_token: `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1', aal })}.sig`,
    user: { id: 'u1', factors: factors.map((f, i) => ({ id: `f${i}`, factor_type: 'totp', status: f.status })) },
  } as unknown as Session;
}

describe('Batch 34 Part 1 — two-step login (client side)', () => {
  it('reads the session level from the token', () => {
    expect(sessionAssurance(fakeSession('aal1', []))).toBe('aal1');
    expect(sessionAssurance(fakeSession('aal2', []))).toBe('aal2');
    expect(sessionAssurance(null)).toBeNull();
  });

  it('asks for the code only when the account has a confirmed phone and the session gave only the password', () => {
    expect(needsTwoStepCode(fakeSession('aal1', []), false)).toBe(false); // no phone: exactly as today
    expect(needsTwoStepCode(fakeSession('aal1', [{ status: 'unverified' }]), false)).toBe(false); // half-finished set-up
    expect(needsTwoStepCode(fakeSession('aal1', [{ status: 'verified' }]), null)).toBe(true);
    expect(needsTwoStepCode(fakeSession('aal2', [{ status: 'verified' }]), true)).toBe(false);
    // A phone added on another device (server knows, session copy is older).
    expect(needsTwoStepCode(fakeSession('aal1', []), true)).toBe(true);
    expect(needsTwoStepCode(null, true)).toBe(false);
    expect(sessionHasVerifiedFactor(fakeSession('aal1', [{ status: 'verified' }]))).toBe(true);
  });

  it('keeps digits only, so a pasted "123 456" works', () => {
    expect(cleanCode('123 456')).toBe('123456');
    expect(cleanCode('12-34-56-78')).toBe('123456');
    expect(cleanCode('abc')).toBe('');
  });

  it('5 wrong codes → a 60 s pause, then the count starts again', () => {
    let state = { failures: 0, until: 0 };
    for (let i = 1; i < MAX_WRONG_CODES; i++) {
      state = afterWrongCode(state, 1000);
      expect(state).toEqual({ failures: i, until: 0 });
    }
    state = afterWrongCode(state, 1000);
    expect(state).toEqual({ failures: 0, until: 1000 + CODE_COOLDOWN_MS });
    expect(CODE_COOLDOWN_MS).toBe(60_000);
  });

  it('names new phones Phone 1, Phone 2, … without clashing', () => {
    expect(nextDeviceName([])).toBe('Phone 1');
    expect(nextDeviceName(['Phone 1'])).toBe('Phone 2');
    expect(nextDeviceName(['Phone 2'])).toBe('Phone 1');
  });

  it('shows the QR as an image whether or not Supabase added the data: prefix', () => {
    expect(qrImageSrc('data:image/svg+xml;utf-8,<svg/>')).toBe('data:image/svg+xml;utf-8,<svg/>');
    expect(qrImageSrc('<svg/>')).toBe('data:image/svg+xml;utf-8,%3Csvg%2F%3E');
  });
});

describe('Batch 34 Part 1 — database check (migration-036)', () => {
  const sql = readFileSync('supabase/migration-036-batch34-security.sql', 'utf8');

  it('one shared helper, used by every admin gate', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.is_mfa_satisfied\(\)/);
    for (const fn of ['is_admin', 'is_staff', 'staff_can']) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}(`));
      expect(body.slice(0, body.indexOf('$function$;'))).toContain('is_mfa_satisfied()');
    }
  });

  it('a user without a confirmed factor passes; with one, only an aal2 session passes', () => {
    const helper = sql.slice(sql.indexOf('FUNCTION public.is_mfa_satisfied'), sql.indexOf('REVOKE ALL ON FUNCTION public.is_mfa_satisfied'));
    expect(helper).toContain("COALESCE(auth.jwt() ->> 'aal', 'aal1') = 'aal2'");
    expect(helper).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM auth\.mfa_factors f\s*WHERE f\.user_id = auth\.uid\(\) AND f\.status = 'verified'/);
  });

  it('holds no key of its own', () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(sql).not.toMatch(/sb_secret_[A-Za-z0-9_-]{10,}/);
    expect(sql).toContain("vault.decrypted_secrets WHERE name = 'notify_telegram_order_secret'");
  });
});

describe('Batch 34 Part 3 — notify-telegram-order caller check', () => {
  const base = { secretHeader: null, authorization: null, expectedSecret: 'shared-secret-abc', serviceKey: 'service-key-xyz' };

  it('accepts the trigger (right shared secret)', () => {
    expect(isAuthorizedNotifyCall({ ...base, secretHeader: 'shared-secret-abc' })).toBe(true);
  });

  it('refuses no header, a wrong secret, or a secret before Vault is set up', () => {
    expect(isAuthorizedNotifyCall(base)).toBe(false);
    expect(isAuthorizedNotifyCall({ ...base, secretHeader: 'shared-secret-abd' })).toBe(false);
    expect(isAuthorizedNotifyCall({ ...base, secretHeader: 'x' })).toBe(false);
    expect(isAuthorizedNotifyCall({ ...base, secretHeader: 'anything', expectedSecret: null })).toBe(false);
  });

  it('still accepts the old webhook (service key) only exactly, never the public key', () => {
    expect(isAuthorizedNotifyCall({ ...base, authorization: 'Bearer service-key-xyz' })).toBe(true);
    expect(isAuthorizedNotifyCall({ ...base, authorization: 'Bearer public-anon-key' })).toBe(false);
    expect(isAuthorizedNotifyCall({ ...base, authorization: 'service-key-xyz' })).toBe(false);
    expect(isAuthorizedNotifyCall({ ...base, authorization: 'Bearer service-key-xyz', serviceKey: null })).toBe(false);
  });

  it('compares in constant time and exactly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('Batch 34 Part 5 — keyboard or finger', () => {
  it('only focus-moving keys switch the rings on; typing does not', () => {
    expect(inputModalityForKey('Tab')).toBe('keyboard');
    expect(inputModalityForKey('ArrowDown')).toBe('keyboard');
    expect(inputModalityForKey('a')).toBeNull();
    expect(inputModalityForKey('Enter')).toBeNull();
    expect(inputModalityForKey('Unidentified')).toBeNull();
  });
});
