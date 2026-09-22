-- ============================================================
-- Naeem's Price Hub — Migration 018: normalize Region casing
-- Run this in the Supabase SQL Editor. Safe to re-run.
--
-- Batch 10 "duplicate variant display" fix. product_variants.region has
-- always been uppercased when a variant is saved (VariantEditor.tsx), but
-- products.region (the product's own base option — see variantOptionsFor in
-- src/lib/variants.ts) was saved exactly as typed, in whatever case the
-- admin used. A product whose own Region was typed in a different case than
-- its variant rows' Region (e.g. base "au", variant "AU") showed as two
-- separate-looking chips on the detail page for what was really the same
-- Region — that's the duplicate. The app code now uppercases both sides
-- going forward; this migration fixes rows saved before that fix.
--
-- Only casing changes — no values change, no rows are added or removed.
-- ============================================================

UPDATE products
SET region = UPPER(region)
WHERE region IS NOT NULL AND region <> UPPER(region);

UPDATE product_variants
SET region = UPPER(region)
WHERE region <> UPPER(region);

-- ---------- Verify ----------
-- Should return zero rows both times:
--   SELECT id, region FROM products WHERE region <> UPPER(region);
--   SELECT id, region FROM product_variants WHERE region <> UPPER(region);
