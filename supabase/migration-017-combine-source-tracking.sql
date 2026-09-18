-- ============================================================
-- Naeem's Price Hub — Migration 017: track which original product a
-- "Combine into Variants" row came from
-- Run this in the Supabase SQL Editor after migration-016. Safe to re-run.
--
-- Part 7 of the previous batch (combine existing products into one product
-- with variants) deactivates the original products but never recorded which
-- original a variant — or a combined product's own base data — came from.
-- That means deleting the combined product later had no way to know which
-- originals to bring back, so they stayed inactive forever. See Naeems.txt
-- "PART 2" (this batch) for the full explanation.
--
-- Two new nullable columns, both ON DELETE SET NULL (never blocks a delete,
-- and correctly degrades to "nothing to reactivate" if the original itself
-- was deleted by hand in the meantime):
--   - products.combined_from_product_id — set only on a product CREATED by
--     the Combine flow, pointing at whichever original supplied its shared
--     content/base price/stock (the one that became option zero, not a
--     separate variant row).
--   - product_variants.source_product_id — set only on a variant row
--     CREATED by the Combine flow, pointing at the original product it was
--     copied from. NULL for every hand-added variant (VariantEditor never
--     sets this), so deleting a product with only hand-added variants
--     behaves exactly as it does today — nothing to reactivate.
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS combined_from_product_id uuid REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS source_product_id uuid REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_combined_from ON products (combined_from_product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_source ON product_variants (source_product_id);

-- ---------- Republish products_view (adds combined_from_product_id) ----------
DROP VIEW IF EXISTS products_view;

CREATE VIEW products_view AS
SELECT
  id, sku, slug, name, brand, category_id, retail_price, offer_price,
  stock_status, stock_quantity, note, description,
  how_to_use, key_ingredients, youtube_url,
  skin_types, skin_conditions, region, size,
  image_url, image_urls, is_active, is_featured, created_at, updated_at,
  combined_from_product_id,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale
FROM products;

GRANT SELECT ON products_view TO anon, authenticated;

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

-- ---------- Republish product_variants_view (adds source_product_id) ----------
DROP VIEW IF EXISTS product_variants_view;

CREATE VIEW product_variants_view AS
SELECT
  id, product_id, region, size, retail_price, offer_price,
  in_stock, stock_quantity, image_url, note, sort_order, created_at,
  source_product_id,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale
FROM product_variants;

GRANT SELECT ON product_variants_view TO anon, authenticated;

DO $$
DECLARE
  column_list text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
  INTO column_list
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'product_variants'
    AND column_name <> 'wholesale_price';

  EXECUTE format('GRANT SELECT (%s) ON product_variants TO anon, authenticated', column_list);
END $$;

-- ---------- Verify ----------
-- As the anon key, these must return rows with the new columns present
-- (both null on existing rows) — not a 42501 permission error:
--   GET /rest/v1/products_view?select=id,combined_from_product_id&limit=1
--   GET /rest/v1/product_variants_view?select=id,source_product_id&limit=1
