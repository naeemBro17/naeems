-- ============================================================
-- Naeem's Price Hub — Migration 016: variant image/stock/note,
-- product-level Region/Size label
-- Run this in the Supabase SQL Editor after migration-015. Safe to re-run.
--
-- Part A: three new optional columns on product_variants so a variant can
-- carry its own photo, its own tracked stock count, and its own short note —
-- the same fields the parent product already has, but variant-specific.
--
-- Part B: two new optional columns on products (region, size) so a product
-- can carry a Region/Size label even before it has any real variant rows.
-- See Naeems.txt "PART 5" for the three-state behaviour this enables: no
-- label + no variants = today's plain product; a label with no variants =
-- the label shown as plain text, still no selector; one or more real
-- variant rows = the product's own data becomes the first selectable
-- option (using this label, or the product name if it has none) alongside
-- the real rows.
-- ============================================================

-- ---------- Part A: product_variants ----------
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS stock_quantity integer CHECK (stock_quantity IS NULL OR stock_quantity >= 0);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS note text;

-- ---------- Part B: products ----------
ALTER TABLE products ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS size text;

-- ---------- Republish products_view (adds region, size) ----------
DROP VIEW IF EXISTS products_view;

CREATE VIEW products_view AS
SELECT
  id, sku, slug, name, brand, category_id, retail_price, offer_price,
  stock_status, stock_quantity, note, description,
  how_to_use, key_ingredients, youtube_url,
  skin_types, skin_conditions, region, size,
  image_url, image_urls, is_active, is_featured, created_at, updated_at,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale
FROM products;

GRANT SELECT ON products_view TO anon, authenticated;

-- Re-grant products' column list (dynamic — picks up region/size automatically).
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

-- ---------- Republish product_variants_view (adds image_url, stock_quantity, note) ----------
DROP VIEW IF EXISTS product_variants_view;

CREATE VIEW product_variants_view AS
SELECT
  id, product_id, region, size, retail_price, offer_price,
  in_stock, stock_quantity, image_url, note, sort_order, created_at,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale
FROM product_variants;

GRANT SELECT ON product_variants_view TO anon, authenticated;

-- Re-grant product_variants' column list the same dynamic way (migration-013
-- used a fixed list, which would otherwise need editing by hand every time a
-- column is added).
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
-- (image_url/stock_quantity/note null on existing rows, region/size null on
-- existing products) — not a 42501 permission error:
--   GET /rest/v1/products_view?select=id,region,size&limit=1
--   GET /rest/v1/product_variants_view?select=id,image_url,stock_quantity,note&limit=1
