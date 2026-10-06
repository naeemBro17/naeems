-- ============================================================
-- NAEEM'S — Migration 034 (Batch 31: Steadfast customer check, small images)
-- Run this in the Supabase SQL Editor after migration-033. Safe to re-run.
--
-- ADDITIVE ONLY. Nothing is dropped, renamed or changed in meaning.
--
-- What it adds:
--   PART 1  A staff-only cache of Steadfast's customer check (delivered /
--           returned share for a phone number), so Steadfast is asked about
--           one number at most once a day. Only the steadfast Edge Function
--           writes it; staff with "View orders" may read it; customers and
--           visitors can't see it at all. Until this runs, the function
--           keeps the answers in memory instead.
--   PART 2  A "small copy" column for category photos (the ~160 px Browse
--           circle) and variant photos (the 400 px card copy), like
--           products.image_urls_thumb. product_variants_view gets the new
--           column at its end; everything else in it stays exactly the same.
--           Until this runs, the site keeps using the full photos.
-- ============================================================

-- ============================================================
-- PART 1 — Steadfast customer check cache
-- ============================================================

CREATE TABLE IF NOT EXISTS steadfast_fraud_cache (
  phone      text PRIMARY KEY,
  result     jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE steadfast_fraud_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "steadfast_fraud_cache_staff_read" ON steadfast_fraud_cache;
CREATE POLICY "steadfast_fraud_cache_staff_read"
  ON steadfast_fraud_cache FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

REVOKE ALL ON steadfast_fraud_cache FROM anon, authenticated;
GRANT SELECT ON steadfast_fraud_cache TO authenticated;
GRANT ALL ON steadfast_fraud_cache TO service_role;


-- ============================================================
-- PART 2 — small copies for category and variant photos
-- ============================================================

ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url_thumb text;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS image_url_thumb text;

-- Same view as today (migration-013 + later columns), plus image_url_thumb
-- at the end. CREATE OR REPLACE keeps its owner and grants.
CREATE OR REPLACE VIEW product_variants_view AS
SELECT
  id,
  product_id,
  region,
  size,
  retail_price,
  offer_price,
  in_stock,
  stock_quantity,
  image_url,
  note,
  sort_order,
  created_at,
  source_product_id,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL::numeric
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale,
  image_url_thumb
FROM product_variants;
