#!/usr/bin/env bash
# Batch 31 Part 1: nightly database backup. Run by .github/workflows/backup.yml.
#
#   1. pg_dump the live database (schemas public, auth, storage) — custom format
#   2. encrypt it with BACKUP_PASSWORD (gpg, AES-256)
#   3. verify: decrypt again, same bytes, pg_restore --list has the main tables
#   4. restore it into the throw-away Postgres of the job and compare every
#      table's row count with the dump (never the live database)
#   5. (Sundays, or when asked) copy every Storage file
#   6. save into the PRIVATE repo naeemBro17/naeems-backups, apply retention
#
# The main repo is public, so its Action logs are public: this script prints
# only pass/fail lines and table NAMES. Row counts go to last-check.txt in
# the private backups repo. Secrets come only from environment variables
# (GitHub secrets) and are never echoed.
set -euo pipefail

: "${SUPABASE_DB_URL:?SUPABASE_DB_URL secret is not set}"
: "${BACKUP_PASSWORD:?BACKUP_PASSWORD secret is not set}"
: "${BACKUP_DEPLOY_KEY:?BACKUP_DEPLOY_KEY secret is not set}"
: "${RESTORE_DB_URL:?RESTORE_DB_URL is not set}"
BACKUP_REPO="${BACKUP_REPO:-naeemBro17/naeems-backups}"
SUPABASE_URL="${SUPABASE_URL:?SUPABASE_URL is not set}"
WITH_STORAGE="${WITH_STORAGE:-auto}"
STORAGE_LIMIT_BYTES="${STORAGE_LIMIT_BYTES:-300000000}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATE="$(TZ=Asia/Dhaka date +%F)"
WEEKDAY="$(TZ=Asia/Dhaka date +%u)" # 7 = Sunday
umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
step() { echo "::group::$1"; }
done_step() { echo "::endgroup::"; }

# Auth tables holding live sessions / one-time tokens: their data is left
# out (useless after a restore and sensitive). Their structure is kept.
NO_DATA=(auth.sessions auth.refresh_tokens auth.flow_state auth.one_time_tokens
  auth.mfa_challenges auth.audit_log_entries auth.mfa_amr_claims)
REQUIRED=(public.orders public.order_items public.order_payments public.products
  public.product_variants public.profiles public.brands public.categories
  public.staff_members auth.users storage.objects)

# ---------------------------------------------------------------- 0. safety
step "Safety checks"
# A backups repo that anyone can see must never receive customer data.
code="$(curl -s -o /dev/null -w '%{http_code}' "https://api.github.com/repos/$BACKUP_REPO")"
if [ "$code" = "200" ]; then
  echo "::error::$BACKUP_REPO is PUBLIC. Refusing to save backups there. Make it private."
  exit 1
fi
server_major="$(psql "$SUPABASE_DB_URL" -XAtc 'show server_version_num' | cut -c1-2)"
dump_major="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
if [ "$server_major" != "$dump_major" ]; then
  echo "::error::pg_dump $dump_major does not match the database (Postgres $server_major)."
  exit 1
fi
echo "Postgres $server_major, pg_dump $dump_major, backups repo is not public. OK"
done_step

# ------------------------------------------------------------------ 1. dump
step "1. Dump the database"
exclude=()
for t in "${NO_DATA[@]}"; do exclude+=(--exclude-table-data="$t"); done
pg_dump --dbname="$SUPABASE_DB_URL" --format=custom --compress=9 \
  --schema=public --schema=auth --schema=storage "${exclude[@]}" \
  --file="$WORK/db.dump"
echo "Dump OK ($(du -h "$WORK/db.dump" | cut -f1))"
done_step

# --------------------------------------------------------------- 2. encrypt
step "2. Encrypt"
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
  --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 \
  --output "$WORK/db.dump.gpg" "$WORK/db.dump" 3<<<"$BACKUP_PASSWORD"
echo "Encrypted OK"
done_step

# ---------------------------------------------------------------- 3. verify
step "3. Verify the encrypted file"
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
  --decrypt --output "$WORK/check.dump" "$WORK/db.dump.gpg" 3<<<"$BACKUP_PASSWORD"
cmp -s "$WORK/db.dump" "$WORK/check.dump" || { echo "::error::Decrypted file differs from the dump."; exit 1; }
pg_restore --list "$WORK/check.dump" >"$WORK/toc.txt"
for t in "${REQUIRED[@]}"; do
  schema="${t%%.*}"; table="${t#*.}"
  if ! grep -qE "TABLE DATA ${schema} ${table} " "$WORK/toc.txt"; then
    echo "::error::The backup has no data for $t."
    exit 1
  fi
done
echo "Decrypts to the same file; all ${#REQUIRED[@]} main tables present. OK"
done_step

# --------------------------------------------------------- 4. restore test
step "4. Restore test (throw-away database inside this job)"
psql "$RESTORE_DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$HERE/restore-test-prepare.sql" >/dev/null
set +e
pg_restore --dbname="$RESTORE_DB_URL" --no-owner --no-acl "$WORK/check.dump" 2>"$WORK/restore-errors.txt"
set -e
restore_errors="$(grep -c '^pg_restore: error' "$WORK/restore-errors.txt" || true)"
# Rows per table inside the dump (COPY blocks: one line per row).
pg_restore --data-only --file=- "$WORK/check.dump" | awk '
  /^COPY / { t = $2; gsub(/"/, "", t); n[t] += 0; c = 1; next }
  /^\\\.$/ { c = 0; next }
  c { n[t]++ }
  END { for (t in n) print t, n[t] }' | sort >"$WORK/expected.txt"
mismatch=0
: >"$WORK/counts.txt"
while read -r table expected; do
  actual="$(psql "$RESTORE_DB_URL" -XAtc "select count(*) from $table" 2>/dev/null || echo missing)"
  printf '%-45s dump %-8s restored %s\n' "$table" "$expected" "$actual" >>"$WORK/counts.txt"
  if [ "$actual" != "$expected" ]; then
    echo "::error::Restore test: $table does not match the backup."
    mismatch=1
  fi
done <"$WORK/expected.txt"
for t in "${REQUIRED[@]}"; do
  grep -q "^$t " "$WORK/expected.txt" || { echo "::error::Restore test: $t missing."; mismatch=1; }
done
products="$(psql "$RESTORE_DB_URL" -XAtc 'select count(*) from public.products')"
[ "$products" -gt 0 ] || { echo "::error::Restore test: no products in the backup."; mismatch=1; }
[ "$mismatch" = 0 ] || exit 1
tables_checked="$(wc -l <"$WORK/expected.txt" | tr -d ' ')"
echo "Restore test OK: all $tables_checked tables have exactly the rows of the backup."
echo "(Supabase-only pieces that plain Postgres lacks: $restore_errors skipped, see last-check.txt)"
done_step

# -------------------------------------------------------- 5. backups repo
step "5. Save into the private backups repo"
mkdir -p "$WORK/ssh"
printf '%s\n' "$BACKUP_DEPLOY_KEY" >"$WORK/ssh/key"
chmod 600 "$WORK/ssh/key"
export GIT_SSH_COMMAND="ssh -i $WORK/ssh/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$WORK/ssh/known_hosts"
git clone --quiet --depth 1 "git@github.com:$BACKUP_REPO.git" "$WORK/repo" 2>&1 | grep -v 'empty repository' || true
[ -d "$WORK/repo/.git" ] || { echo "::error::Could not open $BACKUP_REPO."; exit 1; }
cd "$WORK/repo"
mkdir -p db
cp "$WORK/db.dump.gpg" "db/$DATE.dump.gpg"
deleted=0
while read -r old; do
  [ -n "$old" ] || continue
  rm -f "db/$old"
  deleted=$((deleted + 1))
done < <(node "$HERE/retention.mjs" delete-list db)
kept="$(find db -name '*.dump.gpg' | wc -l | tr -d ' ')"
echo "Saved db/$DATE.dump.gpg; $kept backups kept, $deleted old ones removed."

# Storage files: Sundays (Bangladesh time) or when asked from "Run workflow".
if [ "$WITH_STORAGE" = "yes" ] || { [ "$WITH_STORAGE" = "auto" ] && [ "$WEEKDAY" = "7" ]; }; then
  psql "$SUPABASE_DB_URL" -XAt -F $'\t' -c \
    "select o.bucket_id, o.name, coalesce(o.metadata->>'size','0'), o.updated_at, b.public
       from storage.objects o join storage.buckets b on b.id = o.bucket_id
      where o.name not like '%/.emptyFolderPlaceholder' order by 1, 2" >"$WORK/storage.tsv"
  node "$HERE/storage.mjs" "$WORK/storage.tsv" storage "$SUPABASE_URL" "$STORAGE_LIMIT_BYTES"
fi

{
  echo "Last backup: $DATE (Bangladesh date)"
  echo "File: db/$DATE.dump.gpg"
  echo "Restore test: PASSED - every table has exactly the rows of the backup."
  echo "Supabase-only pieces plain Postgres could not create (expected, harmless): $restore_errors"
  echo
  cat "$WORK/counts.txt"
  echo
  echo "Skipped pieces (first 40):"
  grep '^pg_restore: error' "$WORK/restore-errors.txt" | head -40 || true
} >last-check.txt
cp "$HERE/backups-repo-README.md" README.md

git config user.name "NAEEM'S backup"
git config user.email "backup@users.noreply.github.com"
# One fresh commit every night (old commits are dropped), so deleted
# backups really leave the repo and it never grows past what is kept.
git checkout --quiet --orphan nightly
git add -A
git commit --quiet -m "Backup $DATE"
git push --quiet --force origin nightly:main
echo "Pushed to $BACKUP_REPO."
done_step

# --------------------------------------------------- 6. weekly OK message
if [ "$WEEKDAY" = "7" ]; then
  saved="$(node "$HERE/retention.mjs" week-count db "$DATE")"
  echo "WEEK_SAVED=$saved" >>"${GITHUB_OUTPUT:-/dev/null}"
fi
echo "BACKUP_OK=1" >>"${GITHUB_OUTPUT:-/dev/null}"
