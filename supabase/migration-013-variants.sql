-- ============================================================
-- Naeem's Price Hub — Migration 013: product variants (Region → Size)
-- Run this in the Supabase SQL Editor after migration-012. Safe to re-run.
--
-- One row per Region+Size combination, each with its own prices and stock.
-- A product with no rows here is a single item and renders exactly as before.
--
-- wholesale_price follows the products pattern (migration-004 + 009):
--   • product_variants_view is the ONLY sanctioned read path. It runs with
--     owner privileges and returns wholesale_price only when
--     is_wholesaler_or_admin() (the SECURITY DEFINER helper) says so — NULL
--     for everyone else — plus a has_wholesale flag.
--   • The base table's wholesale_price column is not readable by any API
--     role: table-wide SELECT is dropped and every other column re-granted.
--   • Admins read wholesale_price through the view like wholesalers do; the
--     API has no separate "admin" database role to grant a column to.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_variants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  region          text NOT NULL,
  size            text NOT NULL,
  retail_price    numeric(10,2) NOT NULL CHECK (retail_price >= 0),
  offer_price     numeric(10,2) CHECK (offer_price IS NULL OR offer_price >= 0),
  wholesale_price numeric(10,2) CHECK (wholesale_price IS NULL OR wholesale_price >= 0),
  in_stock        boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants (product_id);

-- ---------- RLS ----------
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Reads go through the view, but the view's row filter still applies here.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'product_variants' AND policyname = 'product_variants_public_read'
  ) THEN
    CREATE POLICY "product_variants_public_read"
      ON product_variants FOR SELECT TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'product_variants' AND policyname = 'product_variants_admin_all'
  ) THEN
    CREATE POLICY "product_variants_admin_all"
      ON product_variants FOR ALL TO authenticated
      USING (is_admin())
      WITH CHECK (is_admin());
  END IF;
END $$;

-- ---------- Column lock on the base table ----------
-- Explicit grants (this project's default privileges are unreliable — see
-- migration-011), with wholesale_price left out of the SELECT list.
REVOKE SELECT ON product_variants FROM anon, authenticated;
GRANT SELECT (id, product_id, region, size, retail_price, offer_price, in_stock, sort_order, created_at)
  ON product_variants TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON product_variants TO authenticated;

-- ---------- product_variants_view (sole sanctioned read path) ----------
DROP VIEW IF EXISTS product_variants_view;

CREATE VIEW product_variants_view AS
SELECT
  id, product_id, region, size, retail_price, offer_price,
  in_stock, sort_order, created_at,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale
FROM product_variants;

GRANT SELECT ON product_variants_view TO anon, authenticated;

-- ---------- Verify ----------
-- As the anon key, this must return a 42501 permission error, not numbers:
--   GET /rest/v1/product_variants?select=id,wholesale_price&limit=1
-- and this must return rows with wholesale_price = null:
--   GET /rest/v1/product_variants_view?select=id,wholesale_price&limit=1
