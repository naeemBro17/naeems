-- Batch 72: more than one category per product, skin types cleaned up to
-- Normal / Oily / Combination / Dry, and the customer's "My skin" answers.
-- Safe to run more than once. Runs as one transaction: if any check at the
-- end fails, NOTHING is changed.

BEGIN;

-- A. Extra categories (the main one stays in products.category_id)
ALTER TABLE products ADD COLUMN IF NOT EXISTS extra_category_ids uuid[] NOT NULL DEFAULT '{}';

-- B. Skin types: "All Skin Types" becomes all four; "Sensitive" moves to concerns
UPDATE products p SET
  skin_conditions = CASE
    WHEN 'Sensitive' = ANY (p.skin_types)
         AND NOT ('Sensitive' = ANY (COALESCE(p.skin_conditions, '{}'::text[])))
      THEN COALESCE(p.skin_conditions, '{}'::text[]) || ARRAY['Sensitive']::text[]
    ELSE p.skin_conditions
  END,
  skin_types = CASE
    WHEN 'All Skin Types' = ANY (p.skin_types) THEN ARRAY['Normal', 'Oily', 'Combination', 'Dry']::text[]
    ELSE array_remove(p.skin_types, 'Sensitive')
  END
WHERE p.skin_types && ARRAY['Sensitive', 'All Skin Types']::text[];

-- C. One spelling for anti aging (Home's concern card says "Anti aging")
UPDATE products
SET skin_conditions = array_replace(skin_conditions, 'Anti-Aging', 'Anti aging')
WHERE 'Anti-Aging' = ANY (skin_conditions);

-- D. The shop's read view: same columns as migration-052, plus the new one at the end
CREATE OR REPLACE VIEW products_view AS
SELECT p.id,
    p.sku,
    p.slug,
    p.name,
    p.brand,
    p.category_id,
    p.retail_price,
    p.offer_price,
    CASE WHEN p.keep_selling AND NOT (SELECT is_staff()) THEN 'in_stock'::text ELSE p.stock_status END AS stock_status,
    CASE WHEN p.keep_selling AND NOT (SELECT is_staff()) THEN NULL::integer ELSE p.stock_quantity END AS stock_quantity,
    p.note,
    p.description,
    p.how_to_use,
    p.key_ingredients,
    p.youtube_url,
    p.skin_types,
    p.skin_conditions,
    p.region,
    p.size,
    p.image_url,
    p.image_urls,
    p.image_urls_thumb,
    p.is_active,
    p.is_featured,
    p.created_at,
    p.updated_at,
    p.combined_from_product_id,
    CASE WHEN is_wholesaler_or_admin() THEN p.wholesale_price ELSE NULL::numeric END AS wholesale_price,
    (p.wholesale_price IS NOT NULL) AS has_wholesale,
    p.brand_id,
    p.keep_selling,
    (CASE WHEN p.stock_quantity IS NOT NULL THEN p.stock_quantity > 0
          ELSE p.stock_status <> 'out_of_stock' END) AS in_hand,
    p.extra_category_ids
FROM products p;

GRANT SELECT ON products_view TO anon, authenticated;

-- E. The customer's own "My skin" answers (she saves them herself; the
--    existing profiles_self_update policy already lets her update her row)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS skin_type text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS skin_concerns text[] NOT NULL DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS skin_wants text[] NOT NULL DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS skin_saved_at timestamptz;

-- F. Checks: stop and undo everything if something is wrong
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'products_view' AND column_name = 'extra_category_ids') THEN
    RAISE EXCEPTION 'STOP: products_view has no extra_category_ids';
  END IF;
  IF EXISTS (SELECT 1 FROM products WHERE skin_types && ARRAY['Sensitive', 'All Skin Types']::text[]) THEN
    RAISE EXCEPTION 'STOP: old skin types are still on some products';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'profiles' AND column_name = 'skin_wants') THEN
    RAISE EXCEPTION 'STOP: profiles has no skin_wants';
  END IF;
END $$;

COMMIT;

-- After it runs, this should show one row with ok = true:
SELECT (SELECT count(*) FROM information_schema.columns
        WHERE table_name = 'products_view' AND column_name = 'extra_category_ids') = 1
   AND (SELECT count(*) FROM information_schema.columns
        WHERE table_name = 'profiles' AND column_name IN ('skin_type', 'skin_concerns', 'skin_wants', 'skin_saved_at')) = 4
   AS ok;
