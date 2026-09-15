-- ============================================================
-- Naeem's Price Hub — Migration 012: skin type / skin condition tags
-- Run this in the Supabase SQL Editor AFTER migration-008 (it republishes
-- products_view with 008's columns) and after 009 if you have run it.
-- Safe to re-run.
--
-- Adds two optional text[] columns, admin-only for now, that a future smart
-- filter will read. They are never shown on the card or detail page.
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS skin_types      text[] DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS skin_conditions text[] DEFAULT '{}';

-- ---------- products_view: republish with the new columns ----------
-- Verbatim from migration-008 plus the two tags; still the sole sanctioned
-- read path, still hiding wholesale_price from non-wholesalers.
DROP VIEW IF EXISTS products_view;

CREATE VIEW products_view AS
SELECT
  id, sku, slug, name, brand, category_id, retail_price, offer_price,
  stock_status, stock_quantity, note, description,
  how_to_use, key_ingredients, youtube_url,
  skin_types, skin_conditions,
  image_url, image_urls, is_active, is_featured, created_at, updated_at,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale
FROM products;

GRANT SELECT ON products_view TO anon, authenticated;

-- ---------- Column grants ----------
-- migration-009 replaced the table-wide SELECT with per-column grants, so a
-- new column is unreadable until granted. Re-running 009's grant block here
-- keeps this migration correct whether or not 009 has been applied yet.
DO $$
DECLARE
  column_list text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
  INTO column_list
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'products'
    AND column_name <> 'wholesale_price';

  EXECUTE format('GRANT SELECT (%s) ON products TO anon, authenticated', column_list);
END $$;
