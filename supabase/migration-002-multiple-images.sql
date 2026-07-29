-- ============================================================
-- Naeem's — Migration 002: multiple product images
-- Run this in the Supabase SQL Editor (safe to re-run).
--
-- Adds products.image_urls (ordered array of public URLs).
-- image_url is kept as the cover image (always image_urls[1])
-- for CSV export and cached-client compatibility.
-- New uploads are stored at products/{uuid}.webp so paths no
-- longer depend on the SKU; legacy products/{sku}.webp files
-- keep working via their stored URLs.
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_urls text[] NOT NULL DEFAULT '{}';

-- Fold each existing single image into the new array.
UPDATE products
SET image_urls = ARRAY[image_url]
WHERE image_url IS NOT NULL
  AND image_urls = '{}';
