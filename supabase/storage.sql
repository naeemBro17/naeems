-- ============================================================
-- Naeem's Price Hub — Storage bucket + policies (V1)
-- Run this after rls.sql in the Supabase SQL Editor.
--
-- Bucket: product-images
--   Public read: anyone can view product photos.
--   Authenticated write/delete: only the admin can manage them.
-- Path convention: products/{sku}.webp
-- ============================================================

-- Create the bucket (public read). Safe to re-run.
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
ON CONFLICT (id) DO NOTHING;

-- Public read access to all files in this bucket.
CREATE POLICY "product_images_public_read"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'product-images');

-- Authenticated admin can upload new images.
CREATE POLICY "product_images_admin_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-images');

-- Authenticated admin can replace existing images (upsert uploads).
CREATE POLICY "product_images_admin_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'product-images')
  WITH CHECK (bucket_id = 'product-images');

-- Authenticated admin can delete images (product delete / SKU change).
CREATE POLICY "product_images_admin_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'product-images');
