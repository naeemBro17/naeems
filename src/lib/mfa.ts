// Batch 34 Part 1: two-step login with an Authenticator app (Google
// Authenticator, Microsoft Authenticator, …). Built on Supabase Auth's own
// MFA (TOTP) — no custom crypto, no SMS. The database checks the same thing
// again on every admin action (is_mfa_satisfied(), migration-036).

import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type AssuranceLevel = 'aal1' | 'aal2';

/** One phone set up for two-step login. */
export interface TwoStepDevice {
  id: string;
  name: string;
  createdAt: string;
}

/** What Supabase gives back when a new phone is being set up. */
export interface TwoStepEnrollment {
  factorId: string;
  /** An image (data: URL) of the QR code to scan. */
  qrCode: string;
  /** The same key as text, for typing into the app by hand. */
  secret: string;
}

/** The "aal" claim of the session's access token: aal2 once the 6-digit
 *  code was given in this session, aal1 after the password alone. */
export function sessionAssurance(session: Session | null): AssuranceLevel | null {
  if (!session) return null;
  const part = session.access_token.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { aal?: unknown };
    return claims.aal === 'aal2' ? 'aal2' : 'aal1';
  } catch {
    return null;
  }
}

/** True when the signed-in user has at least one confirmed Authenticator. */
export function sessionHasVerifiedFactor(session: Session | null): boolean {
  return (session?.user.factors ?? []).some((f) => f.status === 'verified');
}

/** The account has an Authenticator, but this session only gave the
 *  password: it must enter the 6-digit code before it can see the admin. */
export function needsTwoStepCode(session: Session | null, serverSaysVerified: boolean | null): boolean {
  if (!session) return false;
  const hasFactor = sessionHasVerifiedFactor(session) || serverSaysVerified === true;
  return hasFactor && sessionAssurance(session) !== 'aal2';
}

/** Keeps digits only, at most 6 — so pasting "123 456" or "123-456" works. */
export function cleanCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

/** The next free "Phone N" name for a new device. */
export function nextDeviceName(existing: string[]): string {
  for (let n = 1; ; n++) {
    const name = `Phone ${n}`;
    if (!existing.includes(name)) return name;
  }
}

/** Supabase returns the QR as an SVG, sometimes without the data: prefix. */
export function qrImageSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/svg+xml;utf-8,${encodeURIComponent(qr)}`;
}

/* ---------- Wrong-code cool-down (this device) ---------- */

export const MAX_WRONG_CODES = 5;
export const CODE_COOLDOWN_MS = 60_000;
const COOLDOWN_KEY = 'naeems-two-step-cooldown';

export interface CodeCooldown {
  failures: number;
  until: number;
}

/** After a wrong code: one more failure, or a 60 s pause after the 5th. */
export function afterWrongCode(state: CodeCooldown, now: number): CodeCooldown {
  const failures = state.failures + 1;
  return failures >= MAX_WRONG_CODES ? { failures: 0, until: now + CODE_COOLDOWN_MS } : { failures, until: 0 };
}

export function readCodeCooldown(): CodeCooldown {
  try {
    const raw = window.localStorage.getItem(COOLDOWN_KEY);
    if (!raw) return { failures: 0, until: 0 };
    const parsed = JSON.parse(raw) as Partial<CodeCooldown>;
    return { failures: parsed.failures ?? 0, until: parsed.until ?? 0 };
  } catch {
    return { failures: 0, until: 0 };
  }
}

export function writeCodeCooldown(value: CodeCooldown): void {
  try {
    window.localStorage.setItem(COOLDOWN_KEY, JSON.stringify(value));
  } catch {
    // Private mode / blocked storage: Supabase's own rate limit still applies.
  }
}

/* ---------- Supabase calls ---------- */

/** Confirmed phones, oldest first. Reads from the server (not the session),
 *  so a phone added on another device is seen too. */
export async function listDevices(): Promise<{ devices: TwoStepDevice[]; error: string | null }> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error || !data) return { devices: [], error: 'Could not load two-step login. Please try again.' };
  const devices = data.totp
    .filter((f) => f.status === 'verified')
    .map((f) => ({ id: f.id, name: f.friendly_name ?? 'Phone', createdAt: f.created_at }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { devices, error: null };
}

/** Removes half-finished set-ups (QR shown, code never typed), so a new
 *  set-up never clashes with an old one's name. */
async function removeUnfinished(): Promise<void> {
  const { data } = await supabase.auth.mfa.listFactors();
  for (const f of data?.all ?? []) {
    if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
}

export async function startEnrollment(name: string): Promise<{ enrollment: TwoStepEnrollment | null; error: string | null }> {
  await removeUnfinished();
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: name });
  if (error || !data || data.type !== 'totp') {
    return { enrollment: null, error: 'Could not start the set-up. Please try again.' };
  }
  return { enrollment: { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret }, error: null };
}

/** Checks a code against one phone. On success the session becomes aal2. */
export async function verifyCode(factorId: string, code: string): Promise<boolean> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  return !error;
}

/** Checks a code against every confirmed phone in turn — the code may come
 *  from either the main or the backup phone. */
export async function verifyAnyDevice(devices: TwoStepDevice[], code: string): Promise<boolean> {
  for (const d of devices) {
    if (await verifyCode(d.id, code)) return true;
  }
  return false;
}

export async function cancelEnrollment(factorId: string): Promise<void> {
  await supabase.auth.mfa.unenroll({ factorId });
}

export async function removeDevice(factorId: string): Promise<boolean> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) return false;
  // Fresh token, so the session's own list of phones (and its level, which
  // Supabase lowers on removal) matches the server.
  await supabase.auth.refreshSession();
  return true;
}

export type TwoStepEvent = 'staff.mfa_on' | 'staff.mfa_device_added' | 'staff.mfa_device_removed' | 'staff.mfa_off';

/** Activity Log entry (never any key or code). Never blocks the action. */
export async function logTwoStepEvent(action: TwoStepEvent, deviceName: string): Promise<void> {
  const { error } = await supabase.rpc('log_mfa_event', { p_action: action, p_device: deviceName });
  if (error) console.warn('Activity log event not recorded:', error.message);
}
