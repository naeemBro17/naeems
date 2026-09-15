-- ============================================================
-- Naeem's Price Hub — Migration 009: make the wholesale_price lock real
-- Run this in the Supabase SQL Editor AFTER migration-008.
-- Safe to re-run. URGENT: this closes a live data leak.
--
-- THE BUG
-- migration-004 Part 3 tried to hide the column with:
--     REVOKE SELECT (wholesale_price) ON products FROM anon, authenticated;
-- That statement is a no-op. In PostgreSQL a table-level `GRANT SELECT ON
-- products` (which Supabase grants to anon and authenticated by default)
-- already confers read access to every column. Revoking a single *column*
-- privilege only removes column-level grants — it cannot subtract from a
-- table-level grant. So despite the REVOKE, this still returned real numbers
-- to a plain anon API key:
--
--     GET /rest/v1/products?select=sku,wholesale_price
--     [{"sku":"HC-0386","wholesale_price":38.00}]
--
-- THE FIX
-- Drop the table-wide SELECT and re-grant every column except wholesale_price.
-- The grant list is built from the catalog so this stays correct as columns are
-- added, and re-running it after a future migration re-grants the new ones.
--
-- Note the deliberate fail-closed behaviour: a column added later is NOT
-- readable by anon/authenticated until this migration is re-run.
--
-- Unaffected by this change:
--   • products_view — an owner-privilege view, so it reads the base table as
--     its owner and keeps returning wholesale_price to is_wholesaler_or_admin().
--     It remains the only sanctioned read path.
--   • Admin writes — INSERT/UPDATE privileges are separate from SELECT, so
--     saving a wholesale price from the admin form still works.
-- ============================================================

REVOKE SELECT ON products FROM anon, authenticated;

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

-- ---------- Verify ----------
-- After running, this must return zero rows (no role may read the column):
--   SELECT grantee, privilege_type
--   FROM information_schema.column_privileges
--   WHERE table_name = 'products'
--     AND column_name = 'wholesale_price'
--     AND grantee IN ('anon', 'authenticated')
--     AND privilege_type = 'SELECT';
--
-- And this REST call must return a 42501 permission error, not a number:
--   GET /rest/v1/products?select=sku,wholesale_price&limit=1
