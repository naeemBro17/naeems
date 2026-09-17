-- ============================================================
-- Naeem's Price Hub — Migration 015: category images
-- Run this in the Supabase SQL Editor. Safe to re-run.
--
-- Adds an optional photo per category, shown in the homepage "Browse"
-- circle instead of the curated/generic icon. No column-lock or view
-- needed: categories has always been a plain SELECT * table (see rls.sql's
-- "categories_public_read" policy, USING (true)) — a new column is visible
-- to anon/authenticated the moment it exists, same as name/slug already are.
--
-- Storage: the image itself is uploaded to the existing product-images
-- bucket (see storage.sql) at categories/{category id}.webp, reusing that
-- bucket's existing policies exactly as the admin settings photo and now
-- the banner slide image already do — no new bucket or storage policy is
-- needed for this migration.
-- ============================================================

ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url text;

-- ---------- Verify ----------
-- As the anon key, this must now return image_url (null until an admin
-- uploads one) alongside the columns already readable:
--   GET /rest/v1/categories?select=id,name,image_url&limit=1
