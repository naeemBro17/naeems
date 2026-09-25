-- ============================================================
-- Naeem's Price Hub — Migration 024 (Batch 19: Ad Readiness)
-- Run this in the Supabase SQL Editor. Safe to re-run.
--
-- Three independent pieces:
--   PART 1 — small "card" image column, for faster product grid/search/cart
--            thumbnails (Batch 19 Part 1). Additive only — never touches or
--            removes any existing image.
--   PART 2 — delivery fee: changes Inside Dhaka from ৳80 to ৳70 (data
--            change only, both zone fees were already admin-editable since
--            Batch 18), and seeds two new blank settings for the Facebook
--            Pixel ID / GA4 Measurement ID admin will fill in later.
--   PART 3 — lets admin change the delivery fee on one specific order
--            (heavy parcels), recalculating that order's total and logging
--            the change in its history — customers only ever see it as an
--            updated total on their own order page.
-- ============================================================

-- ---------- PART 1: small card-image column ----------
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_urls_thumb text[] NOT NULL DEFAULT '{}';

-- Republish products_view to expose the new column — same pattern as every
-- earlier column addition to this table (migration-007/008/012/016/017):
-- the view lists its columns explicitly, so it must be recreated, and the
-- column-level grant on the base table is recomputed from
-- information_schema so it automatically picks up the new column.
DROP VIEW IF EXISTS products_view;

CREATE VIEW products_view AS
SELECT
  id, sku, slug, name, brand, category_id, retail_price, offer_price,
  stock_status, stock_quantity, note, description,
  how_to_use, key_ingredients, youtube_url,
  skin_types, skin_conditions, region, size,
  image_url, image_urls, image_urls_thumb, is_active, is_featured, created_at, updated_at,
  combined_from_product_id,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale
FROM products;

GRANT SELECT ON products_view TO anon, authenticated;

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

-- Admin also needs to WRITE this column (the "generate small images for
-- existing products" button in Admin → Products updates it).
GRANT UPDATE (image_urls_thumb) ON products TO authenticated;


-- ---------- PART 2: delivery fee change + Pixel/GA4 settings ----------
UPDATE app_settings SET value = '70' WHERE key = 'delivery_fee_inside_dhaka';

INSERT INTO app_settings (key, value) VALUES
  ('fb_pixel_id', ''),
  ('ga_measurement_id', '')
ON CONFLICT (key) DO NOTHING;


-- ---------- PART 3: admin per-order delivery fee edit ----------
-- Only while the order is still pending/confirmed (matches how far
-- cancel_order() already lets an admin act on an order — see migration-021).
-- Recomputes total from THIS order's own stored subtotal/discount, the same
-- way place_order() computes it — never trusts a total from the caller.
-- Logs the change into order_status_history using the order's own current
-- status as both old_status and new_status (no real status change), with
-- a plain-English note — order_status_history.new_status has a CHECK
-- constraint against the five real statuses, so "fee changed" itself can't
-- be a status value; the note column carries that meaning instead.
CREATE OR REPLACE FUNCTION admin_update_order_delivery_fee(
  p_order_id uuid,
  p_new_fee numeric,
  p_note text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order    orders%ROWTYPE;
  v_new_total numeric(10,2);
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_new_fee IS NULL OR p_new_fee < 0 THEN
    RAISE EXCEPTION 'Delivery fee must be a positive number.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'Delivery fee can only be changed while the order is pending or confirmed.';
  END IF;

  v_new_total := GREATEST(v_order.subtotal + p_new_fee - v_order.discount, 0);

  UPDATE orders
    SET delivery_fee = p_new_fee, total = v_new_total, updated_at = now()
    WHERE id = p_order_id;

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (
    p_order_id, v_order.status, v_order.status, auth.uid(),
    COALESCE(p_note, format('Delivery fee changed ৳%s → ৳%s by admin', v_order.delivery_fee, p_new_fee))
  );

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_order_delivery_fee(uuid, numeric, text) TO authenticated;

-- ============================================================
-- ---------- Verify ----------
-- 1. SELECT image_urls_thumb FROM products_view LIMIT 1;
--      → returns an empty array ({}), not an error.
-- 2. SELECT value FROM app_settings WHERE key = 'delivery_fee_inside_dhaka';
--      → '70'.
-- 3. As admin, on a real pending/confirmed order:
--      SELECT admin_update_order_delivery_fee('<order id>', 120);
--      → succeeds; orders.total goes up by (120 - old fee); a new
--        order_status_history row appears with the ৳ note.
-- 4. As a non-admin session: same call → must fail with 'Not authorized.'
-- 5. On a 'shipped'/'delivered'/'cancelled' order, as admin: must fail with
--    the "can only be changed while pending or confirmed" message.
-- ============================================================
