-- ============================================================
-- Naeem's Price Hub — Migration 008: detail page, slugs, bento tiles
-- Run this in the Supabase SQL Editor after migration-007.
-- Safe to re-run.
--
-- Adds:
--   1. products.slug          — URL-friendly detail-page identifier (unique)
--   2. products.how_to_use    — accordion content
--   3. products.key_ingredients — accordion content
--   4. products.youtube_url   — Video Review accordion
--   5. bento_tiles            — admin-managed cards in the homepage bento carousel
--   6. products_view republished with all of the above
--
-- IMPORTANT: run this BEFORE deploying the matching app build. The admin
-- product form writes slug/how_to_use/key_ingredients/youtube_url on save.
-- ============================================================

-- ---------- 1. New product columns ----------
ALTER TABLE products ADD COLUMN IF NOT EXISTS slug            text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS how_to_use      text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS key_ingredients text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS youtube_url     text;

-- ---------- 2. Backfill slugs for existing rows ----------
-- Mirrors the client-side slugify(): lowercase, strip anything that isn't
-- alphanumeric/space/hyphen, collapse runs to a single hyphen, trim hyphens.
-- Collisions get -2, -3, ... in creation order, so the oldest product keeps
-- the clean slug and already-shared links stay meaningful.
DO $$
DECLARE
  r         record;
  base      text;
  candidate text;
  suffix    integer;
BEGIN
  FOR r IN SELECT id, name FROM products WHERE slug IS NULL ORDER BY created_at, id LOOP
    base := trim(BOTH '-' FROM
      regexp_replace(
        lower(regexp_replace(r.name, '[^a-zA-Z0-9[:space:]-]', '', 'g')),
        '[[:space:]-]+', '-', 'g'
      )
    );
    IF base = '' THEN
      base := 'product';
    END IF;

    candidate := base;
    suffix := 1;
    WHILE EXISTS (SELECT 1 FROM products WHERE slug = candidate) LOOP
      suffix := suffix + 1;
      candidate := base || '-' || suffix;
    END LOOP;

    UPDATE products SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS products_slug_key ON products (slug);

-- ---------- 3. products_view: republish with the new columns ----------
-- Recreated rather than CREATE OR REPLACE'd so the new columns can sit in a
-- readable order. Otherwise verbatim from migration-007: still the sole
-- sanctioned read path, still hiding wholesale_price from non-wholesalers.
DROP VIEW IF EXISTS products_view;

CREATE VIEW products_view AS
SELECT
  id, sku, slug, name, brand, category_id, retail_price, offer_price,
  stock_status, stock_quantity, note, description,
  how_to_use, key_ingredients, youtube_url,
  image_url, image_urls, is_active, is_featured, created_at, updated_at,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale
FROM products;

GRANT SELECT ON products_view TO anon, authenticated;

-- ---------- 4. bento_tiles ----------
-- Custom cards in the homepage bento carousel, beside the expert CTA.
CREATE TABLE IF NOT EXISTS bento_tiles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  subtitle   text,
  image_url  text,
  link_url   text NOT NULL,
  sort_order integer DEFAULT 0,
  is_active  boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bento_tiles_sort_order_idx ON bento_tiles (sort_order);

ALTER TABLE bento_tiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Read is granted to authenticated as well as anon: a signed-in wholesaler
  -- browses the same homepage as everyone else.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bento_tiles' AND policyname = 'bento_tiles_public_read'
  ) THEN
    CREATE POLICY "bento_tiles_public_read"
      ON bento_tiles FOR SELECT TO anon, authenticated
      USING (is_active = true);
  END IF;

  -- Management is limited to approved admins via the is_admin() helper from
  -- migration-004. A blanket `USING (true)` for authenticated would hand write
  -- access to every self-signed-up wholesaler, so it is deliberately not used.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bento_tiles' AND policyname = 'bento_tiles_admin_all'
  ) THEN
    CREATE POLICY "bento_tiles_admin_all"
      ON bento_tiles FOR ALL TO authenticated
      USING (is_admin())
      WITH CHECK (is_admin());
  END IF;
END $$;

-- Admins need to see inactive tiles in the management list, which the
-- public read policy filters out; bento_tiles_admin_all covers that.

-- Table privileges are granted explicitly. This project's default privileges
-- did not carry over to the reviews table (see migration-011), so nothing here
-- relies on them. RLS above still decides which rows each role can see.
GRANT SELECT ON bento_tiles TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON bento_tiles TO authenticated;
