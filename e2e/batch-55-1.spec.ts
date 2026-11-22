import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL } from './helpers/env';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 55.1: the safe pack-size conversion and the pack-size guard. No
// browser: the guard migration, the one-time fix's helper functions and
// made-up products, a lot, orders and a loose sale all run in
// e2e/sql/batch-55-1.sql inside ONE transaction that is always rolled back.
// The real products are never touched.

test.skip(!E2E_ADMIN_EMAIL, 'Needs the test admin account in .env.e2e.');

/** The SQL between a file's own BEGIN; and COMMIT;. */
function body(path: string): string {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  return text.slice(text.indexOf('\nBEGIN;\n') + 8, text.lastIndexOf('\nCOMMIT;'));
}

test('database: pack-size guard, and the conversion keeps every stock and money total (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const migration = body('supabase/migration-057-batch55-1.sql');
  const fix = readFileSync('supabase/fix-batch55-1-pack-sizes.sql', 'utf8').replace(/\r\n/g, '\n');
  const helpers = fix.slice(fix.indexOf('-- ==== helpers start ===='), fix.indexOf('-- ==== helpers end ===='));
  expect(helpers, 'the fix file marks its helper functions').toContain('pg_temp.b551_convert');
  const tests = readFileSync('e2e/sql/batch-55-1.sql', 'utf8').replace(/\r\n/g, '\n').replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL);
  const output = await runSql(`BEGIN;\n${migration}\n${helpers}\n${tests}\nROLLBACK;\n`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(20);
});
