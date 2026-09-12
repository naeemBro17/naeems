-- ============================================================
-- Naeem's Price Hub — Migration 010: expert-photos storage bucket
-- Run this in the Supabase SQL Editor. Safe to re-run.
--
-- The inline profile editor (Edit Mode on /contact) uploads the expert
-- photo to its own public bucket, 'expert-photos', at a fixed path
-- 'expert-photo.webp' (upserted, cache-busted by query string). The Admin →
-- Settings tab still writes to product-images/settings/expert-photo.webp;
-- both paths end up in the same app_settings key, expert_photo_url.
--
-- Writes are restricted to approved admins via is_admin() (migration-004),
-- matching the rest of the schema rather than any authenticated user.
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('expert-photos', 'expert-photos', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'expert_photos_public_read'
  ) THEN
    CREATE POLICY "expert_photos_public_read"
      ON storage.objects FOR SELECT TO anon, authenticated
      USING (bucket_id = 'expert-photos');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'expert_photos_admin_insert'
  ) THEN
    CREATE POLICY "expert_photos_admin_insert"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'expert-photos' AND is_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'expert_photos_admin_update'
  ) THEN
    CREATE POLICY "expert_photos_admin_update"
      ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'expert-photos' AND is_admin())
      WITH CHECK (bucket_id = 'expert-photos' AND is_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'expert_photos_admin_delete'
  ) THEN
    CREATE POLICY "expert_photos_admin_delete"
      ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'expert-photos' AND is_admin());
  END IF;
END $$;
