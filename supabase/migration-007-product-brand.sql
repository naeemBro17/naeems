-- ============================================================
-- Naeem's Price Hub — Migration 007: product brand
-- Run this in the Supabase SQL Editor after migration-006.
-- Safe to re-run.
--
-- Adds products.brand, a free-text manufacturer/brand name (e.g. "CeraVe",
-- "The Ordinary"). Before this column existed the product card printed the
-- category name on its brand line, which duplicated the category badge.
-- The line now stays empty until a real brand is entered.
--
-- IMPORTANT: run this BEFORE deploying the matching app build. The admin
-- product form writes `brand` on every save, so saving a product against a
-- database without this column fails.
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand text;

-- ---------- products_view: republish with brand ----------
-- Recreated rather than CREATE OR REPLACE'd so brand can sit next to name
-- instead of being appended last (REPLACE cannot reorder columns).
-- Everything else is verbatim from migration-004 Part 4: still the sole
-- sanctioned read path, still hiding wholesale_price from non-wholesalers.
DROP VIEW IF EXISTS products_view;

CREATE VIEW products_view AS
SELECT
  id, sku, name, brand, category_id, retail_price, offer_price,
  stock_status, stock_quantity, note, description,
  image_url, image_urls, is_active, is_featured, created_at, updated_at,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale
FROM products;

GRANT SELECT ON products_view TO anon, authenticated;
