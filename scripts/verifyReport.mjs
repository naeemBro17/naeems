// The short summaries `npm run verify` prints (Batch 30 Part 1), kept apart
// from the runner so e2e/batch-30.spec.ts can check them: one line when
// everything passed; only the failing tests (error + file:line) otherwise.

const ANSI = /\x1b\[[0-9;]*m/g;

export function firstLines(text, n) {
  return String(text ?? '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, n)
    .map((l) => `      ${l}`)
    .join('\n');
}

/** Vitest's JSON report → { ok, line, failures }. */
export function vitestSummary(report, seconds, exitCode = 0) {
  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const ok = exitCode === 0 && report.success === true;
  const failures = [];
  for (const file of report.testResults ?? []) {
    let fileFailures = 0;
    for (const t of file.assertionResults ?? []) {
      if (t.status !== 'failed') continue;
      fileFailures += 1;
      const where = t.location ? `${file.name}:${t.location.line}` : file.name;
      failures.push(`  FAIL ${t.fullName}\n      ${where}\n${firstLines((t.failureMessages ?? []).join('\n'), 8)}`);
    }
    if (fileFailures === 0 && file.status === 'failed') {
      failures.push(`  FAIL ${file.name}\n${firstLines(file.message ?? '', 8)}`);
    }
  }
  const time = seconds === null ? '' : ` (${seconds}s)`;
  return {
    ok,
    line: ok ? `vitest ${passed}/${total}${time}` : `vitest ${passed}/${total} — ${total - passed} failed${time}`,
    failures,
  };
}

/** Playwright JSON reports (one per group) → { ok, line, failures }. */
export function playwrightSummary(reports, seconds) {
  const counts = { passed: 0, skipped: 0, failed: 0, flaky: 0 };
  const failures = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === 'skipped') counts.skipped += 1;
        else if (test.status === 'expected') counts.passed += 1;
        else if (test.status === 'flaky') counts.flaky += 1;
        else {
          counts.failed += 1;
          const result = (test.results ?? []).find((r) => r.status !== 'passed' && r.status !== 'skipped') ?? {};
          const err = result.error ?? (result.errors ?? [])[0] ?? {};
          const loc = err.location ? `${err.location.file}:${err.location.line}` : `${spec.file}:${spec.line}`;
          failures.push(`  FAIL [${test.projectName}] ${spec.title}\n      ${loc}\n${firstLines(err.message ?? result.status ?? '', 10)}`);
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const report of reports) for (const suite of report.suites ?? []) walk(suite);
  const ok = counts.failed === 0 && counts.flaky === 0;
  const time = seconds === null ? '' : ` (${seconds}s)`;
  const base = `e2e ${counts.passed} passed, ${counts.skipped} skipped${counts.flaky ? `, ${counts.flaky} FLAKY` : ''}`;
  return { ok, line: ok ? `${base}${time}` : `${base}, ${counts.failed} FAILED${time}`, failures, counts };
}

/** What one verify run prints: one line, plus failures when there are any. */
export function runOutput(prefix, buildLine, vitest, e2e) {
  const lines = [`${prefix}${buildLine} · ${vitest.line} · ${e2e.line}`];
  if (!vitest.ok) lines.push(...vitest.failures);
  if (!e2e.ok) lines.push(...e2e.failures, '  Full logs + HTML report: .verify/');
  return lines.join('\n');
}
