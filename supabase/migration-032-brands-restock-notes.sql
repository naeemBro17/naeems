-- ============================================================
-- Naeem's Price Hub — Migration 032 (Batch 26: brands + 3 admin extras)
-- Run this in the Supabase SQL Editor after migration-031. Safe to re-run.
--
-- ADDITIVE ONLY. No table or column is dropped or renamed, and every
-- existing function keeps its exact name, arguments and behaviour, so the
-- live site (built from main) keeps working the moment this runs. The old
-- products.brand text column stays, and is kept in sync automatically.
--
-- What it adds:
--   PART 1  A brands table (name, link, logos, banner, video, home row
--           switch, order). Products point to their brand by id. Existing
--           brand text and the brand at the start of each product name are
--           matched (case- and punctuation-insensitive: "CERAVE" = "CeraVe",
--           "La Roche Posay" = "La Roche-Posay").
--   PART 2  Who may change brands: the Super Admin and staff with the new
--           "Edit brands" switch (checked inside the database). Every brand
--           change goes to the Activity Log. A storage bucket for logos,
--           banners and videos.
--   PART 3  Restock: a quick stock update, done in the database.
--   PART 4  The 7-day sales chart numbers.
--   PART 5  Private customer notes and tags (staff only).
-- ============================================================


-- ============================================================
-- PART 1 — brands
-- ============================================================

-- The matching key: lower case, accents folded, everything but letters and
-- digits removed. "CeraVe", "CERAVE" and "Cera Ve" all give "cerave".
CREATE OR REPLACE FUNCTION brand_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(
    translate(lower(COALESCE(p_name, '')),
              'àáâäãåèéêëìíîïòóôöõùúûüçñ',
              'aaaaaaeeeeiiiiooooouuuucn'),
    '[^a-z0-9]', '', 'g');
$$;

-- The link part of /brand/<slug>: "La Roche-Posay" -> "la-roche-posay",
-- "Paula's Choice" -> "paulas-choice".
CREATE OR REPLACE FUNCTION brand_slugify(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT trim(BOTH '-' FROM regexp_replace(
    regexp_replace(
      translate(lower(COALESCE(p_name, '')),
                'àáâäãåèéêëìíîïòóôöõùúûüçñ',
                'aaaaaaeeeeiiiiooooouuuucn'),
      '[''’]', '', 'g'),
    '[^a-z0-9]+', '-', 'g'));
$$;

CREATE TABLE IF NOT EXISTS brands (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  slug               text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  logo_url           text,
  logo_dark_url      text,
  banner_image_url   text,
  banner_video_url   text,
  banner_youtube_url text,
  show_on_home       boolean NOT NULL DEFAULT false,
  display_order      integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text,
  CONSTRAINT brands_name_has_letters CHECK (brand_key(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS brands_key_unique ON brands (brand_key(name));
CREATE UNIQUE INDEX IF NOT EXISTS brands_slug_unique ON brands (slug);
CREATE INDEX IF NOT EXISTS idx_brands_home ON brands (show_on_home, display_order);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brands(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand_id);

-- products uses per-column read rights (wholesale_price stays locked); the
-- new column is public like the brand name itself.
GRANT SELECT (brand_id) ON products TO anon, authenticated;

-- A slug nobody else has: "cerave", then "cerave-2", "cerave-3", ...
CREATE OR REPLACE FUNCTION brand_unique_slug(p_base text, p_exclude uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_base text := COALESCE(NULLIF(brand_slugify(p_base), ''), 'brand');
  v_slug text := v_base;
  v_n    integer := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM brands WHERE slug = v_slug AND id IS DISTINCT FROM p_exclude) LOOP
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  END LOOP;
  RETURN v_slug;
END;
$$;

-- ---------- the brands found in the catalogue ----------
-- Every brand that starts a product name today. "match" is the key a
-- product name must start with (Vaseline is spelled "Vasline" in one name).
DROP TABLE IF EXISTS _brand_seed;
CREATE TEMP TABLE _brand_seed (name text, match text);
INSERT INTO _brand_seed (name, match) VALUES
  ('Aveeno', 'aveeno'), ('Avène', 'avene'), ('Beauty of Joseon', 'beautyofjoseon'),
  ('Bio-Oil', 'biooil'), ('Blackmores', 'blackmores'), ('Blistex', 'blistex'),
  ('Cancer Council', 'cancercouncil'), ('CeraVe', 'cerave'), ('Cetaphil', 'cetaphil'),
  ('Colgate', 'colgate'), ('COSRX', 'cosrx'), ('David Beckham', 'davidbeckham'),
  ('Dove', 'dove'), ('Dr.Althea', 'dralthea'), ('Gaia', 'gaia'), ('Garnier', 'garnier'),
  ('Geek & Gorgeous', 'geekgorgeous'), ('Gillette', 'gillette'), ('Goat', 'goat'),
  ('Hamilton', 'hamilton'), ('ILLIYOON', 'illiyoon'), ('Invisible Zinc', 'invisiblezinc'),
  ('Kirkland', 'kirkland'), ('L''Oréal', 'loreal'), ('La Roche-Posay', 'larocheposay'),
  ('Laneige', 'laneige'), ('Lenor', 'lenor'), ('Listerine', 'listerine'),
  ('MCoBeauty', 'mcobeauty'), ('Nad''s', 'nads'), ('Neutrogena', 'neutrogena'),
  ('Nivea', 'nivea'), ('Olay', 'olay'), ('OMI Brotherhood', 'omibrotherhood'),
  ('Oral-B', 'oralb'), ('Paula''s Choice', 'paulaschoice'), ('Plunketts', 'plunketts'),
  ('Purito', 'purito'), ('Sensodyne', 'sensodyne'), ('SKIN1004', 'skin1004'),
  ('Sukin', 'sukin'), ('The Ordinary', 'theordinary'), ('Vaseline', 'vaseline'),
  ('Vaseline', 'vasline'), ('ZGTS', 'zgts');

-- Products saved with a brand text but no brand id yet.
-- 1) A brand text that is one of the brands above (any spelling/case).
-- 2) Any other brand text becomes its own brand.
-- 3) No brand text: the brand the product name starts with (longest match).
DROP TABLE IF EXISTS _brand_match;
CREATE TEMP TABLE _brand_match (product_id uuid, brand_name text);

INSERT INTO _brand_match (product_id, brand_name)
SELECT p.id, COALESCE(
         (SELECT s.name FROM _brand_seed s WHERE s.match = brand_key(p.brand) LIMIT 1),
         (SELECT b.name FROM brands b WHERE brand_key(b.name) = brand_key(p.brand)),
         trim(p.brand))
FROM products p
WHERE p.brand_id IS NULL AND brand_key(p.brand) <> '';

INSERT INTO _brand_match (product_id, brand_name)
SELECT p.id, (
  SELECT s.name FROM _brand_seed s
  WHERE brand_key(p.name) LIKE s.match || '%'
  ORDER BY length(s.match) DESC
  LIMIT 1)
FROM products p
WHERE p.brand_id IS NULL AND brand_key(p.brand) = ''
  AND EXISTS (SELECT 1 FROM _brand_seed s WHERE brand_key(p.name) LIKE s.match || '%');

-- Create each matched brand once (an existing brand with the same key is
-- reused, so re-running never makes a duplicate).
INSERT INTO brands (name, slug, display_order)
SELECT m.brand_name, brand_unique_slug(m.brand_name, NULL), 0
FROM (SELECT DISTINCT ON (brand_key(brand_name)) brand_name FROM _brand_match ORDER BY brand_key(brand_name), brand_name) m
WHERE NOT EXISTS (SELECT 1 FROM brands b WHERE brand_key(b.name) = brand_key(m.brand_name));

-- Display order: alphabetical to start with (Naeem drags them after). On a
-- re-run, any brand still at 0 goes after the ones already placed.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY lower(name)) AS n FROM brands WHERE display_order = 0
)
UPDATE brands b
SET display_order = o.n + COALESCE((SELECT max(x.display_order) FROM brands x), 0)
FROM ordered o
WHERE b.id = o.id;

-- Link the products, and write the brand's spelling into the old text
-- column. Run outside any staff session, so no Activity Log noise.
UPDATE products p
SET brand_id = b.id, brand = b.name
FROM _brand_match m
JOIN brands b ON brand_key(b.name) = brand_key(m.brand_name)
WHERE p.id = m.product_id AND p.brand_id IS NULL;

DROP TABLE IF EXISTS _brand_match;
DROP TABLE IF EXISTS _brand_seed;

-- ---------- products_view: same columns, plus brand_id at the end ----------
-- CREATE OR REPLACE may only add columns at the end, so every existing
-- column keeps its exact place and meaning.
CREATE OR REPLACE VIEW products_view AS
SELECT
  id, sku, slug, name, brand, category_id, retail_price, offer_price,
  stock_status, stock_quantity, note, description, how_to_use, key_ingredients,
  youtube_url, skin_types, skin_conditions, region, size,
  image_url, image_urls, image_urls_thumb, is_active, is_featured,
  created_at, updated_at, combined_from_product_id,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL::numeric
  END AS wholesale_price,
  wholesale_price IS NOT NULL AS has_wholesale,
  brand_id
FROM products;

GRANT SELECT ON products_view TO anon, authenticated;

-- ---------- quiet flags for the product triggers ----------
-- app.brand_sync: a brand rename is copying the new name into its products.
--   That is not a product edit: no "Last updated by", no log line per product.
-- app.activity_quiet: a database function (Restock) writes its own single,
--   clearer log line, so the per-row product log is skipped.
CREATE OR REPLACE FUNCTION brand_sync_in_progress()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('app.brand_sync', true), '') = 'on';
$$;

CREATE OR REPLACE FUNCTION activity_quiet()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('app.activity_quiet', true), '') = 'on'
      OR COALESCE(current_setting('app.brand_sync', true), '') = 'on';
$$;

-- Same as migration-030, plus: skip during a brand rename.
CREATE OR REPLACE FUNCTION products_stamp_editor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF is_staff() AND NOT order_stock_change_in_progress() AND NOT brand_sync_in_progress() THEN
    NEW.last_edited_by := current_actor_username();
    NEW.last_edited_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- Same as migration-030, plus: skip when quiet (rename / Restock).
CREATE OR REPLACE FUNCTION products_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_diff jsonb;
  v_skip text[] := ARRAY['updated_at', 'created_at', 'last_edited_by', 'last_edited_at', 'image_urls_thumb'];
BEGIN
  IF NOT is_staff() OR order_stock_change_in_progress() OR activity_quiet() THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM write_activity('product.created', 'product', NEW.id::text, NEW.name,
      format('Added product "%s"', NEW.name), '{}'::jsonb);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM write_activity('product.deleted', 'product', OLD.id::text, OLD.name,
      format('Deleted product "%s"', OLD.name), '{}'::jsonb);
  ELSE
    v_diff := activity_row_diff(to_jsonb(OLD), to_jsonb(NEW), v_skip);
    IF v_diff <> '{}'::jsonb THEN
      PERFORM write_activity('product.updated', 'product', NEW.id::text, NEW.name,
        format('Edited "%s": %s', NEW.name,
               (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_diff) k)),
        v_diff);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Same as migration-030, plus: skip when quiet (Restock logs its own line).
CREATE OR REPLACE FUNCTION product_variants_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id uuid;
  v_product_name text;
  v_label text;
  v_diff jsonb;
BEGIN
  IF NOT is_staff() OR order_stock_change_in_progress() OR activity_quiet() THEN
    RETURN NULL;
  END IF;

  v_product_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  SELECT name INTO v_product_name FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN
    -- The whole product is being deleted; that is logged once, on the product.
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_label := concat_ws(' · ', OLD.region, OLD.size);
    PERFORM write_activity('product.variant_deleted', 'product', v_product_id::text, v_product_name,
      format('Removed option %s from "%s"', v_label, v_product_name), '{}'::jsonb);
  ELSIF TG_OP = 'INSERT' THEN
    v_label := concat_ws(' · ', NEW.region, NEW.size);
    PERFORM write_activity('product.variant_added', 'product', v_product_id::text, v_product_name,
      format('Added option %s to "%s"', v_label, v_product_name), '{}'::jsonb);
  ELSE
    v_label := concat_ws(' · ', NEW.region, NEW.size);
    v_diff := activity_row_diff(to_jsonb(OLD), to_jsonb(NEW), ARRAY['created_at', 'updated_at']);
    IF v_diff = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    PERFORM write_activity('product.variant_updated', 'product', v_product_id::text, v_product_name,
      format('Edited option %s of "%s": %s', v_label, v_product_name,
             (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_diff) k)),
      v_diff);
  END IF;

  -- "Last updated by" on the product itself.
  UPDATE products
  SET last_edited_by = current_actor_username(), last_edited_at = now()
  WHERE id = v_product_id;
  RETURN NULL;
END;
$$;

-- ---------- keep products.brand_id and products.brand in step ----------
-- New admin: sends brand_id; the text follows the brand's name.
-- Old admin / CSV import (text only): the text is matched to a brand (any
-- spelling), or a new brand is made with just that name (hidden from Home
-- until someone with "Edit brands" sets it up). Empty text = no brand.
CREATE OR REPLACE FUNCTION products_sync_brand()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_text  text;
  v_brand brands%ROWTYPE;
BEGIN
  IF brand_sync_in_progress() THEN
    RETURN NEW;
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.brand_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.brand_id IS DISTINCT FROM OLD.brand_id) THEN
    IF NEW.brand_id IS NULL THEN
      NEW.brand := NULL;
    ELSE
      NEW.brand := (SELECT name FROM brands WHERE id = NEW.brand_id);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.brand IS DISTINCT FROM OLD.brand THEN
    v_text := trim(COALESCE(NEW.brand, ''));
    IF brand_key(v_text) = '' THEN
      NEW.brand_id := NULL;
      NEW.brand := NULL;
      RETURN NEW;
    END IF;
    SELECT * INTO v_brand FROM brands WHERE brand_key(name) = brand_key(v_text);
    IF NOT FOUND THEN
      INSERT INTO brands (name, slug, display_order)
      VALUES (left(v_text, 60), brand_unique_slug(v_text, NULL),
              COALESCE((SELECT max(display_order) FROM brands), 0) + 1)
      RETURNING * INTO v_brand;
    END IF;
    NEW.brand_id := v_brand.id;
    NEW.brand := v_brand.name;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_sync_brand ON products;
CREATE TRIGGER products_sync_brand
  BEFORE INSERT OR UPDATE OF brand, brand_id ON products
  FOR EACH ROW EXECUTE FUNCTION products_sync_brand();

-- ---------- brand rows: tidy name, slug, who/when ----------
CREATE OR REPLACE FUNCTION brands_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.name := regexp_replace(trim(NEW.name), '\s+', ' ', 'g');
  NEW.slug := lower(trim(COALESCE(NEW.slug, '')));
  IF NEW.slug = '' THEN
    NEW.slug := brand_unique_slug(NEW.name, NEW.id);
  END IF;
  NEW.logo_url := NULLIF(trim(COALESCE(NEW.logo_url, '')), '');
  NEW.logo_dark_url := NULLIF(trim(COALESCE(NEW.logo_dark_url, '')), '');
  NEW.banner_image_url := NULLIF(trim(COALESCE(NEW.banner_image_url, '')), '');
  NEW.banner_video_url := NULLIF(trim(COALESCE(NEW.banner_video_url, '')), '');
  NEW.banner_youtube_url := NULLIF(trim(COALESCE(NEW.banner_youtube_url, '')), '');
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  END IF;
  -- Reordering the list is not an edit of each brand: who/when stay as
  -- they were (the reorder writes its own single Activity Log line).
  IF TG_OP = 'UPDATE' AND COALESCE(current_setting('app.brand_bulk', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := CASE WHEN is_staff() THEN current_actor_username() ELSE COALESCE(NEW.updated_by, 'system') END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brands_before_write ON brands;
CREATE TRIGGER brands_before_write
  BEFORE INSERT OR UPDATE ON brands
  FOR EACH ROW EXECUTE FUNCTION brands_before_write();

-- A rename reaches every product of the brand straight away (cards,
-- product page, search all read the name from the product row).
CREATE OR REPLACE FUNCTION brands_after_rename()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    PERFORM set_config('app.brand_sync', 'on', true);
    UPDATE products SET brand = NEW.name WHERE brand_id = NEW.id AND brand IS DISTINCT FROM NEW.name;
    PERFORM set_config('app.brand_sync', 'off', true);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS brands_after_rename ON brands;
CREATE TRIGGER brands_after_rename
  AFTER UPDATE OF name ON brands
  FOR EACH ROW EXECUTE FUNCTION brands_after_rename();


-- ============================================================
-- PART 2 — who may change brands, Activity Log, storage
-- ============================================================

-- Two new switches (both OFF for every existing role).
CREATE OR REPLACE FUNCTION staff_permission_names()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'view_orders', 'change_order_status', 'create_orders', 'book_steadfast',
    'edit_products', 'edit_categories', 'view_customers', 'delete_early_orders',
    'view_wholesalers', 'see_sales', 'edit_brands', 'edit_customer_notes'
  ];
$$;

ALTER TABLE brands ENABLE ROW LEVEL SECURITY;

-- Brand pages are public.
DROP POLICY IF EXISTS "brands_public_read" ON brands;
CREATE POLICY "brands_public_read"
  ON brands FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "brands_staff_insert" ON brands;
CREATE POLICY "brands_staff_insert"
  ON brands FOR INSERT TO authenticated
  WITH CHECK (staff_can('edit_brands'));

DROP POLICY IF EXISTS "brands_staff_update" ON brands;
CREATE POLICY "brands_staff_update"
  ON brands FOR UPDATE TO authenticated
  USING (staff_can('edit_brands'))
  WITH CHECK (staff_can('edit_brands'));

DROP POLICY IF EXISTS "brands_staff_delete" ON brands;
CREATE POLICY "brands_staff_delete"
  ON brands FOR DELETE TO authenticated
  USING (staff_can('edit_brands'));

REVOKE ALL ON brands FROM anon, authenticated;
GRANT SELECT ON brands TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON brands TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON brands TO service_role;

-- Every brand change, by whom, with before → after. Reordering writes one
-- line for the whole list (admin_brands_reorder), not one per brand.
CREATE OR REPLACE FUNCTION brands_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_diff jsonb;
BEGIN
  IF NOT is_staff() OR COALESCE(current_setting('app.brand_bulk', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM write_activity('brand.created', 'brand', NEW.id::text, NEW.name,
      format('Added brand "%s"', NEW.name), '{}'::jsonb);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM write_activity('brand.deleted', 'brand', OLD.id::text, OLD.name,
      format('Deleted brand "%s"', OLD.name), '{}'::jsonb);
  ELSE
    v_diff := activity_row_diff(to_jsonb(OLD), to_jsonb(NEW), ARRAY['updated_at', 'updated_by', 'created_at']);
    IF v_diff <> '{}'::jsonb THEN
      PERFORM write_activity('brand.updated', 'brand', NEW.id::text, NEW.name,
        CASE WHEN v_diff ? 'name'
             THEN format('Renamed brand "%s" to "%s"', OLD.name, NEW.name)
             ELSE format('Changed brand "%s": %s', NEW.name,
                         (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_diff) k))
        END,
        v_diff);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS brands_activity_log ON brands;
CREATE TRIGGER brands_activity_log
  AFTER INSERT OR UPDATE OR DELETE ON brands
  FOR EACH ROW EXECUTE FUNCTION brands_activity();

-- Drag to reorder: the ids in their new order. One Activity Log line.
CREATE OR REPLACE FUNCTION admin_brands_reorder(p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT staff_can('edit_brands') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM set_config('app.brand_bulk', 'on', true);
  UPDATE brands b SET display_order = o.n
  FROM unnest(p_ids) WITH ORDINALITY AS o(id, n)
  WHERE b.id = o.id AND b.display_order IS DISTINCT FROM o.n;
  PERFORM set_config('app.brand_bulk', 'off', true);
  PERFORM write_activity('brand.reordered', 'brand', NULL, 'Brands',
    'Changed the order of brands',
    jsonb_build_object('order', jsonb_build_object('from', NULL,
      'to', activity_short(to_jsonb((SELECT array_agg(b.name ORDER BY o.n)
                                     FROM unnest(p_ids) WITH ORDINALITY AS o(id, n)
                                     JOIN brands b ON b.id = o.id))))));
END;
$$;

REVOKE ALL ON FUNCTION admin_brands_reorder(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_brands_reorder(uuid[]) TO authenticated;

-- Logos, banners and banner videos. Public to read; only "Edit brands"
-- may upload, replace or remove. 15 MB per file (the video limit).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('brand-media', 'brand-media', true, 15728640,
        ARRAY['image/png', 'image/webp', 'image/jpeg', 'video/mp4', 'video/webm'])
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "brand_media_staff_insert" ON storage.objects;
CREATE POLICY "brand_media_staff_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'brand-media' AND staff_can('edit_brands'));

DROP POLICY IF EXISTS "brand_media_staff_update" ON storage.objects;
CREATE POLICY "brand_media_staff_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'brand-media' AND staff_can('edit_brands'))
  WITH CHECK (bucket_id = 'brand-media' AND staff_can('edit_brands'));

DROP POLICY IF EXISTS "brand_media_staff_delete" ON storage.objects;
CREATE POLICY "brand_media_staff_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'brand-media' AND staff_can('edit_brands'));

-- Upsert (replacing a logo in place) reads the existing object first.
DROP POLICY IF EXISTS "brand_media_staff_read" ON storage.objects;
CREATE POLICY "brand_media_staff_read"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'brand-media' AND staff_can('edit_brands'));


-- ============================================================
-- PART 3 — Restock (quick stock update)
-- ============================================================

-- "add": the count goes up by p_amount. "set": the count becomes p_amount.
-- p_variant_id NULL = the product's own (first) option. The maths happens
-- here, never in the browser. One Activity Log line: "Restock: 21 → 45".
CREATE OR REPLACE FUNCTION admin_restock(p_product_id uuid, p_variant_id uuid, p_mode text, p_amount integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name   text;
  v_option text;
  v_before integer;
  v_after  integer;
BEGIN
  IF NOT staff_can('edit_products') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('add', 'set') THEN
    RAISE EXCEPTION 'Choose Add or Set to.';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 OR p_amount > 100000 OR (p_mode = 'add' AND p_amount = 0) THEN
    RAISE EXCEPTION 'Enter a whole number of 0 or more.';
  END IF;

  SELECT name INTO v_name FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found.';
  END IF;

  PERFORM set_config('app.activity_quiet', 'on', true);
  IF p_variant_id IS NULL THEN
    SELECT stock_quantity INTO v_before FROM products WHERE id = p_product_id;
    v_after := CASE WHEN p_mode = 'add' THEN COALESCE(v_before, 0) + p_amount ELSE p_amount END;
    UPDATE products
    SET stock_quantity = v_after,
        stock_status = CASE
          WHEN v_after <= 0 THEN 'out_of_stock'
          WHEN stock_status = 'out_of_stock' THEN 'in_stock'
          ELSE stock_status
        END
    WHERE id = p_product_id;
  ELSE
    SELECT stock_quantity, concat_ws(' · ', region, size) INTO v_before, v_option
    FROM product_variants WHERE id = p_variant_id AND product_id = p_product_id FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM set_config('app.activity_quiet', 'off', true);
      RAISE EXCEPTION 'Option not found.';
    END IF;
    v_after := CASE WHEN p_mode = 'add' THEN COALESCE(v_before, 0) + p_amount ELSE p_amount END;
    UPDATE product_variants SET stock_quantity = v_after, in_stock = (v_after > 0) WHERE id = p_variant_id;
  END IF;
  PERFORM set_config('app.activity_quiet', 'off', true);

  -- "Last updated by" (the stamp trigger fills in who and when).
  UPDATE products SET last_edited_at = now() WHERE id = p_product_id;

  PERFORM write_activity('product.restock', 'product', p_product_id::text, v_name,
    format('Restock%s: %s → %s',
           CASE WHEN v_option IS NOT NULL AND v_option <> '' THEN ' (' || v_option || ')' ELSE '' END,
           COALESCE(v_before::text, 'not counted'), v_after),
    jsonb_build_object(
      'stock_quantity', jsonb_build_object('from', v_before, 'to', v_after),
      'mode', p_mode, 'amount', p_amount,
      'option', COALESCE(v_option, '')));

  RETURN jsonb_build_object('before', v_before, 'after', v_after);
END;
$$;

REVOKE ALL ON FUNCTION admin_restock(uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_restock(uuid, uuid, text, integer) TO authenticated;


-- ============================================================
-- PART 4 — 7-day sales chart
-- ============================================================

-- The last 7 days in Bangladesh time, oldest first, today last: total ৳ and
-- number of orders that are not cancelled. Days with no orders are 0.
-- Only the Super Admin or staff with "See sales figures"; refused otherwise.
CREATE OR REPLACE FUNCTION admin_sales_7d()
RETURNS TABLE (day date, total numeric, order_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Dhaka')::date;
BEGIN
  IF NOT staff_can('see_sales') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN QUERY
  SELECT d.d::date,
         COALESCE(sum(o.total), 0)::numeric,
         count(o.id)
  FROM generate_series(v_today - 6, v_today, interval '1 day') AS d(d)
  LEFT JOIN orders o
    ON (o.created_at AT TIME ZONE 'Asia/Dhaka')::date = d.d::date
   AND o.status <> 'cancelled'
  GROUP BY d.d
  ORDER BY d.d;
END;
$$;

REVOKE ALL ON FUNCTION admin_sales_7d() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_sales_7d() TO authenticated;


-- ============================================================
-- PART 5 — private customer notes and tags
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_notes (
  customer_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  note        text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  tags        text[] NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE INDEX IF NOT EXISTS idx_customer_notes_tags ON customer_notes USING gin (tags);

ALTER TABLE customer_notes ENABLE ROW LEVEL SECURITY;

-- Staff with "View customers" (and the Super Admin) only. A customer is
-- never staff, so they can never read their own row by any route.
DROP POLICY IF EXISTS "customer_notes_staff_read" ON customer_notes;
CREATE POLICY "customer_notes_staff_read"
  ON customer_notes FOR SELECT TO authenticated
  USING (staff_can('view_customers'));

-- Reads only; every write goes through admin_set_customer_note below.
REVOKE ALL ON customer_notes FROM anon, authenticated;
GRANT SELECT ON customer_notes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_notes TO service_role;

-- Saves one customer's note and tags. Needs "Edit customer notes". Tags
-- are trimmed, at most 30 characters, at most 12, no duplicates, and take
-- the spelling already used elsewhere ("vip" becomes "VIP" if VIP exists).
CREATE OR REPLACE FUNCTION admin_set_customer_note(p_customer_id uuid, p_note text, p_tags text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name     text;
  v_note     text := trim(COALESCE(p_note, ''));
  v_tags     text[] := '{}';
  v_tag      text;
  v_existing text;
  v_old      customer_notes%ROWTYPE;
  v_diff     jsonb := '{}'::jsonb;
BEGIN
  IF NOT staff_can('edit_customer_notes') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT COALESCE(NULLIF(full_name, ''), id::text) INTO v_name
  FROM profiles WHERE id = p_customer_id AND role = 'customer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;
  IF length(v_note) > 2000 THEN
    RAISE EXCEPTION 'The note is too long (2000 characters at most).';
  END IF;

  FOREACH v_tag IN ARRAY COALESCE(p_tags, '{}'::text[]) LOOP
    v_tag := left(regexp_replace(trim(v_tag), '\s+', ' ', 'g'), 30);
    CONTINUE WHEN v_tag = '';
    SELECT t INTO v_existing
    FROM customer_notes c, unnest(c.tags) t
    WHERE lower(t) = lower(v_tag)
    LIMIT 1;
    v_tag := COALESCE(v_existing, v_tag);
    IF NOT EXISTS (SELECT 1 FROM unnest(v_tags) x WHERE lower(x) = lower(v_tag)) THEN
      v_tags := v_tags || v_tag;
    END IF;
  END LOOP;
  IF array_length(v_tags, 1) > 12 THEN
    RAISE EXCEPTION 'At most 12 tags per customer.';
  END IF;

  SELECT * INTO v_old FROM customer_notes WHERE customer_id = p_customer_id;

  INSERT INTO customer_notes (customer_id, note, tags, updated_at, updated_by)
  VALUES (p_customer_id, v_note, v_tags, now(), current_actor_username())
  ON CONFLICT (customer_id) DO UPDATE
  SET note = EXCLUDED.note, tags = EXCLUDED.tags, updated_at = now(), updated_by = EXCLUDED.updated_by;

  IF COALESCE(v_old.note, '') IS DISTINCT FROM v_note THEN
    v_diff := v_diff || jsonb_build_object('note', jsonb_build_object(
      'from', activity_short(to_jsonb(COALESCE(v_old.note, ''))), 'to', activity_short(to_jsonb(v_note))));
  END IF;
  IF COALESCE(v_old.tags, '{}'::text[]) IS DISTINCT FROM v_tags THEN
    v_diff := v_diff || jsonb_build_object('tags', jsonb_build_object(
      'from', to_jsonb(COALESCE(v_old.tags, '{}'::text[])), 'to', to_jsonb(v_tags)));
  END IF;
  IF v_diff <> '{}'::jsonb THEN
    PERFORM write_activity('customer.note_updated', 'customer', p_customer_id::text, v_name,
      format('Changed the private note / tags of "%s": %s', v_name,
             (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_diff) k)),
      v_diff);
  END IF;

  RETURN jsonb_build_object('note', v_note, 'tags', to_jsonb(v_tags));
END;
$$;

REVOKE ALL ON FUNCTION admin_set_customer_note(uuid, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_set_customer_note(uuid, text, text[]) TO authenticated;

-- ============================================================
-- ---------- Verify ----------
-- 1. SELECT name, slug, (SELECT count(*) FROM products p WHERE p.brand_id = b.id) FROM brands b ORDER BY display_order;
-- 2. SELECT name FROM products WHERE brand_id IS NULL;          → products with no brand found
-- 3. SELECT count(*) FROM products WHERE brand IS DISTINCT FROM (SELECT name FROM brands WHERE id = brand_id); → 0
-- 4. SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'brand-media';
-- ============================================================
