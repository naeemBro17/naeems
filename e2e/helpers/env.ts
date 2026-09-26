import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal .env parser (no dotenv dependency) — reads KEY=value lines,
 * ignores blank lines and #-comments, doesn't do quote/escape handling
 * because none of the values this project stores need it.
 */
function parseEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const root = resolve(__dirname, '..', '..');
const base = parseEnvFile(resolve(root, '.env'));
const e2e = parseEnvFile(resolve(root, '.env.e2e'));

export const SUPABASE_URL = base.VITE_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = base.VITE_SUPABASE_ANON_KEY ?? '';
export const E2E_EMAIL = e2e.E2E_TEST_EMAIL ?? '';
export const E2E_PASSWORD = e2e.E2E_TEST_PASSWORD ?? '';

export function supabaseProjectRef(): string {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(SUPABASE_URL);
  if (!match) throw new Error('Could not parse Supabase project ref from VITE_SUPABASE_URL');
  return match[1];
}
