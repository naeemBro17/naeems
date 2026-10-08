# How to restore a backup

> **Read this first.** Always restore into a **new, empty test Supabase project** first, never over the live shop.
> Restoring over the live database can wipe orders that came in after the backup. If the live shop really
> needs to be restored, get a developer to help you — and keep this page open for them.

## What is backed up

| What | How often | Where | Kept for |
|---|---|---|---|
| The whole database: orders, payments, customers, products, brands, settings, staff, logins | Every night ~03:00 (Bangladesh time) | Private GitHub repo **naeemBro17/naeems-backups**, folder `db` | Newest 30 nights + the first backup of each of the last 12 months |
| Every Storage file: product photos, banners, brand logos, videos | Every Sunday | Same repo, folder `storage/files` (list of all files: `storage/files.tsv`) | Always the latest copy |

Each database file is named by its date, e.g. `db/2026-10-07.dump.gpg`. It is **encrypted**: without the
backup password nobody can open it (not even GitHub). The password is the one you wrote on paper when the
backups were set up. **If the password is lost, the backups cannot be opened.**

Every night the job also proves the backup works: it unlocks it again and restores it into a temporary
database inside GitHub, then checks that every table has exactly the same number of rows. The latest result
is in `last-check.txt` in the backups repo. If anything fails you get a Telegram message
"Backup failed on <date> — check GitHub Actions". Every Sunday you get one quiet line "Backups OK — last 7 days saved."

To make a backup right now: GitHub → **naeemBro17/naeems** → **Actions** → **Nightly backup** → **Run workflow**.

## Step 1 — Install two free tools (one time, on a Windows PC)

1. **Gpg4win** (unlocks the file): download from <https://gpg4win.org> and install with the default options.
2. **PostgreSQL 17 command line tools**: download the Windows installer from
   <https://www.enterprisedb.com/downloads/postgres-postgresql-downloads> (version **17**). In the installer,
   tick **only "Command Line Tools"** (untick the server and the rest).

## Step 2 — Download the backup

1. Open <https://github.com/naeemBro17/naeems-backups> (you must be signed in — the repo is private).
2. Open the folder **db** and click the date you want (usually the newest).
3. Click the **download** button (arrow pointing down, top right of the file). Save it in a new folder, e.g. `C:\restore`.

## Step 3 — Unlock (decrypt) it

1. Open the Start menu, type **cmd**, open **Command Prompt**.
2. Type (change the date to your file's date) and press Enter:

   ```
   cd C:\restore
   gpg --output backup.dump --decrypt 2026-10-07.dump.gpg
   ```

3. A window asks for the password: type the backup password from your paper. You now have `backup.dump`.

## Step 4 — Make a new test Supabase project

1. <https://supabase.com/dashboard> → **New project** (the free plan is fine). Choose a database password and write it down.
2. When it is ready: click **Connect** (top of the project page) → **Session pooler** → copy the connection string.
   Replace `[YOUR-PASSWORD]` in it with that project's password. Below it is called `NEW_DB`.

## Step 5 — Put the data in

In the same Command Prompt, run these three commands one after the other. Replace `NEW_DB` with the full
connection string from Step 4, **inside the quotes**. Some lines may say "already exists" — that is normal.

1. Logins (customers and staff):

   ```
   "C:\Program Files\PostgreSQL\17\bin\pg_restore" --data-only --schema=auth --table=users --table=identities --file=logins.sql backup.dump
   "C:\Program Files\PostgreSQL\17\bin\psql" "NEW_DB" -c "SET session_replication_role = replica" -f logins.sql
   ```

2. The shop itself (all tables, rules and data):

   ```
   "C:\Program Files\PostgreSQL\17\bin\pg_restore" --dbname="NEW_DB" --no-owner --schema=public backup.dump
   ```

3. Check it worked: in the new project open **Table Editor** → `orders`, `products`, `order_payments` — your data should be there.

## Step 6 — Images and videos

1. In the backups repo open `storage/files`. Each folder is a Storage bucket (`product-images`, `brand-media`, …).
2. In the new project: **Storage** → create each bucket with the same name, set to **Public**.
3. Download the folders (GitHub: **Code** → **Download ZIP** on the backups repo) and drag each bucket's files into the bucket of the same name.

## Step 7 — Only with a developer: switch the live shop over

Switching the website to a restored project needs: the website's Supabase address and key changed in Vercel,
the Edge Functions deployed again (steadfast, notify-telegram-order, admin-team, steadfast-refresh-all,
backup-alert) with their secrets, the orders Database Webhook and the 3-hourly Steadfast job set up again
(`supabase/migration-026-steadfast-auto.sql`), and Google sign-in settings copied. **Do not do this alone.**

## If something goes wrong

- "bad passphrase" in Step 3 → wrong backup password.
- "server version mismatch" → you installed tools older than version 17; install version 17.
- "could not connect" → check the connection string and that `[YOUR-PASSWORD]` was replaced.

## Locked out of two-step login

Use this only if you lost **every** phone that has the Authenticator app
for Naeem's (and so cannot type the 6-digit code). Your password still
works; this removes the phones from your account so you can log in with the
password alone, then set up two-step login again.

You need your Supabase login (the one for supabase.com, not the shop's
admin login). It works from a phone browser too.

1. Open **supabase.com** and sign in. Open the shop's project.
2. Left menu: **Authentication** → **Users**.
3. Find your admin email in the list and tap/click it. A panel opens.
4. Look for **Remove MFA factors** (in the panel, near the bottom, or in
   its "..." menu). Click it and confirm. Done — go to step 7.
5. If that button is not there: left menu → **SQL Editor** → **New query**.
   Paste this, put your admin email between the quotes, and press **Run**:

       delete from auth.mfa_factors
       where user_id = (select id from auth.users where email = 'YOUR-ADMIN-EMAIL');

   It should say a number of rows was deleted (1 for each phone).
6. Nothing else is touched — no orders, products or settings.
7. Open the shop's admin login page and sign in with your email and
   password. No code is asked now.
8. Admin → Settings → Security → **Set up** again on your new phone, and
   add a second phone as a backup straight away.

If a staff member loses their phone, you can do the same for their login
(their email ends with @staff.naeems.internal in the Users list).
