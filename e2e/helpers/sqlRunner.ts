import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Batch 39: runs a SQL script on the linked Supabase project with the
 * Supabase command line (supabase/.temp is linked to the live project on
 * this computer). Used only for scripts that are safe on the live
 * database: e2e/sql/batch-39-inventory.sql ends with an error, so every
 * change it makes is undone; e2e/sql/batch-39-lock.sql works only on its
 * own hidden throwaway rows and removes them.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The supabase command: $SUPABASE_CLI, else the copy npx keeps in its cache. */
export function supabaseCli(): string | null {
  if (process.env.SUPABASE_CLI && existsSync(process.env.SUPABASE_CLI)) return process.env.SUPABASE_CLI;
  const cache = join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  const local = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'supabase.cmd' : 'supabase');
  if (existsSync(local)) return local;
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache)) {
    const bin = join(cache, dir, 'node_modules', '.bin', process.platform === 'win32' ? 'supabase.cmd' : 'supabase');
    if (existsSync(bin)) return bin;
  }
  return null;
}

/** Runs the SQL; resolves with everything the command printed. */
export function runSql(sql: string): Promise<string> {
  const cli = supabaseCli();
  if (!cli) return Promise.reject(new Error('The Supabase command line was not found (set SUPABASE_CLI).'));
  const dir = mkdtempSync(join(tmpdir(), 'b39-sql-'));
  const file = join(dir, 'script.sql');
  writeFileSync(file, sql);
  return new Promise((resolvePromise) => {
    let out = '';
    const child = spawn(`"${cli}"`, ['db', 'query', '--linked', '-f', `"${file}"`], { cwd: root, shell: true });
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', () => resolvePromise(out));
  });
}

/** The error message the database returned, or null when the script ran
 *  without one. */
export function sqlError(output: string): string | null {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const outer = JSON.parse(output.slice(start, end + 1)) as { _tag?: string; error?: { message?: string } };
    if (outer._tag !== 'Error' && !outer.error) return null;
    const message = outer.error?.message ?? '';
    const brace = message.indexOf('{');
    if (brace < 0) return message;
    const inner = JSON.parse(message.slice(brace)) as { message?: string };
    return inner.message ?? message;
  } catch {
    return null;
  }
}

/** The JSON a script hands back with RAISE EXCEPTION 'TEST_RESULT:<json>'. */
export function testResult<T>(output: string): T | null {
  const message = sqlError(output);
  if (!message) return null;
  const match = /TEST_RESULT:([[{][\s\S]*[\]}])\s*\nCONTEXT/.exec(message);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return null;
  }
}

/** Splits a script into its "-- @step name" parts, with {{KEY}} filled in. */
export function sqlSteps(text: string, values: Record<string, string>): Record<string, string> {
  const steps: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const step = /^-- @step (\w+)/.exec(line);
    if (step) {
      current = step[1];
      steps[current] = [];
      continue;
    }
    if (current) steps[current].push(line);
  }
  const fill = (s: string) => Object.entries(values).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v), s);
  return Object.fromEntries(Object.entries(steps).map(([k, lines]) => [k, fill(lines.join('\n'))]));
}
