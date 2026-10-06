// Batch 31 Part 1: which nightly database backups to keep.
//
// Backups are named YYYY-MM-DD.dump.gpg. We keep:
//   - the newest 30 daily files, and
//   - the first file of each of the 12 newest months that have a backup.
// Everything else is deleted. "Months that have a backup" (not "the last
// 12 calendar months") means a long gap in backups never wipes the old
// monthly copies: if the job ever stops for a while, nothing old is lost.
//
// Run: node scripts/backup/retention.mjs <folder>   → prints files to delete
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DAILY_TO_KEEP = 30;
export const MONTHLY_TO_KEEP = 12;
const NAME = /^(\d{4})-(\d{2})-(\d{2})\.dump\.gpg$/;

/** Backup file names only, oldest first. Anything else is ignored (never deleted). */
export function backupFiles(names) {
  return names.filter((n) => NAME.test(n)).sort();
}

/** The file names to delete, given every file name in the folder. */
export function filesToDelete(names) {
  const files = backupFiles(names);
  const keep = new Set(files.slice(-DAILY_TO_KEEP));
  const firstOfMonth = new Map();
  for (const f of files) {
    const month = f.slice(0, 7);
    if (!firstOfMonth.has(month)) firstOfMonth.set(month, f);
  }
  const months = [...firstOfMonth.keys()].sort().slice(-MONTHLY_TO_KEEP);
  for (const m of months) keep.add(firstOfMonth.get(m));
  return files.filter((f) => !keep.has(f));
}

/** How many of the 7 days ending on `today` (YYYY-MM-DD) have a backup. */
export function daysSavedInLastWeek(names, today) {
  const have = new Set(backupFiles(names).map((f) => f.slice(0, 10)));
  const end = new Date(`${today}T00:00:00Z`);
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    if (have.has(d)) count++;
  }
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, folder, today] = process.argv.slice(2);
  const names = readdirSync(folder);
  if (cmd === 'delete-list') {
    for (const f of filesToDelete(names)) console.log(f);
  } else if (cmd === 'week-count') {
    console.log(daysSavedInLastWeek(names, today));
  } else {
    console.error('usage: retention.mjs delete-list <folder> | week-count <folder> <YYYY-MM-DD>');
    process.exit(2);
  }
}
