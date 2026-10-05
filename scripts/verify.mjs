// npm run verify   — build + unit tests (vitest) + browser tests (Playwright),
//                    printing ONE short summary line when everything passes.
// npm run verify:3 — the same three times in a row (build once).
//
// Batch 30 Part 1: full test logs are long, and reading them again and
// again used most of a session's budget. Everything is still run (nothing
// skipped or weakened); the full output goes to .verify/*.log and only
// failures are printed: the test, its error and file:line (the wording is
// in scripts/verifyReport.mjs). Browser tests run in two groups (see
// playwright.config.ts): "parallel" first, then "serial" (one at a time,
// alone). The HTML report is kept only when something failed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstLines, playwrightSummary, runOutput, vitestSummary } from './verifyReport.mjs';

const OUT = '.verify';
const runsArg = process.argv.find((a) => a.startsWith('--runs='));
const RUNS = runsArg ? Math.max(1, Number(runsArg.split('=')[1]) || 1) : 1;

function run(commandLine, logFile, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(commandLine, { shell: true, env: { ...process.env, ...env, FORCE_COLOR: '0' } });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      writeFileSync(logFile, output);
      resolve({ code: code ?? 1, output, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

async function build() {
  const res = await run('npm run build', join(OUT, 'build.log'));
  if (res.code === 0) return { ok: true, line: `build OK (${res.seconds}s)` };
  const lines = res.output.split(/\r?\n/);
  const errors = lines.filter((l) => /error/i.test(l)).slice(0, 30);
  return { ok: false, line: `build FAILED (${res.seconds}s)\n${firstLines((errors.length ? errors : lines.slice(-30)).join('\n'), 30)}` };
}

async function vitest(round) {
  const jsonFile = join(OUT, `vitest-${round}.json`);
  rmSync(jsonFile, { force: true });
  const res = await run(`npx vitest run --reporter=json --outputFile=${jsonFile}`, join(OUT, `vitest-${round}.log`));
  if (!existsSync(jsonFile)) {
    return { ok: false, line: `vitest did not finish (${res.seconds}s)`, failures: [firstLines(res.output.split(/\r?\n/).slice(-30).join('\n'), 30)] };
  }
  return vitestSummary(JSON.parse(readFileSync(jsonFile, 'utf8')), res.seconds, res.code);
}

async function playwright(round) {
  const reports = [];
  const extraFailures = [];
  let seconds = 0;
  let exitOk = true;
  for (const project of ['parallel', 'serial']) {
    const jsonFile = join(OUT, `e2e-${project}-${round}.json`);
    const htmlDir = join(OUT, `e2e-${project}-${round}-html`);
    rmSync(jsonFile, { force: true });
    rmSync(htmlDir, { recursive: true, force: true });
    const res = await run(`npx playwright test --project=${project} --no-deps --reporter=dot,json,html`, join(OUT, `e2e-${project}-${round}.log`), {
      PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile,
      PLAYWRIGHT_HTML_OUTPUT_DIR: htmlDir,
      PLAYWRIGHT_HTML_OPEN: 'never',
    });
    seconds += res.seconds;
    if (!existsSync(jsonFile)) {
      exitOk = false;
      extraFailures.push(`  [${project}] Playwright did not finish\n${firstLines(res.output.split(/\r?\n/).slice(-20).join('\n'), 20)}`);
      continue;
    }
    const report = JSON.parse(readFileSync(jsonFile, 'utf8'));
    reports.push(report);
    const alone = playwrightSummary([report], null);
    if (res.code === 0 && alone.ok) rmSync(htmlDir, { recursive: true, force: true });
    else exitOk = exitOk && alone.ok;
  }
  const summary = playwrightSummary(reports, seconds);
  return { ...summary, ok: summary.ok && exitOk, failures: [...summary.failures, ...extraFailures] };
}

mkdirSync(OUT, { recursive: true });
const started = Date.now();
const b = await build();
if (!b.ok) {
  console.log(b.line);
  process.exit(1);
}
let allOk = true;
for (let round = 1; round <= RUNS; round += 1) {
  const v = await vitest(round);
  const e = await playwright(round);
  console.log(runOutput(RUNS > 1 ? `run ${round}/${RUNS}: ` : '', b.line, v, e));
  allOk = allOk && v.ok && e.ok;
}
const minutes = ((Date.now() - started) / 60000).toFixed(1);
console.log(allOk ? `ALL GREEN (${minutes} min)` : `FAILED (${minutes} min)`);
process.exit(allOk ? 0 : 1);
