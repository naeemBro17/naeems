-- ============================================================
-- Naeem's Price Hub — Migration 005: Hero banner slides
-- Run this in the Supabase SQL Editor after the earlier migrations.
-- Safe to re-run (ON CONFLICT DO NOTHING).
--
-- The homepage hero banner reads its slides from the existing app_settings
-- key/value table under the 'banner_slides' key. The value is a JSON array;
-- each entry is:
--   eyebrow_text      text    small line above the headline
--   title             text    headline (clamped to 2 lines in the banner)
--   cta_button_text   text    button label, e.g. 'Shop Now →'
--   cta_action        text    'scroll_to_products' | 'open_contact' | 'open_url'
--   cta_url           text    destination when cta_action = 'open_url'
--   background_color  text    hex, reserved for future custom grounds
--   is_active         bool    false hides the slide without deleting it
--
-- No schema change is needed — app_settings already exists with public read
-- and admin write policies (migration 003). Slides are editable afterwards in
-- Admin → Settings → Banner Slides.
-- ============================================================

INSERT INTO app_settings (key, value) VALUES
  ('banner_slides', '[{"eyebrow_text":"🇦🇺 Direct from Australia","title":"Premium Skincare at Your Fingertips","cta_button_text":"Shop Now →","cta_action":"scroll_to_products","cta_url":"","background_color":"#FFF3EE","is_active":true}]')
ON CONFLICT (key) DO NOTHING;
