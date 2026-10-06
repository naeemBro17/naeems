import { describe, expect, it } from 'vitest';
import { backupFiles, daysSavedInLastWeek, filesToDelete } from './retention.mjs';

function day(d) {
  return `${new Date(d).toISOString().slice(0, 10)}.dump.gpg`;
}
function dailyFiles(from, count) {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  return Array.from({ length: count }, (_, i) => day(start + i * 86_400_000));
}

describe('backup retention', () => {
  it('keeps everything while there are 30 or fewer files', () => {
    expect(filesToDelete(dailyFiles('2026-10-01', 30))).toEqual([]);
  });

  it('keeps the newest 30 days plus the first of each month', () => {
    const files = dailyFiles('2026-01-01', 400);
    const del = filesToDelete(files);
    const kept = files.filter((f) => !del.includes(f));
    // newest 30 kept
    for (const f of files.slice(-30)) expect(kept).toContain(f);
    // exactly 12 monthly copies among the older files, each the 1st of a month
    const olderKept = kept.filter((f) => !files.slice(-30).includes(f));
    expect(olderKept.every((f) => f.slice(8, 10) === '01')).toBe(true);
    const months = new Set(kept.map((f) => f.slice(0, 7)));
    expect(months.size).toBeGreaterThanOrEqual(12);
    expect(kept.length).toBeLessThanOrEqual(30 + 12);
    // the very first months (more than 12 months back) are gone
    expect(kept).not.toContain('2026-01-01.dump.gpg');
  });

  it('a long gap never deletes the old monthly copies', () => {
    const old = dailyFiles('2026-01-01', 60);
    const recent = dailyFiles('2027-06-01', 40);
    const del = filesToDelete([...old, ...recent]);
    expect(del).not.toContain('2026-01-01.dump.gpg');
    expect(del).not.toContain('2026-02-01.dump.gpg');
  });

  it('never touches other files', () => {
    expect(backupFiles(['README.md', 'check.txt', '2026-10-07.dump.gpg'])).toEqual(['2026-10-07.dump.gpg']);
    expect(filesToDelete(['README.md', ...dailyFiles('2026-01-01', 100)])).not.toContain('README.md');
  });

  it('counts the days saved in the last week', () => {
    expect(daysSavedInLastWeek(dailyFiles('2026-10-01', 7), '2026-10-07')).toBe(7);
    const missing = dailyFiles('2026-10-01', 7).filter((f) => !f.startsWith('2026-10-03'));
    expect(daysSavedInLastWeek(missing, '2026-10-07')).toBe(6);
  });
});
