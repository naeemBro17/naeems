# Naeem's Price Hub — Deployment Guide

Follow these steps in order. Total time: roughly 20 minutes.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in (create a free account if needed).
2. Click **New project**.
3. Choose a name (e.g. `naeem-price-hub`), set a strong database password, and pick the region closest to Bangladesh (**Southeast Asia — Singapore**).
4. Wait for the project to finish provisioning.

## 2. Run the SQL files

Open **SQL Editor** in the Supabase dashboard and run each file **in this order** (paste the contents, press **Run**):

1. `supabase/schema.sql` — creates the `categories` and `products` tables and indexes.
2. `supabase/rls.sql` — enables Row Level Security and adds the read/write policies.
3. `supabase/storage.sql` — creates the public `product-images` bucket and its policies.
4. `supabase/migration-002-multiple-images.sql` — adds the `image_urls` column.
5. `supabase/migration-003-group1.sql` — adds `description`, `offer_price`,
   `is_featured`, and the `app_settings` table (with seed rows).
6. `supabase/migration-004-wholesaler-auth.sql` — adds the `profiles` table +
   RLS, the `is_admin()` / `is_wholesaler_or_admin()` functions, the
   column-level REVOKE on `wholesale_price`, `products_view`, and tightens the
   admin write policies. **Security-critical — read the header comments.**
7. `supabase/seed.sql` — *(optional)* loads 4 categories and 12 realistic products.

After running `migration-003`, sign in as admin, open **Settings → Talk to an
Expert**, and fill in the real Messenger link, name, bio, and photo — the
seeded values are placeholders.

After running `migration-004`, complete its two manual steps:

1. **Bootstrap your admin profile** — without a `profiles` row, `is_admin()`
   returns false for your own account and locks you out of the admin panel.
   Run this once in the SQL Editor with your real login email:

   ```sql
   INSERT INTO profiles (id, role, status)
   SELECT id, 'admin', 'approved'
   FROM auth.users
   WHERE email = 'REPLACE_WITH_YOUR_ACTUAL_ADMIN_LOGIN_EMAIL'
   ON CONFLICT (id) DO UPDATE SET role = 'admin', status = 'approved';
   ```

2. **Turn OFF "Confirm email"** in **Authentication → Sign In / Up** if it is
   on. Wholesaler approval (done by you in Admin → Wholesalers) is the real
   gate; a separate email confirmation only adds SMTP setup burden. With
   confirmation off, sign-up creates the pending profile immediately.

Then work through the verification checklist in the Group 2 update notes
(log out → "Login to view"; sign up → "Awaiting approval"; approve → number
reveals; revoke → back to "Awaiting approval"; and confirm `wholesale_price`
is absent from the anonymous products response in the Network tab).

## 3. Verify the storage bucket

1. Open **Storage** in the dashboard.
2. Confirm the `product-images` bucket exists and is marked **Public**.
3. If it is missing, re-run `supabase/storage.sql`.

## 4. Create the admin user

1. Open **Authentication → Users** in the dashboard.
2. Click **Add user → Create new user**.
3. Enter the owner's email and a strong password (at least 8 characters).
4. Tick **Auto Confirm User** so no confirmation email is needed.

Also disable public signups so nobody else can register:

1. Open **Authentication → Sign In / Up**.
2. Turn **off** "Allow new users to sign up".

## 5. Configure environment variables locally

1. In the project folder, copy the example file:

   ```bash
   cp .env.example .env
   ```

2. Open **Project Settings → API** in the Supabase dashboard and copy:
   - **Project URL** → `VITE_SUPABASE_URL`
   - **anon / public key** → `VITE_SUPABASE_ANON_KEY`

3. Test locally:

   ```bash
   npm install
   npm run dev
   ```

   Open the printed URL — you should see the seeded products.

## 6. Deploy to Vercel

1. Push the project to a GitHub repository.
2. Go to [vercel.com](https://vercel.com), sign in, and click **Add New → Project**.
3. Import the GitHub repository. Vercel auto-detects Vite — keep the defaults
   (build command `npm run build`, output directory `dist`).
4. Under **Environment Variables**, add:
   - `VITE_SUPABASE_URL` = your project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon key
5. Click **Deploy** and wait for the build to finish.

`vercel.json` already contains the SPA rewrite (all paths → `index.html`),
so `/admin` works on direct visits and refreshes.

## 7. First login

1. Open the deployed URL — the public price list loads with no login.
2. Tap the **lock icon** in the top-right corner.
3. Sign in with the admin email and password from step 4.
4. You land on `/admin` — add products, categories, or import your Excel
   data via **Import/Export** (download the CSV template, fill it from
   Excel, and upload it).

## 8. Install as an app (optional, recommended for staff)

- **Android/Chrome:** open the URL → browser menu → **Add to Home screen**.
- **iPhone/Safari:** open the URL → Share → **Add to Home Screen**.

The app works offline after the first visit: it shows the last loaded
prices with an offline banner until connectivity returns.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Couldn't load products" on first load | Check both env vars in Vercel, then redeploy. |
| Login fails with correct password | Confirm the user exists in **Authentication → Users** and is confirmed. |
| Images fail to upload | Re-run `supabase/storage.sql`; confirm the bucket is public. |
| `/admin` 404s on refresh | Confirm `vercel.json` is present in the repo root. |
