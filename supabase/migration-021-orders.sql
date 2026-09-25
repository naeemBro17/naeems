-- ============================================================
-- Naeem's Price Hub — Migration 021: real on-site orders (Batch 18)
-- Run this in the Supabase SQL Editor after migration-020. Safe to re-run.
--
-- Adds orders / order_items / order_status_history, and two
-- SECURITY DEFINER functions that are the ONLY way rows in those tables are
-- ever written by a customer session:
--   place_order()  — creates an order. Re-reads every price and stock level
--                     from the database itself; a tampered price or an
--                     out-of-stock item sent from the browser cannot get
--                     an order created.
--   cancel_order() — lets a customer cancel their OWN order while it is
--                     still 'pending' (or an admin cancel a pending/
--                     confirmed one), restoring any stock it had reserved.
--
-- Also moves delivery zone fees into app_settings (previously only in
-- src/lib/deliveryZones.ts) so the database and the frontend share one
-- source of truth instead of the frontend just trusting its own copy.
-- ============================================================

-- ---------- PART 1: delivery fee + bKash number settings ----------
-- Seeded to match the fees already hardcoded in DELIVERY_ZONES
-- (features/checkout/types.ts) so nothing changes until Naeem edits them.
INSERT INTO app_settings (key, value) VALUES
  ('delivery_fee_inside_dhaka', '80'),
  ('delivery_fee_outside_dhaka', '130'),
  ('shop_bkash_number', '')
ON CONFLICT (key) DO NOTHING;

-- ---------- PART 2: orders ----------
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1001;

CREATE TABLE IF NOT EXISTS orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- e.g. "NM-1001" — generated from order_number_seq, never client-supplied,
  -- so two orders can never collide even placed in the same instant.
  order_number    text NOT NULL UNIQUE,
  customer_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Customer + address snapshot AT ORDER TIME — a later profile edit must
  -- never change what a past order says was shipped where.
  customer_name   text NOT NULL,
  customer_phone  text NOT NULL,
  division        text NOT NULL,
  district        text NOT NULL,
  thana           text NOT NULL,
  address_line    text NOT NULL,

  delivery_zone   text NOT NULL CHECK (delivery_zone IN ('inside_dhaka', 'outside_dhaka')),
  delivery_fee    numeric(10,2) NOT NULL CHECK (delivery_fee >= 0),
  subtotal        numeric(10,2) NOT NULL CHECK (subtotal >= 0),
  discount        numeric(10,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  promo_code      text,
  total           numeric(10,2) NOT NULL CHECK (total >= 0),

  payment_method  text NOT NULL CHECK (payment_method IN ('cod', 'bkash')),
  bkash_trx_id    text,
  bkash_sender    text,
  payment_status  text NOT NULL DEFAULT 'unpaid'
                    CHECK (payment_status IN ('unpaid', 'pending_verification', 'paid')),

  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled')),
  tracking_number text,
  customer_note   text,
  admin_note      text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created  ON orders(created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- SET NULL (not CASCADE): deleting a product later must never delete the
  -- historical line item — only the live FK link, the snapshot text stays.
  product_id    uuid REFERENCES products(id) ON DELETE SET NULL,
  variant_id    uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  product_name  text NOT NULL,
  variant_label text,
  image_url     text,
  unit_price    numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  quantity      integer NOT NULL CHECK (quantity > 0),
  line_total    numeric(10,2) NOT NULL CHECK (line_total >= 0)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  old_status  text,
  new_status  text NOT NULL,
  changed_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id);

-- ---------- PART 3: RLS ----------
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- orders: a customer reads only their own; admin reads all. Nobody ever
  -- gets an INSERT or UPDATE policy here — place_order()/cancel_order()
  -- (SECURITY DEFINER, own the table) are the only write path for a
  -- customer. Admin's own UPDATE policy below is for the admin Orders tab
  -- (status changes, tracking number, notes) — same pattern as
  -- products_admin_all elsewhere in this schema.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'orders' AND policyname = 'orders_read_own'
  ) THEN
    CREATE POLICY "orders_read_own"
      ON orders FOR SELECT TO authenticated
      USING (customer_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'orders' AND policyname = 'orders_admin_read_all'
  ) THEN
    CREATE POLICY "orders_admin_read_all"
      ON orders FOR SELECT TO authenticated
      USING (is_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'orders' AND policyname = 'orders_admin_update'
  ) THEN
    CREATE POLICY "orders_admin_update"
      ON orders FOR UPDATE TO authenticated
      USING (is_admin())
      WITH CHECK (is_admin());
  END IF;

  -- order_items: visible to whoever can see the parent order.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'order_items' AND policyname = 'order_items_read_via_order'
  ) THEN
    CREATE POLICY "order_items_read_via_order"
      ON order_items FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM orders o
          WHERE o.id = order_items.order_id
            AND (o.customer_id = auth.uid() OR is_admin())
        )
      );
  END IF;

  -- order_status_history: same visibility rule as its order.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'order_status_history' AND policyname = 'order_status_history_read_via_order'
  ) THEN
    CREATE POLICY "order_status_history_read_via_order"
      ON order_status_history FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM orders o
          WHERE o.id = order_status_history.order_id
            AND (o.customer_id = auth.uid() OR is_admin())
        )
      );
  END IF;
END $$;

-- Explicit grants — this project's default privileges are unreliable (see
-- migration-011's header). RLS above still gates every row; these just let
-- the SELECT statements run at all. No INSERT/UPDATE/DELETE grant for
-- anon/authenticated on any of the three tables — every write goes through
-- a SECURITY DEFINER function instead.
REVOKE ALL ON orders, order_items, order_status_history FROM anon, authenticated;
GRANT SELECT ON orders, order_items, order_status_history TO authenticated;
-- Admin's status/tracking/note edits use a normal UPDATE from the admin
-- panel (gated by orders_admin_update above), so authenticated needs the
-- column-level UPDATE grant too — customers just never pass the RLS check.
GRANT UPDATE (status, payment_status, tracking_number, admin_note, updated_at) ON orders TO authenticated;

-- ---------- PART 4: place_order() ----------
-- p_items shape: '[{"product_id":"...","variant_id":"..."|null,"quantity":2}, ...]'
-- Every price and stock check re-reads the database; nothing from the
-- caller's own arithmetic is trusted except which products/variants and how
-- many of each.
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
  DELETE FROM _order_lines;

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

-- ---------- PART 5: cancel_order() ----------
-- Customers may cancel only their OWN order, only while 'pending'. Admin
-- may cancel a 'pending' or 'confirmed' order (e.g. the customer called
-- asking to cancel after Naeem already confirmed it). Restores any stock
-- the order had decremented — skipped for a since-deleted product/variant,
-- and for lines that were never tracked in the first place.
CREATE OR REPLACE FUNCTION cancel_order(p_order_id uuid, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_order orders%ROWTYPE;
  v_line  record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  IF v_order.customer_id <> v_uid AND NOT is_admin() THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  IF is_admin() THEN
    IF v_order.status NOT IN ('pending', 'confirmed') THEN
      RAISE EXCEPTION 'Only a pending or confirmed order can be cancelled.';
    END IF;
  ELSE
    IF v_order.status <> 'pending' THEN
      RAISE EXCEPTION 'This order can no longer be cancelled — please contact us.';
    END IF;
  END IF;

  FOR v_line IN SELECT * FROM order_items WHERE order_id = p_order_id
  LOOP
    IF v_line.variant_id IS NOT NULL THEN
      UPDATE product_variants SET stock_quantity = stock_quantity + v_line.quantity
        WHERE id = v_line.variant_id AND stock_quantity IS NOT NULL;
    ELSIF v_line.product_id IS NOT NULL THEN
      UPDATE products SET stock_quantity = stock_quantity + v_line.quantity
        WHERE id = v_line.product_id AND stock_quantity IS NOT NULL;
    END IF;
  END LOOP;

  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_order.status, 'cancelled', v_uid, p_note);

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_order(uuid, text) TO authenticated;

-- ---------- PART 6: admin status-change helper ----------
-- A thin wrapper the admin Orders tab uses instead of a raw UPDATE, so every
-- status change is guaranteed to also write a history row in the same
-- transaction (a raw UPDATE through orders_admin_update could otherwise
-- change status without anyone recording when/why).
CREATE OR REPLACE FUNCTION admin_set_order_status(p_order_id uuid, p_new_status text, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_status text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_new_status NOT IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid status.';
  END IF;

  SELECT status INTO v_old_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  -- Cancelling here (rather than via cancel_order) still restores stock,
  -- so admin has one consistent way to cancel regardless of which button
  -- they used.
  IF p_new_status = 'cancelled' AND v_old_status <> 'cancelled' THEN
    PERFORM cancel_order(p_order_id, p_note);
    RETURN true;
  END IF;

  UPDATE orders SET status = p_new_status, updated_at = now() WHERE id = p_order_id;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_old_status, p_new_status, auth.uid(), p_note);

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_set_order_status(uuid, text, text) TO authenticated;

-- ============================================================
-- ---------- Verify (run as a real logged-in customer session, and
-- separately as admin — see reports/batch-18.txt Part "Security") ----------
--
-- As a real customer:
--   1. SELECT place_order('[{"product_id":"<a real active product id>",
--        "variant_id":null,"quantity":1}]'::jsonb, 'Test','01700000000',
--        'Dhaka','Dhaka','Gulshan','Test address','inside_dhaka','cod');
--      → succeeds, returns an order_number like NM-1001.
--   2. Repeat step 1 but with a product_id/quantity that exceeds its
--      current stock_quantity → must fail with a friendly "Only N left" error.
--   3. UPDATE orders SET total = 1 WHERE id = '<the order from step 1>';
--      → must fail (no UPDATE policy grants this to a non-admin).
--   4. SELECT * FROM orders WHERE customer_id <> auth.uid();
--      → must return zero rows.
--   5. SELECT cancel_order('<the order from step 1>');
--      → succeeds while status is still 'pending'; stock_quantity (if that
--        product tracks it) goes back up by 1.
-- ============================================================
