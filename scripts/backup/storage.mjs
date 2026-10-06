// Batch 31 Part 1: weekly copy of every Supabase Storage file (product
// images, banners, brand logos and videos) into the private backups repo.
//
// node storage.mjs <list.tsv> <folder> <supabase url> <limit bytes>
//   list.tsv: bucket, name, size, updated_at, public  (from storage.objects)
//
// Always writes <folder>/files.tsv (path, size, date) so a missing file can
// be noticed. Copies the files themselves only while the total stays under
// the limit (GitHub's free repos are comfortable up to ~1 GB); above it,
// only the list is kept and the copies are removed. Files that did not
// change are not downloaded again. Only public buckets can be downloaded
// without a key; a private bucket's files are listed but not copied.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [listFile, folder, supabaseUrl, limitArg] = process.argv.slice(2);
const limit = Number(limitArg);
const rows = readFileSync(listFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [bucket, name, size, updated, isPublic] = line.split('\t');
    return { bucket, name, size: Number(size) || 0, updated, isPublic: isPublic === 't' };
  });

const total = rows.reduce((s, r) => s + r.size, 0);
const filesDir = join(folder, 'files');
mkdirSync(folder, { recursive: true });
writeFileSync(
  join(folder, 'files.tsv'),
  ['path\tsize_bytes\tupdated_at', ...rows.map((r) => `${r.bucket}/${r.name}\t${r.size}\t${r.updated}`)].join('\n') + '\n'
);

function listLocal(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((p) => join(dir, String(p)))
    .filter((p) => statSync(p).isFile());
}

const mb = (n) => `${(n / 1_000_000).toFixed(1)} MB`;
if (total > limit) {
  rmSync(filesDir, { recursive: true, force: true });
  writeFileSync(join(folder, 'mode.txt'), `list only: ${rows.length} files, ${mb(total)} is over the ${mb(limit)} limit\n`);
  console.log(`Storage: ${rows.length} files, ${mb(total)} - over the limit, saved the list only.`);
  process.exit(0);
}

const wanted = new Set();
let downloaded = 0;
let listedOnly = 0;
for (const r of rows) {
  const target = join(filesDir, r.bucket, ...r.name.split('/'));
  if (!r.isPublic) {
    listedOnly++;
    continue;
  }
  wanted.add(target);
  if (existsSync(target) && statSync(target).size === r.size) continue;
  const url = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(r.bucket)}/${r.name
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Storage download failed (${res.status}) for ${r.bucket}/${r.name}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  downloaded++;
}
let removed = 0;
for (const p of listLocal(filesDir)) {
  if (!wanted.has(p)) {
    rmSync(p);
    removed++;
  }
}
writeFileSync(
  join(folder, 'mode.txt'),
  `full copy: ${rows.length} files, ${mb(total)}${listedOnly ? ` (${listedOnly} in private buckets: listed only)` : ''}\n`
);
console.log(
  `Storage: ${rows.length} files, ${mb(total)} - full copy (${downloaded} new or changed, ${removed} removed${
    listedOnly ? `, ${listedOnly} private listed only` : ''
  }).`
);
