-- ============================================================
-- Naeem's Price Hub — Migration 006: Reviews + expert profile settings
-- Run this in the Supabase SQL Editor after the earlier migrations.
-- Safe to re-run (guards on every statement).
--
-- Adds:
--   1. The reviews table behind the /contact page's Client Reviews section,
--      with RLS: anyone reads approved+visible rows, anyone may submit an
--      unapproved row, authenticated admins manage everything.
--   2. The app_settings rows the rebuilt expert profile page reads.
-- ============================================================

-- ---------- 1. Reviews ----------
CREATE TABLE IF NOT EXISTS reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  country      text,
  -- ISO 3166-1 alpha-2, lowercase, e.g. 'bd', 'au' — drives the flag icon.
  country_code text,
  star_rating  integer CHECK (star_rating BETWEEN 1 AND 5),
  quote        text NOT NULL,
  photo_url    text,
  sort_order   integer DEFAULT 0,
  is_approved  boolean DEFAULT false,
  is_visible   boolean DEFAULT true,
  submitted_by text,
  created_at   timestamptz DEFAULT now()
);

-- Reviews render in sort_order; admins reorder by drag.
CREATE INDEX IF NOT EXISTS reviews_sort_order_idx ON reviews (sort_order);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'reviews' AND policyname = 'reviews_public_read'
  ) THEN
    CREATE POLICY "reviews_public_read"
      ON reviews FOR SELECT TO anon, authenticated
      USING (is_approved = true AND is_visible = true);
  END IF;

  -- A public submission may only ever create an unapproved row, so nothing
  -- reaches the page without an admin approving it first.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'reviews' AND policyname = 'reviews_public_submit'
  ) THEN
    CREATE POLICY "reviews_public_submit"
      ON reviews FOR INSERT TO anon, authenticated
      WITH CHECK (is_approved = false);
  END IF;

  -- Full management is limited to approved admins. is_admin() is the
  -- SECURITY DEFINER helper from migration 004 — querying profiles directly
  -- from a policy would recurse through that table's own RLS.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'reviews' AND policyname = 'reviews_admin_all'
  ) THEN
    CREATE POLICY "reviews_admin_all"
      ON reviews FOR ALL TO authenticated
      USING (is_admin())
      WITH CHECK (is_admin());
  END IF;
END $$;

-- ---------- 2. Seed reviews ----------
INSERT INTO reviews (name, country, country_code, star_rating, quote, sort_order, is_approved, submitted_by)
SELECT * FROM (VALUES
  ('Fatima Rahman', 'Dhaka, Bangladesh', 'bd', 5, 'Naeem recommended exactly what my skin needed. My acne cleared up within 3 weeks!', 1, true, 'admin'),
  ('Sara Ahmed', 'Perth, Australia', 'au', 5, 'Authentic products, fast delivery. Highly recommend.', 2, true, 'admin'),
  ('Rahim Chowdhury', 'Chattogram, Bangladesh', 'bd', 5, 'Best skincare advice I have gotten. The CeraVe set changed my skin completely.', 3, true, 'admin')
) AS seed(name, country, country_code, star_rating, quote, sort_order, is_approved, submitted_by)
WHERE NOT EXISTS (SELECT 1 FROM reviews);

-- ---------- 3. Expert profile settings ----------
INSERT INTO app_settings (key, value) VALUES
  ('expert_location', 'Dhaka, Bangladesh'),
  ('expert_title', 'Skincare Expert & Consultant'),
  ('expert_reply_time', 'Typically replies within a few hours'),
  ('expert_whatsapp_url', ''),
  ('expert_instagram_url', ''),
  ('expert_instagram_handle', ''),
  ('expert_facebook_url', ''),
  ('expert_threads_url', ''),
  ('expert_threads_handle', ''),
  ('expert_youtube_url', ''),
  ('expert_appointment_url', ''),
  ('expert_stat_1_value', '500+'),
  ('expert_stat_1_label', 'Happy Clients'),
  ('expert_stat_2_value', '5+'),
  ('expert_stat_2_label', 'Rating'),
  ('expert_stat_3_value', '3yr'),
  ('expert_stat_3_label', 'Expertise')
ON CONFLICT (key) DO NOTHING;
