# NAEEM'S — database backups (PRIVATE)

This repository must stay **private**. The nightly job refuses to save here if it ever becomes public.

- `db/YYYY-MM-DD.dump.gpg` — the whole shop database (orders, payments, customers, products, logins), one per night at about 03:00 Bangladesh time. Encrypted: it cannot be opened without the backup password.
- Kept: the newest 30 nights, plus the first backup of each of the last 12 months. Older ones are deleted automatically.
- `last-check.txt` — the result of the last night's restore test (every table and its row count).
- `storage/files/` — a copy of every image, logo and video in Supabase Storage, refreshed every Sunday. `storage/files.tsv` lists every file with its size and date.

How to restore: see `docs/RESTORE.md` in the shop's main repository (naeemBro17/naeems).

Made by `.github/workflows/backup.yml` in the main repository. This repo only ever has one commit: each night replaces it, so deleted backups really disappear.
