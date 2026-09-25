-- ============================================================
-- Naeem's Price Hub — Migration 022: fix "DELETE requires a WHERE clause"
-- Run this in the Supabase SQL Editor after migration-021. Safe to re-run.
--
-- Placing an order failed with:
--   {"code":"21000","message":"DELETE requires a WHERE clause"}
--
-- Cause: Supabase turns on a protection called "safeupdate" that blocks any
-- UPDATE or DELETE that doesn't have a WHERE clause, on any request that
-- comes in over the API — even one running inside a function like
-- place_order(). place_order() cleared its own scratch temp table with
-- "DELETE FROM _order_lines;", which has no WHERE clause, so it was blocked.
--
-- Fix: use TRUNCATE instead, which clears the table the same way but isn't
-- subject to that check. This migration replaces place_order() with the
-- corrected version. cancel_order() and admin_set_order_status() were
-- checked too — every UPDATE in those already has a WHERE clause, so they
-- did not have this problem.
-- ============================================================

CREATE OR REPLACE FUNCTION place_order(
  p_items          jsonb,
  p_full_name      text,
  p_phone          text,
  p_division       text,
  p_district       text,
  p_thana          text,
  p_address_line   text,
  p_delivery_zone  text,
  p_payment_method text,
  p_bkash_trx_id   text DEFAULT NULL,
  p_bkash_sender   text DEFAULT NULL,
  p_promo_code     text DEFAULT NULL,
  p_customer_note  text DEFAULT NULL
)
RETURNS TABLE (order_id uuid, order_number text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_item             jsonb;
  v_product_id       uuid;
  v_variant_id       uuid;
  v_quantity         integer;
  v_unit_price       numeric(10,2);
  v_product_name     text;
  v_variant_label    text;
  v_image_url        text;
  v_is_active        boolean;
  v_stock_quantity   integer;
  v_in_stock_flag    boolean;
  v_region           text;
  v_size             text;
  v_subtotal         numeric(10,2) := 0;
  v_delivery_fee     numeric(10,2);
  v_discount         numeric(10,2) := 0;
  v_total            numeric(10,2);
  v_promo_row        promo_codes%ROWTYPE;
  v_promo_ok         boolean;
  v_order_id         uuid;
  v_order_number     text;
  v_item_count       integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to place an order.';
  END IF;

  IF p_payment_method NOT IN ('cod', 'bkash') THEN
    RAISE EXCEPTION 'Invalid payment method.';
  END IF;
  IF p_payment_method = 'bkash' AND (p_bkash_trx_id IS NULL OR trim(p_bkash_trx_id) = '') THEN
    RAISE EXCEPTION 'A bKash Transaction ID is required for bKash payment.';
  END IF;
  IF p_delivery_zone NOT IN ('inside_dhaka', 'outside_dhaka') THEN
    RAISE EXCEPTION 'Invalid delivery zone.';
  END IF;
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Full name is required.';
  END IF;
  IF p_address_line IS NULL OR trim(p_address_line) = '' THEN
    RAISE EXCEPTION 'Delivery address is required.';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Your cart is empty.';
  END IF;

  -- Authoritative delivery fee — app_settings, not whatever the browser
  -- displayed. Falls back to the same defaults DELIVERY_ZONES seeds with,
  -- in case Part 1's INSERT above was somehow skipped.
  SELECT COALESCE(
    (SELECT value::numeric FROM app_settings WHERE key = 'delivery_fee_' || p_delivery_zone),
    CASE WHEN p_delivery_zone = 'inside_dhaka' THEN 80 ELSE 130 END
  ) INTO v_delivery_fee;

  -- A temp table for the priced/validated lines — built before anything is
  -- written, so a failure partway through (e.g. item 3 of 5 out of stock)
  -- has touched no rows at all (the whole function is one transaction; a
  -- RAISE EXCEPTION rolls it all back regardless, this table is just the
  -- convenient place to accumulate rows for the final INSERT ... SELECT).
  CREATE TEMP TABLE IF NOT EXISTS _order_lines (
    product_id    uuid,
    variant_id    uuid,
    product_name  text,
    variant_label text,
    image_url     text,
    unit_price    numeric(10,2),
    quantity      integer,
    line_total    numeric(10,2)
  ) ON COMMIT DROP;
  -- TRUNCATE, not "DELETE FROM ... ;" — Supabase's safeupdate protection
  -- blocks any UPDATE/DELETE without a WHERE clause, even inside a
  -- SECURITY DEFINER function called over the RPC API. TRUNCATE isn't
  -- subject to that check and clears the table just the same.
  TRUNCATE _order_lines;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_count := v_item_count + 1;
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;
    v_quantity   := (v_item->>'quantity')::integer;

    IF v_product_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid item in your cart.';
    END IF;

    IF v_variant_id IS NOT NULL THEN
      SELECT
        CASE WHEN pv.offer_price IS NOT NULL AND pv.offer_price < pv.retail_price
             THEN pv.offer_price ELSE pv.retail_price END,
        pv.stock_quantity,
        pv.in_stock,
        pv.region,
        pv.size,
        COALESCE(pv.image_url, p.image_url),
        p.name,
        p.is_active
      INTO v_unit_price, v_stock_quantity, v_in_stock_flag, v_region, v_size,
           v_image_url, v_product_name, v_is_active
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_variant_id AND pv.product_id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the items in your cart is no longer available.';
      END IF;
      v_variant_label := NULLIF(trim(both ' ' from concat_ws(' · ', NULLIF(v_region, ''), NULLIF(v_size, ''))), '');
    ELSE
      SELECT
        CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price
             THEN p.offer_price ELSE p.retail_price END,
        p.stock_quantity,
        (p.stock_status <> 'out_of_stock'),
        p.image_url,
        p.name,
        p.is_active
      INTO v_unit_price, v_stock_quantity, v_in_stock_flag, v_image_url, v_product_name, v_is_active
      FROM products p
      WHERE p.id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the items in your cart is no longer available.';
      END IF;
      v_variant_label := NULL;
    END IF;

    IF NOT v_is_active THEN
      RAISE EXCEPTION '"%" is no longer available.', v_product_name;
    END IF;

    -- Tracked stock (stock_quantity set): must cover the requested
    -- quantity. Untracked (null): just needs the in-stock flag true.
    IF v_stock_quantity IS NOT NULL THEN
      IF v_stock_quantity < v_quantity THEN
        RAISE EXCEPTION 'Only % of "%" left in stock.', v_stock_quantity, v_product_name;
      END IF;
    ELSIF NOT v_in_stock_flag THEN
      RAISE EXCEPTION '"%" is out of stock.', v_product_name;
    END IF;

    INSERT INTO _order_lines (product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total)
    VALUES (v_product_id, v_variant_id, v_product_name, v_variant_label, v_image_url, v_unit_price, v_quantity, v_unit_price * v_quantity);

    v_subtotal := v_subtotal + (v_unit_price * v_quantity);

    -- Decrement only ever happens for tracked stock — see place_order's
    -- header comment / CLAUDE.md: an untracked item is only ever toggled
    -- by the admin, orders never touch it.
    IF v_stock_quantity IS NOT NULL THEN
      IF v_variant_id IS NOT NULL THEN
        UPDATE product_variants SET stock_quantity = stock_quantity - v_quantity WHERE id = v_variant_id;
      ELSE
        UPDATE products SET stock_quantity = stock_quantity - v_quantity WHERE id = v_product_id;
      END IF;
    END IF;
  END LOOP;

  -- Promo code: re-validated against the live row, discount computed from
  -- THIS read (not anything the browser sent), then claimed atomically via
  -- the same increment_promo_usage() every other path already uses — if
  -- someone else's order claimed the last use a moment ago, this order
  -- fails cleanly instead of honouring a discount that's no longer valid.
  IF p_promo_code IS NOT NULL AND trim(p_promo_code) <> '' THEN
    SELECT * INTO v_promo_row FROM promo_codes WHERE lower(code) = lower(trim(p_promo_code));
    IF NOT FOUND OR NOT v_promo_row.active
       OR (v_promo_row.max_uses IS NOT NULL AND v_promo_row.times_used >= v_promo_row.max_uses)
       OR (v_promo_row.expires_at IS NOT NULL AND v_promo_row.expires_at <= now()) THEN
      RAISE EXCEPTION 'This promo code is no longer valid.';
    END IF;

    v_discount := CASE WHEN v_promo_row.discount_type = 'percent'
                        THEN v_subtotal * v_promo_row.discount_amount / 100
                        ELSE v_promo_row.discount_amount END;
    v_discount := LEAST(GREATEST(v_discount, 0), v_subtotal);

    SELECT increment_promo_usage(p_promo_code) INTO v_promo_ok;
    IF NOT v_promo_ok THEN
      RAISE EXCEPTION 'This promo code is no longer valid.';
    END IF;
  END IF;

  v_total := GREATEST(v_subtotal + v_delivery_fee - v_discount, 0);
  v_order_number := 'NM-' || nextval('order_number_seq');

  INSERT INTO orders (
    order_number, customer_id, customer_name, customer_phone,
    division, district, thana, address_line,
    delivery_zone, delivery_fee, subtotal, discount,
    promo_code, total, payment_method, bkash_trx_id, bkash_sender,
    payment_status, customer_note
  ) VALUES (
    v_order_number, v_uid, trim(p_full_name), p_phone,
    p_division, p_district, p_thana, trim(p_address_line),
    p_delivery_zone, v_delivery_fee, v_subtotal, v_discount,
    NULLIF(trim(COALESCE(p_promo_code, '')), ''), v_total, p_payment_method,
    NULLIF(trim(COALESCE(p_bkash_trx_id, '')), ''), NULLIF(trim(COALESCE(p_bkash_sender, '')), ''),
    CASE WHEN p_payment_method = 'bkash' THEN 'pending_verification' ELSE 'unpaid' END,
    NULLIF(trim(COALESCE(p_customer_note, '')), '')
  )
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total)
  SELECT v_order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total
  FROM _order_lines;

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by)
  VALUES (v_order_id, NULL, 'pending', v_uid);

  RETURN QUERY SELECT v_order_id, v_order_number;
END;
$$;

GRANT EXECUTE ON FUNCTION place_order(jsonb, text, text, text, text, text, text, text, text, text, text, text, text) TO authenticated;
