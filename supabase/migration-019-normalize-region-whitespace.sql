-- ============================================================
-- Naeem's Price Hub — Migration 019: normalize Region whitespace
-- Run this in the Supabase SQL Editor. Safe to re-run.
--
-- Batch 11 PART 5. The product's own Region field (products.region) was
-- still a free-text box even after migration-018 uppercased it — nothing
-- stopped a stray leading/trailing space from being typed, and unlike
-- product_variants.region (now chosen from GuidedField's dropdown, so it
-- can't drift), a product's own Region could still end up spelled slightly
-- differently from its variant rows' Region for the same real-world place
-- (e.g. "KOREA " with a trailing space vs "KOREA"), which shows as two
-- Region chips on the detail page instead of one with sizes grouped under
-- it. This also re-runs migration-018's UPPER() in case that one was never
-- applied — both are safe to run again.
--
-- Only casing and whitespace change — no Region name is invented, merged,
-- or reassigned to a different real-world value.
-- ============================================================

UPDATE products
SET region = UPPER(TRIM(region))
WHERE region IS NOT NULL AND region <> UPPER(TRIM(region));

UPDATE product_variants
SET region = UPPER(TRIM(region))
WHERE region <> UPPER(TRIM(region));

-- ---------- Verify ----------
-- Should return zero rows both times:
--   SELECT id, region FROM products WHERE region <> UPPER(TRIM(region));
--   SELECT id, region FROM product_variants WHERE region <> UPPER(TRIM(region));
