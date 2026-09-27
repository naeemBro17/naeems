-- ============================================================
-- Naeem's Price Hub — Migration 028: manual orders (Batch 22 Parts 1-3)
-- Run this in the Supabase SQL Editor after migration-027. Safe to re-run.
--
-- Most of Naeem's real orders come in over Facebook/WhatsApp, not the
-- website — he types those into Admin -> Orders himself. He also sells to
-- family at a cut price, or gives items free. This migration lets a manual
-- order live in the exact same `orders`/`order_items` tables as a real
-- website order (same invoice, same Steadfast button, same status flow),
-- while keeping an honest record of what it actually cost him:
--   - orders.source records where the order came from (web/facebook/
--     whatsapp/phone/shop/family/other).
--   - orders.customer_id becomes NULLABLE — a manual order has no online
--     account unless Naeem explicitly links one himself (see
--     admin_create_order's p_linked_customer_id — never inferred from a
--     typed phone number matching, by design: phone numbers aren't
--     verified, so a typed number could belong to someone else).
--   - order_items.list_price is the product/variant's REAL price at order
--     time (always re-read from the database, never trusted from the
--     browser); unit_price (already existed) is what Naeem actually
--     charged. list_price - unit_price is always the exact discount given,
--     per line, never guessed.
--   - order_items.reason / orders.discount_reason record WHY a price was
--     cut (family, gift, free sample, personal use, promotion, other).
--   - orders.list_value / orders.free_value are per-order totals of the
--     above, kept on the order row so the admin Orders tab's monthly
--     summary card doesn't need to re-fetch every order's line items.
--   - admin_create_order() is the one and only way a manual order is
--     created — SECURITY DEFINER, is_admin()-gated, re-reads every real
--     price/stock from the database exactly like place_order() does, and
--     never fires the Pixel/GA4/Telegram "new order" alert (Naeem placed it
--     himself; those are for orders that surprise him).
-- ============================================================

-- ---------- PART 1: orders — source, nullable customer_id, discount/value columns ----------

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'web';

DO $$
BEGIN
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check;
  ALTER TABLE orders ADD CONSTRAINT orders_source_check
    CHECK (source IN ('web', 'facebook', 'whatsapp', 'phone', 'shop', 'family', 'other'));
END $$;

-- A manual order has no online account unless Naeem explicitly links one —
-- see admin_create_order below and CLAUDE.md's privacy rule. Existing
-- website orders keep their real customer_id untouched; this only relaxes
-- the constraint so a NULL becomes possible going forward.
ALTER TABLE orders ALTER COLUMN customer_id DROP NOT NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS discount_reason text,
  ADD COLUMN IF NOT EXISTS discount_note text,
  ADD COLUMN IF NOT EXISTS list_value numeric(10,2) NOT NULL DEFAULT 0 CHECK (list_value >= 0),
  ADD COLUMN IF NOT EXISTS free_value numeric(10,2) NOT NULL DEFAULT 0 CHECK (free_value >= 0);

DO $$
BEGIN
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_discount_reason_check;
  ALTER TABLE orders ADD CONSTRAINT orders_discount_reason_check
    CHECK (discount_reason IS NULL OR discount_reason IN
      ('family', 'gift', 'free_sample', 'personal_use', 'promotion', 'other'));
END $$;

-- Every order placed before this migration was full-price with no line
-- discounts, so its "value at list price" is simply its own subtotal, and
-- it gave away nothing free. Only rows still at the just-added default (0)
-- need this — safe to re-run.
UPDATE orders SET list_value = subtotal WHERE list_value = 0 AND subtotal > 0;

-- Delivery zone gains a third option: hand-delivered by Naeem himself, no
-- courier, no fee. Website checkout never offers this — only the manual
-- order form does.
DO $$
BEGIN
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_zone_check;
  ALTER TABLE orders ADD CONSTRAINT orders_delivery_zone_check
    CHECK (delivery_zone IN ('inside_dhaka', 'outside_dhaka', 'hand_delivered'));
END $$;

-- Payment method gains two manual-only options: 'cash' (Naeem already
-- collected cash before typing the order in) and 'due' (বাকি — customer
-- owes it, e.g. family). Website checkout still only ever sends 'cod'/'bkash'.
DO $$
BEGIN
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
  ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
    CHECK (payment_method IN ('cod', 'bkash', 'cash', 'due'));
END $$;

-- ---------- PART 2: order_items — list price + discount reason ----------

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS list_price numeric(10,2) NOT NULL DEFAULT 0 CHECK (list_price >= 0),
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS reason_note text;

DO $$
BEGIN
  ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_reason_check;
  ALTER TABLE order_items ADD CONSTRAINT order_items_reason_check
    CHECK (reason IS NULL OR reason IN
      ('family', 'gift', 'free_sample', 'personal_use', 'promotion', 'other'));
END $$;

-- Every line item placed before this migration was sold at its own real
-- price (no manual override existed yet) — list_price equals unit_price.
UPDATE order_items SET list_price = unit_price WHERE list_price = 0;

-- ---------- PART 3: fix cancel_order() for a nullable customer_id ----------
-- Re-created (not just left as-is) because migration-021's ownership check
-- `v_order.customer_id <> v_uid` is NULL, not true, when customer_id is
-- NULL (a manual, unlinked order) — PL/pgSQL treats a NULL IF condition as
-- false, which would have let this fall through to the "not admin" branch
-- instead of the intended "not yours" rejection. Only this one line
-- changes; everything else is identical to migration-021.
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

  IF (v_order.customer_id IS NULL OR v_order.customer_id <> v_uid) AND NOT is_admin() THEN
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

-- ---------- PART 4: admin_create_order() ----------
-- p_items shape: '[{"product_id":"...", "variant_id":"..."|null,
--   "quantity":2, "sold_price":700|null, "reason":"family"|null,
--   "reason_note":"..."|null}, ...]'
-- sold_price null means "charge the real current price" (no discount).
-- Every price/stock check re-reads the database, exactly like place_order()
-- — sold_price is the one deliberate exception, because unlike a customer
-- typing their own cart, this is Naeem himself, already authenticated as
-- admin, intentionally choosing to sell below list price. The list price
-- is still always read fresh from the database, never trusted from the
-- browser, so the discount given is always known exactly.
CREATE OR REPLACE FUNCTION admin_create_order(
  p_source              text,
  p_items               jsonb,
  p_full_name           text,
  p_phone               text,
  p_division            text,
  p_district            text,
  p_thana               text,
  p_address_line        text,
  p_delivery_zone       text,
  p_delivery_fee        numeric,
  p_order_discount      numeric DEFAULT 0,
  p_discount_reason     text DEFAULT NULL,
  p_discount_note       text DEFAULT NULL,
  p_payment_method      text DEFAULT 'cod',
  p_bkash_trx_id        text DEFAULT NULL,
  p_bkash_sender        text DEFAULT NULL,
  p_linked_customer_id  uuid DEFAULT NULL,
  p_mark_delivered      boolean DEFAULT false,
  p_admin_note          text DEFAULT NULL,
  p_allow_negative_stock boolean DEFAULT false
)
RETURNS TABLE (order_id uuid, order_number text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item             jsonb;
  v_product_id       uuid;
  v_variant_id       uuid;
  v_quantity         integer;
  v_sold_price_in    numeric(10,2);
  v_list_price       numeric(10,2);
  v_unit_price       numeric(10,2);
  v_product_name     text;
  v_variant_label    text;
  v_image_url        text;
  v_is_active        boolean;
  v_stock_quantity   integer;
  v_region           text;
  v_size             text;
  v_reason           text;
  v_reason_note      text;
  v_subtotal         numeric(10,2) := 0;
  v_list_value       numeric(10,2) := 0;
  v_free_value       numeric(10,2) := 0;
  v_delivery_fee     numeric(10,2);
  v_discount         numeric(10,2);
  v_total            numeric(10,2);
  v_order_id         uuid;
  v_order_number     text;
  v_item_count       integer := 0;
  v_warnings         jsonb := '[]'::jsonb;
  v_payment_status   text;
  v_initial_status   text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  IF p_source NOT IN ('web', 'facebook', 'whatsapp', 'phone', 'shop', 'family', 'other') THEN
    RAISE EXCEPTION 'Invalid order source.';
  END IF;
  IF p_delivery_zone NOT IN ('inside_dhaka', 'outside_dhaka', 'hand_delivered') THEN
    RAISE EXCEPTION 'Invalid delivery zone.';
  END IF;
  IF p_payment_method NOT IN ('cod', 'bkash', 'cash', 'due') THEN
    RAISE EXCEPTION 'Invalid payment method.';
  END IF;
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Customer name is required.';
  END IF;
  IF p_address_line IS NULL OR trim(p_address_line) = '' THEN
    RAISE EXCEPTION 'Delivery address is required.';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one item.';
  END IF;

  -- Hand-delivered always means zero courier fee, regardless of what the
  -- browser sent — never a manual mistake or a stray override away from
  -- the real rule.
  v_delivery_fee := CASE WHEN p_delivery_zone = 'hand_delivered' THEN 0
                          ELSE GREATEST(COALESCE(p_delivery_fee, 0), 0) END;
  v_discount := GREATEST(COALESCE(p_order_discount, 0), 0);

  CREATE TEMP TABLE IF NOT EXISTS _admin_order_lines (
    product_id        uuid,
    variant_id        uuid,
    product_name      text,
    variant_label     text,
    image_url         text,
    list_price        numeric(10,2),
    unit_price        numeric(10,2),
    quantity          integer,
    line_total        numeric(10,2),
    reason            text,
    reason_note       text,
    is_tracked_stock  boolean,
    stock_available   integer
  ) ON COMMIT DROP;
  TRUNCATE _admin_order_lines;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_count := v_item_count + 1;
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;
    v_quantity   := (v_item->>'quantity')::integer;
    v_sold_price_in := NULLIF(v_item->>'sold_price', '')::numeric;
    v_reason      := NULLIF(trim(COALESCE(v_item->>'reason', '')), '');
    v_reason_note := NULLIF(trim(COALESCE(v_item->>'reason_note', '')), '');

    IF v_reason IS NOT NULL AND v_reason NOT IN
      ('family', 'gift', 'free_sample', 'personal_use', 'promotion', 'other') THEN
      v_reason := 'other';
    END IF;

    IF v_product_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid item at position %.', v_item_count;
    END IF;

    IF v_variant_id IS NOT NULL THEN
      SELECT
        CASE WHEN pv.offer_price IS NOT NULL AND pv.offer_price < pv.retail_price
             THEN pv.offer_price ELSE pv.retail_price END,
        pv.stock_quantity, pv.region, pv.size,
        COALESCE(pv.image_url, p.image_url), p.name, p.is_active
      INTO v_list_price, v_stock_quantity, v_region, v_size,
           v_image_url, v_product_name, v_is_active
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_variant_id AND pv.product_id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the chosen items no longer exists.';
      END IF;
      v_variant_label := NULLIF(trim(both ' ' from concat_ws(' · ', NULLIF(v_region, ''), NULLIF(v_size, ''))), '');
    ELSE
      SELECT
        CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price
             THEN p.offer_price ELSE p.retail_price END,
        p.stock_quantity, p.image_url, p.name, p.is_active
      INTO v_list_price, v_stock_quantity, v_image_url, v_product_name, v_is_active
      FROM products p
      WHERE p.id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the chosen items no longer exists.';
      END IF;
      v_variant_label := NULL;
    END IF;

    IF NOT v_is_active THEN
      RAISE EXCEPTION '"%" is not active — reactivate it first if you really want to sell it.', v_product_name;
    END IF;

    -- sold_price null (admin left the line at its default) => charge the
    -- real list price, i.e. no discount at all.
    v_unit_price := COALESCE(v_sold_price_in, v_list_price);
    IF v_unit_price < 0 THEN
      RAISE EXCEPTION 'Price cannot be negative.';
    END IF;
    -- A cut price with no reason chosen still gets recorded as "other"
    -- rather than blocking the whole order over a missing UI selection —
    -- the exact ৳ discount (list_price - unit_price) is never lost either way.
    IF v_unit_price < v_list_price AND v_reason IS NULL THEN
      v_reason := 'other';
    END IF;

    IF v_stock_quantity IS NOT NULL AND v_stock_quantity < v_quantity THEN
      v_warnings := v_warnings || jsonb_build_object(
        'product_name', v_product_name,
        'variant_label', v_variant_label,
        'available', v_stock_quantity,
        'requested', v_quantity
      );
    END IF;

    INSERT INTO _admin_order_lines (
      product_id, variant_id, product_name, variant_label, image_url,
      list_price, unit_price, quantity, line_total, reason, reason_note,
      is_tracked_stock, stock_available
    ) VALUES (
      v_product_id, v_variant_id, v_product_name, v_variant_label, v_image_url,
      v_list_price, v_unit_price, v_quantity, v_unit_price * v_quantity, v_reason, v_reason_note,
      (v_stock_quantity IS NOT NULL), v_stock_quantity
    );

    v_subtotal   := v_subtotal + (v_unit_price * v_quantity);
    v_list_value := v_list_value + (v_list_price * v_quantity);
    IF v_unit_price = 0 THEN
      v_free_value := v_free_value + (v_list_price * v_quantity);
    END IF;
  END LOOP;

  -- Nothing has been written yet (no stock decremented, no order inserted)
  -- — a stock shortfall found above is reported back to the admin UI as a
  -- warning list, not silently rejected or silently allowed. Naeem taps
  -- "continue anyway" (p_allow_negative_stock := true) to resubmit the
  -- exact same call and let stock go negative on purpose.
  IF jsonb_array_length(v_warnings) > 0 AND NOT p_allow_negative_stock THEN
    RAISE EXCEPTION 'STOCK_WARNING:%', v_warnings::text;
  END IF;

  v_total := GREATEST(v_subtotal + v_delivery_fee - v_discount, 0);

  -- Payment status is derived here, not trusted from the browser: Naeem
  -- picks a payment METHOD (what happened), the database decides the
  -- resulting STATUS.
  v_payment_status := CASE
    WHEN p_payment_method = 'cash' THEN 'paid'
    WHEN p_payment_method = 'bkash' AND p_bkash_trx_id IS NOT NULL AND trim(p_bkash_trx_id) <> '' THEN 'paid'
    WHEN p_payment_method = 'bkash' THEN 'pending_verification'
    ELSE 'unpaid' -- 'cod' (collected on delivery) and 'due' (বাকি)
  END;

  v_initial_status := CASE WHEN p_mark_delivered THEN 'delivered' ELSE 'confirmed' END;

  INSERT INTO orders (
    order_number, customer_id, source, customer_name, customer_phone,
    division, district, thana, address_line,
    delivery_zone, delivery_fee, subtotal, discount, discount_reason, discount_note,
    list_value, free_value, total,
    payment_method, bkash_trx_id, bkash_sender, payment_status,
    status, admin_note
  ) VALUES (
    'NM-' || nextval('order_number_seq'), p_linked_customer_id, p_source, trim(p_full_name), COALESCE(p_phone, ''),
    COALESCE(p_division, ''), COALESCE(p_district, ''), COALESCE(p_thana, ''), trim(p_address_line),
    p_delivery_zone, v_delivery_fee, v_subtotal, v_discount,
    NULLIF(trim(COALESCE(p_discount_reason, '')), ''), NULLIF(trim(COALESCE(p_discount_note, '')), ''),
    v_list_value, v_free_value, v_total,
    p_payment_method, NULLIF(trim(COALESCE(p_bkash_trx_id, '')), ''), NULLIF(trim(COALESCE(p_bkash_sender, '')), ''),
    v_payment_status,
    v_initial_status, NULLIF(trim(COALESCE(p_admin_note, '')), '')
  )
  RETURNING id, order_number INTO v_order_id, v_order_number;

  INSERT INTO order_items (
    order_id, product_id, variant_id, product_name, variant_label, image_url,
    list_price, unit_price, quantity, line_total, reason, reason_note
  )
  SELECT
    v_order_id, product_id, variant_id, product_name, variant_label, image_url,
    list_price, unit_price, quantity, line_total, reason, reason_note
  FROM _admin_order_lines;

  -- Only now, after everything above has succeeded, does stock actually
  -- move — same "tracked stock only" rule as place_order(), but allowed to
  -- go negative when the admin confirmed that on purpose.
  UPDATE product_variants pv SET stock_quantity = pv.stock_quantity - l.quantity
    FROM _admin_order_lines l
    WHERE l.variant_id IS NOT NULL AND l.is_tracked_stock AND pv.id = l.variant_id;
  UPDATE products p SET stock_quantity = p.stock_quantity - l.quantity
    FROM _admin_order_lines l
    WHERE l.variant_id IS NULL AND l.is_tracked_stock AND p.id = l.product_id;

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (
    v_order_id, NULL, v_initial_status, auth.uid(),
    format('Entered manually by admin — source: %s', p_source)
  );

  RETURN QUERY SELECT v_order_id, v_order_number;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_create_order(
  text, jsonb, text, text, text, text, text, text, text, numeric,
  numeric, text, text, text, text, text, uuid, boolean, text, boolean
) TO authenticated;

-- ============================================================
-- ---------- Verify ----------
-- 1. As a NON-admin session:
--      SELECT admin_create_order('phone'::text, '[]'::jsonb, 'x','x','x','x','x','x','inside_dhaka',70);
--      → must fail with 'Not authorized.' (before it even reaches the empty-items check).
-- 2. As admin, with a real active product id that has stock_quantity >= 1:
--      SELECT admin_create_order('facebook',
--        jsonb_build_array(jsonb_build_object('product_id','<id>','variant_id',null,'quantity',1)),
--        'Test Customer','01700000000','Dhaka','Dhaka','Gulshan','Test address',
--        'inside_dhaka', 70);
--      → succeeds, returns an order_number like NM-1010; orders.source = 'facebook';
--        orders.customer_id IS NULL (no account linked).
-- 3. Same call again but with "sold_price":0 added to the item and no "reason"
--    → order_items.reason becomes 'other' automatically; orders.free_value
--      equals that line's list_price * quantity.
-- 4. Same call with a quantity greater than the product's stock_quantity,
--    p_allow_negative_stock left at its default (false)
--      → fails with a message starting 'STOCK_WARNING:' followed by a JSON
--        array — the admin UI parses this to show "only N left, continue
--        anyway?" rather than a raw error.
-- 5. Repeat step 4 with the 21st positional argument (p_allow_negative_stock)
--    set to true → succeeds; that product's stock_quantity goes negative.
-- 6. SELECT cancel_order('<the order id from step 2>'); as the SAME admin
--    session → succeeds (admin can cancel a manual order same as any other),
--    stock is restored.
-- ============================================================
