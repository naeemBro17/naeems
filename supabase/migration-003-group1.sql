-- ============================================================
-- Naeem's Price Hub — Migration 003: Group 1 (Quick Wins)
-- Run this in the Supabase SQL Editor after the earlier migrations.
-- Safe to re-run (guards on every statement).
--
-- Bundles the schema changes for:
--   Fix 2 — products.description (long free-text)
--   Fix 3 — products.offer_price (optional discount tier)
--   Fix 4 — products.is_featured (homepage first-impression flag)
--   Fix 5 — app_settings table (Talk to an Expert contact settings)
-- ============================================================

-- ---------- Fix 2: product description ----------
-- Longer free-text than `note`; no length CHECK — keep it flexible.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS description text;

-- ---------- Fix 3: regular + offer price ----------
-- retail_price stays "regular price"; offer_price is the optional lower tier.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS offer_price numeric(10,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'offer_price_below_retail'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT offer_price_below_retail
      CHECK (offer_price IS NULL OR offer_price < retail_price);
  END IF;
END $$;

-- ---------- Fix 4: featured flag ----------
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_featured ON products(is_featured);

-- ---------- Fix 5: app_settings key/value store ----------
CREATE TABLE IF NOT EXISTS app_settings (
  key   text PRIMARY KEY,
  value text
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'app_settings' AND policyname = 'app_settings_public_read'
  ) THEN
    CREATE POLICY "app_settings_public_read"
      ON app_settings FOR SELECT TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'app_settings' AND policyname = 'app_settings_admin_write'
  ) THEN
    CREATE POLICY "app_settings_admin_write"
      ON app_settings FOR ALL TO authenticated
      USING (auth.role() = 'authenticated')
      WITH CHECK (auth.role() = 'authenticated');
  END IF;
END $$;

-- Seed the four contact/expert settings. Placeholders — fill in real values
-- from Admin → Settings after running this migration.
INSERT INTO app_settings (key, value) VALUES
  ('messenger_link', 'https://m.me/REPLACE_WITH_PAGE_USERNAME'),
  ('expert_name', 'Naeem'),
  ('expert_bio', 'Write a short intro here — who you are, what you can help with, and (optional, only if true) a realistic response time expectation, e.g. "Usually replies within a few hours."'),
  ('expert_photo_url', '')
ON CONFLICT (key) DO NOTHING;
