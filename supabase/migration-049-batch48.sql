-- =====================================================================
-- Batch 48 — Nagad as a payment method + the advance-payment discount
--
-- Paste the whole file into the Supabase SQL Editor and press Run.
-- It is safe to run more than once. It does not change any existing
-- order, payment or money amount.
--
--   1. orders: 'nagad' is allowed as an order's payment method, and three
--      new columns keep the advance-payment discount of each order
--      (the amount, and the rule used: percent / fixed and its value).
--   2. The setting (On, Percent, 0.5) — changed in Admin -> Settings ->
--      Advance payment discount. Only the Super Admin can change it
--      (app_settings can only be written by is_admin()).
--   3. A "Nagad" money account, so Nagad money lands in its own wallet in
--      Money (today a Nagad payment would be counted in Cash).
--   4. place_order: accepts Nagad, and works out the advance discount
--      itself from the setting (never from the browser).
--   5. A confirmed Nagad advance is recorded as a Nagad payment.
--   6. New order: an order fully paid by Nagad is saved as a Nagad order.
--   7. Edit order: the advance part of the discount never gets a
--      "reason", and never stays larger than the whole discount.
--   8. admin_set_order_payment_method — Edit order can change Cash on
--      Delivery / bKash / Nagad. bKash or Nagad -> Cash on Delivery
--      removes the advance discount; bKash <-> Nagad keeps it.
--
-- How the discount is stored: orders.discount stays the WHOLE discount
-- (promo code + advance payment), so every total, profit, Money and
-- report figure keeps working exactly as today and treats it like the
-- promo discount. orders.advance_discount says how much of it is the
-- advance-payment part.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. orders: Nagad + the advance-payment discount columns
-- ---------------------------------------------------------------------
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method = ANY (ARRAY['cod'::text, 'bkash'::text, 'nagad'::text, 'cash'::text, 'due'::text]));

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS advance_discount numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS advance_discount_type text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS advance_discount_value numeric(10,2);

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_advance_discount_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_advance_discount_check
  CHECK (advance_discount >= 0
         AND (advance_discount_type IS NULL OR advance_discount_type IN ('percent', 'fixed')));

COMMENT ON COLUMN public.orders.advance_discount IS
  'Batch 48: the part of orders.discount given for paying in advance (bKash / Nagad). 0 = none.';
COMMENT ON COLUMN public.orders.advance_discount_type IS
  'Batch 48: the rule used when the order was placed: percent or fixed. NULL = no advance discount.';
COMMENT ON COLUMN public.orders.advance_discount_value IS
  'Batch 48: the rule value used (0.5 = 0.5 percent, or taka for fixed). Later setting changes never change it.';

-- ---------------------------------------------------------------------
-- 2. The setting (defaults: On, Percent, 0.5)
-- ---------------------------------------------------------------------
INSERT INTO public.app_settings (key, value) VALUES
  ('advance_discount_enabled', 'true'),
  ('advance_discount_type', 'percent'),
  ('advance_discount_value', '0.5')
ON CONFLICT (key) DO NOTHING;

-- The rule as place_order and the checkout read it. A broken value counts
-- as Off, so a typo in the setting can never stop bKash / Nagad orders.
CREATE OR REPLACE FUNCTION public.advance_discount_amount(p_method text, p_base numeric)
  RETURNS TABLE(amount numeric, rule_type text, rule_value numeric)
  LANGUAGE plpgsql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_on    text;
  v_type  text;
  v_raw   text;
  v_value numeric;
  v_base  numeric := GREATEST(COALESCE(p_base, 0), 0);
BEGIN
  IF p_method IS NULL OR p_method NOT IN ('bkash', 'nagad') THEN
    RETURN QUERY SELECT 0::numeric, NULL::text, NULL::numeric;
    RETURN;
  END IF;
  SELECT value INTO v_on FROM app_settings WHERE key = 'advance_discount_enabled';
  SELECT value INTO v_type FROM app_settings WHERE key = 'advance_discount_type';
  SELECT trim(value) INTO v_raw FROM app_settings WHERE key = 'advance_discount_value';
  IF COALESCE(v_on, '') <> 'true' OR v_type IS NULL OR v_type NOT IN ('percent', 'fixed')
     OR v_raw IS NULL OR v_raw !~ '^[0-9]+(\.[0-9]+)?$' THEN
    RETURN QUERY SELECT 0::numeric, NULL::text, NULL::numeric;
    RETURN;
  END IF;
  v_value := round(v_raw::numeric, 2);
  IF v_value <= 0 OR (v_type = 'percent' AND v_value > 100) THEN
    RETURN QUERY SELECT 0::numeric, NULL::text, NULL::numeric;
    RETURN;
  END IF;
  IF v_type = 'percent' THEN
    -- Rounded to the nearest taka.
    RETURN QUERY SELECT LEAST(round(v_base * v_value / 100), v_base), v_type, v_value;
  ELSE
    RETURN QUERY SELECT LEAST(v_value, v_base), v_type, v_value;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.advance_discount_amount(text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.advance_discount_amount(text, numeric) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. A Nagad money account (Nagad money lands in its own wallet)
-- ---------------------------------------------------------------------
INSERT INTO public.money_accounts (name, kind, payment_method, sort_order)
SELECT 'Nagad', 'nagad', 'nagad', 4
WHERE NOT EXISTS (SELECT 1 FROM public.money_accounts WHERE payment_method = 'nagad');

-- ---------------------------------------------------------------------
-- 4. place_order: Nagad + the advance-payment discount
--
-- Same arguments as before. It now also returns the saved total and both
-- discounts, so "Order placed" shows exactly what was saved. The return
-- shape changes, so the old function is dropped first (same transaction).
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.place_order(jsonb, text, text, text, text, text, text, text, text, text, text, text, text);

CREATE FUNCTION public.place_order(p_items jsonb, p_full_name text, p_phone text, p_division text, p_district text, p_thana text, p_address_line text, p_delivery_zone text, p_payment_method text, p_bkash_trx_id text DEFAULT NULL::text, p_bkash_sender text DEFAULT NULL::text, p_promo_code text DEFAULT NULL::text, p_customer_note text DEFAULT NULL::text)
 RETURNS TABLE(order_id uuid, order_number text, total numeric, discount numeric, advance_discount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_advance          numeric(10,2) := 0;
  v_advance_type     text;
  v_advance_value    numeric(10,2);
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

  IF p_payment_method NOT IN ('cod', 'bkash', 'nagad') THEN
    RAISE EXCEPTION 'Invalid payment method.';
  END IF;
  IF p_payment_method = 'bkash' AND (p_bkash_trx_id IS NULL OR trim(p_bkash_trx_id) = '') THEN
    RAISE EXCEPTION 'A bKash Transaction ID is required for bKash payment.';
  END IF;
  IF p_payment_method = 'nagad' AND (p_bkash_trx_id IS NULL OR trim(p_bkash_trx_id) = '') THEN
    RAISE EXCEPTION 'A Nagad Transaction ID is required for Nagad payment.';
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

  SELECT COALESCE(
    (SELECT value::numeric FROM app_settings WHERE key = 'delivery_fee_' || p_delivery_zone),
    CASE WHEN p_delivery_zone = 'inside_dhaka' THEN 80 ELSE 130 END
  ) INTO v_delivery_fee;

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
  TRUNCATE _order_lines;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_count := v_item_count + 1;
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;
    -- Batch 45 Part 3: the product's own size is picked as an option whose
    -- id is the product's id. It is the product row, not an option row.
    IF v_variant_id = v_product_id THEN
      v_variant_id := NULL;
    END IF;
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

    IF v_stock_quantity IS NOT NULL THEN
      IF v_variant_id IS NOT NULL THEN
        UPDATE product_variants SET stock_quantity = stock_quantity - v_quantity WHERE id = v_variant_id;
      ELSE
        UPDATE products SET stock_quantity = stock_quantity - v_quantity WHERE id = v_product_id;
      END IF;
    END IF;
  END LOOP;

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

  -- Batch 48: paying in advance (bKash / Nagad) takes the advance discount
  -- off the products after the promo code. Delivery is never discounted.
  -- Worked out here from the setting; the browser sends no amount. It is
  -- not a promo code and never touches times_used.
  SELECT a.amount, a.rule_type, a.rule_value
    INTO v_advance, v_advance_type, v_advance_value
    FROM advance_discount_amount(p_payment_method, v_subtotal - v_discount) a;
  v_advance := COALESCE(v_advance, 0);
  IF v_advance <= 0 THEN
    v_advance := 0;
    v_advance_type := NULL;
    v_advance_value := NULL;
  END IF;

  v_total := GREATEST(v_subtotal + v_delivery_fee - v_discount - v_advance, 0);
  v_order_number := next_order_number();

  INSERT INTO orders (
    order_number, customer_id, customer_name, customer_phone,
    division, district, thana, address_line,
    delivery_zone, delivery_fee, subtotal, discount, list_value,
    promo_code, total, payment_method, bkash_trx_id, bkash_sender,
    payment_status, customer_note,
    advance_discount, advance_discount_type, advance_discount_value
  ) VALUES (
    v_order_number, v_uid, trim(p_full_name), p_phone,
    p_division, p_district, p_thana, trim(p_address_line),
    p_delivery_zone, v_delivery_fee, v_subtotal, v_discount + v_advance, v_subtotal,
    NULLIF(trim(COALESCE(p_promo_code, '')), ''), v_total, p_payment_method,
    NULLIF(trim(COALESCE(p_bkash_trx_id, '')), ''), NULLIF(trim(COALESCE(p_bkash_sender, '')), ''),
    CASE WHEN p_payment_method IN ('bkash', 'nagad') THEN 'pending_verification' ELSE 'unpaid' END,
    NULLIF(trim(COALESCE(p_customer_note, '')), ''),
    v_advance, v_advance_type, v_advance_value
  )
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total, list_price)
  SELECT v_order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total, unit_price
  FROM _order_lines;

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by)
  VALUES (v_order_id, NULL, 'pending', v_uid);

  RETURN QUERY SELECT v_order_id, v_order_number, v_total, v_discount + v_advance, v_advance;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.place_order(jsonb, text, text, text, text, text, text, text, text, text, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 5. A confirmed Nagad advance is a Nagad payment (lands in Nagad)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orders_payment_status_bridge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_due numeric;
BEGIN
  IF COALESCE(current_setting('app.payments_sync', true), '') = 'on' THEN
    RETURN NULL;
  END IF;

  IF NEW.payment_status = 'paid' AND (TG_OP = 'INSERT' OR OLD.payment_status IS DISTINCT FROM 'paid') THEN
    v_due := NEW.total - order_payment_net(NEW.id);
    IF v_due > 0 THEN
      INSERT INTO order_payments (order_id, amount, method, trx_id, paid_at, note, source, created_by, created_by_username)
      VALUES (
        NEW.id, v_due,
        CASE NEW.payment_method WHEN 'bkash' THEN 'bkash' WHEN 'nagad' THEN 'nagad' WHEN 'cash' THEN 'cash' ELSE 'other' END,
        CASE WHEN NEW.payment_method IN ('bkash', 'nagad') THEN NEW.bkash_trx_id END,
        CASE WHEN NEW.payment_method IN ('bkash', 'nagad', 'cash') THEN NEW.created_at ELSE now() END,
        CASE NEW.payment_method
          WHEN 'bkash' THEN 'bKash advance'
          WHEN 'nagad' THEN 'Nagad advance'
          WHEN 'cash' THEN 'Cash paid when the order was entered'
          ELSE 'Marked as paid'
        END,
        'status_paid', auth.uid(), current_actor_username()
      );
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.payment_status = 'paid' AND NEW.payment_status <> 'paid' THEN
    DELETE FROM order_payments WHERE order_id = NEW.id AND source = 'status_paid';
  END IF;
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------
-- 6. New order: fully paid by Nagad = a Nagad order (like bKash)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_order_v2(p_source text, p_items jsonb, p_full_name text, p_phone text, p_division text, p_district text, p_thana text, p_address_line text, p_delivery_zone text, p_delivery_fee numeric, p_order_discount numeric DEFAULT 0, p_discount_reason text DEFAULT NULL::text, p_discount_note text DEFAULT NULL::text, p_linked_customer_id uuid DEFAULT NULL::uuid, p_mark_delivered boolean DEFAULT false, p_admin_note text DEFAULT NULL::text, p_allow_negative_stock boolean DEFAULT false, p_paid_amount numeric DEFAULT 0, p_paid_method text DEFAULT NULL::text, p_paid_trx_id text DEFAULT NULL::text, p_collect_mode text DEFAULT 'cod'::text, p_alt_phone text DEFAULT NULL::text)
 RETURNS TABLE(order_id uuid, order_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_paid     numeric(10,2) := round(COALESCE(p_paid_amount, 0), 2);
  v_mode     text := COALESCE(p_collect_mode, 'cod');
  v_trx      text := NULLIF(trim(COALESCE(p_paid_trx_id, '')), '');
  v_id       uuid;
  v_number   text;
  v_order    orders%ROWTYPE;
  v_legacy   text;
  v_text     text;
BEGIN
  IF NOT staff_can('create_orders') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_mode NOT IN ('cod', 'pay_later') THEN
    RAISE EXCEPTION 'Choose what happens to the rest of the money.';
  END IF;
  IF v_paid < 0 THEN
    RAISE EXCEPTION 'Paid now cannot be less than 0.';
  END IF;
  IF v_paid > 0 AND COALESCE(p_paid_method, '') NOT IN ('bkash', 'nagad', 'cash', 'bank') THEN
    RAISE EXCEPTION 'Choose how it was paid.';
  END IF;

  SELECT c.order_id, c.order_number INTO v_id, v_number
  FROM admin_create_order(
    p_source, p_items, p_full_name, p_phone, p_division, p_district, p_thana, p_address_line,
    p_delivery_zone, p_delivery_fee, p_order_discount, p_discount_reason, p_discount_note,
    CASE WHEN v_mode = 'pay_later' THEN 'due' ELSE 'cod' END, NULL, NULL,
    p_linked_customer_id, p_mark_delivered, p_admin_note, p_allow_negative_stock
  ) c;

  SELECT * INTO v_order FROM orders WHERE id = v_id;

  IF v_paid > v_order.total THEN
    RAISE EXCEPTION 'Paid now cannot be more than the order total (%).', taka_text(v_order.total);
  END IF;
  IF p_mark_delivered AND (v_order.delivery_zone <> 'hand_delivered' OR v_paid < v_order.total) THEN
    RAISE EXCEPTION 'Only a hand-delivered order that is fully paid can be marked delivered right away.';
  END IF;

  v_legacy := CASE
    WHEN v_paid > 0 AND v_paid >= v_order.total THEN CASE WHEN p_paid_method IN ('bkash', 'nagad') THEN p_paid_method ELSE 'cash' END
    WHEN v_mode = 'pay_later' THEN 'due'
    ELSE 'cod'
  END;

  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders
     SET collect_mode = v_mode,
         payment_method = v_legacy,
         bkash_trx_id = CASE WHEN v_legacy IN ('bkash', 'nagad') THEN v_trx ELSE bkash_trx_id END,
         alt_phone = COALESCE(NULLIF(trim(COALESCE(p_alt_phone, '')), ''), alt_phone)
   WHERE id = v_id;
  PERFORM set_config('app.activity_quiet', 'off', true);

  IF v_paid > 0 THEN
    INSERT INTO order_payments (order_id, kind, amount, method, trx_id, paid_at, note, source, created_by, created_by_username)
    VALUES (v_id, 'payment', v_paid, p_paid_method, v_trx, now(), 'Paid when the order was entered', 'manual',
            auth.uid(), current_actor_username());
    v_text := payment_history_text('payment', v_paid, p_paid_method, v_trx) || ' added';
    PERFORM order_history_line(v_id, v_order.status, v_text);
    PERFORM write_activity('order.payment_added', 'order', v_id::text, v_number,
      format('%s: %s', v_number, v_text),
      jsonb_build_object('kind', 'payment', 'amount', v_paid, 'method', p_paid_method));
    PERFORM order_payments_sync(v_id);
  END IF;

  IF v_mode = 'pay_later' AND v_paid < v_order.total THEN
    PERFORM order_history_line(v_id, v_order.status,
      'Customer pays later: courier collects ৳0, ' || taka_text(v_order.total - v_paid) || ' stays due');
  END IF;

  RETURN QUERY SELECT v_id, v_number;
END;
$function$;

-- ---------------------------------------------------------------------
-- 7. Edit order: the advance part of the discount
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_edit_order(p_order_id uuid, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin     boolean := is_admin();
  v_order        orders%ROWTYPE;
  v_notes        text[] := '{}';
  v_courier      text[] := '{}';
  v_moves_stock  boolean;
  v_booked       boolean;
  v_name         text;
  v_phone        text;
  v_alt          text;
  v_division     text;
  v_district     text;
  v_thana        text;
  v_address      text;
  v_cnote        text;
  v_fee          numeric(10,2);
  v_discount     numeric(10,2);
  v_dnote        text;
  v_item         jsonb;
  v_old          order_items%ROWTYPE;
  v_keep         uuid[];
  v_qty          integer;
  v_price        numeric(10,2);
  v_product_id   uuid;
  v_variant_id   uuid;
  v_list         numeric(10,2);
  v_pname        text;
  v_vlabel       text;
  v_image        text;
  v_active       boolean;
  v_region       text;
  v_size         text;
  v_label        text;
  v_subtotal     numeric(10,2);
  v_list_value   numeric(10,2);
  v_free         numeric(10,2);
  v_total        numeric(10,2);
  v_note         text;
  v_outdated     text[];
  v_sold_unit    text;
  v_pack         integer;
BEGIN
  IF NOT staff_can('edit_orders') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION 'Nothing to change.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  v_moves_stock := v_order.status <> 'cancelled' AND NOT v_order.stock_released;
  v_booked := v_order.steadfast_consignment_id IS NOT NULL
    AND v_order.status NOT IN ('delivered', 'cancelled')
    AND COALESCE(v_order.steadfast_status, '') NOT IN ('delivered', 'partial_delivered', 'cancelled');

  -- ---------- customer and address ----------
  v_name := CASE WHEN p_changes ? 'customer_name' THEN trim(COALESCE(p_changes ->> 'customer_name', '')) ELSE v_order.customer_name END;
  v_phone := CASE WHEN p_changes ? 'customer_phone' THEN trim(COALESCE(p_changes ->> 'customer_phone', '')) ELSE v_order.customer_phone END;
  v_alt := CASE WHEN p_changes ? 'alt_phone' THEN NULLIF(trim(COALESCE(p_changes ->> 'alt_phone', '')), '') ELSE v_order.alt_phone END;
  v_division := CASE WHEN p_changes ? 'division' THEN trim(COALESCE(p_changes ->> 'division', '')) ELSE v_order.division END;
  v_district := CASE WHEN p_changes ? 'district' THEN trim(COALESCE(p_changes ->> 'district', '')) ELSE v_order.district END;
  v_thana := CASE WHEN p_changes ? 'thana' THEN trim(COALESCE(p_changes ->> 'thana', '')) ELSE v_order.thana END;
  v_address := CASE WHEN p_changes ? 'address_line' THEN trim(COALESCE(p_changes ->> 'address_line', '')) ELSE v_order.address_line END;
  v_cnote := CASE WHEN p_changes ? 'courier_note' THEN NULLIF(trim(COALESCE(p_changes ->> 'courier_note', '')), '') ELSE v_order.courier_note END;

  IF v_name = '' THEN
    RAISE EXCEPTION 'Customer name is required.';
  END IF;
  IF v_address = '' THEN
    RAISE EXCEPTION 'Delivery address is required.';
  END IF;

  IF v_name IS DISTINCT FROM v_order.customer_name THEN
    v_notes := v_notes || format('Name %s → %s', v_order.customer_name, v_name);
    v_courier := v_courier || 'Name'::text;
  END IF;
  IF v_phone IS DISTINCT FROM v_order.customer_phone THEN
    v_notes := v_notes || format('Phone %s → %s', COALESCE(NULLIF(v_order.customer_phone, ''), '(none)'), COALESCE(NULLIF(v_phone, ''), '(none)'));
    v_courier := v_courier || 'Phone'::text;
  END IF;
  IF v_alt IS DISTINCT FROM v_order.alt_phone THEN
    v_notes := v_notes || format('Alternative phone %s → %s', COALESCE(v_order.alt_phone, '(none)'), COALESCE(v_alt, '(none)'));
    v_courier := v_courier || 'Alternative phone'::text;
  END IF;
  IF v_division IS DISTINCT FROM v_order.division OR v_district IS DISTINCT FROM v_order.district
     OR v_thana IS DISTINCT FROM v_order.thana OR v_address IS DISTINCT FROM v_order.address_line THEN
    v_notes := v_notes || format('Address %s → %s',
      concat_ws(', ', NULLIF(v_order.address_line, ''), NULLIF(v_order.thana, ''), NULLIF(v_order.district, '')),
      concat_ws(', ', NULLIF(v_address, ''), NULLIF(v_thana, ''), NULLIF(v_district, '')));
    v_courier := v_courier || 'Address'::text;
  END IF;
  IF v_cnote IS DISTINCT FROM v_order.courier_note THEN
    v_notes := v_notes || format('Courier note %s → %s', COALESCE(v_order.courier_note, '(none)'), COALESCE(v_cnote, '(none)'));
    v_courier := v_courier || 'Note'::text;
  END IF;

  -- ---------- delivery fee and discount ----------
  v_fee := v_order.delivery_fee;
  IF p_changes ? 'delivery_fee' THEN
    v_fee := round(NULLIF(p_changes ->> 'delivery_fee', '')::numeric, 2);
    IF v_fee IS NULL OR v_fee < 0 THEN
      RAISE EXCEPTION 'Delivery fee must be 0 or more.';
    END IF;
  END IF;

  v_discount := v_order.discount;
  v_dnote := v_order.discount_note;
  IF p_changes ? 'discount' THEN
    v_discount := round(COALESCE(NULLIF(p_changes ->> 'discount', '')::numeric, 0), 2);
    IF v_discount < 0 THEN
      RAISE EXCEPTION 'Discount must be 0 or more.';
    END IF;
  END IF;
  IF p_changes ? 'discount_note' THEN
    v_dnote := NULLIF(trim(COALESCE(p_changes ->> 'discount_note', '')), '');
  END IF;
  IF NOT v_is_admin AND (v_discount IS DISTINCT FROM v_order.discount OR v_dnote IS DISTINCT FROM v_order.discount_note) THEN
    RAISE EXCEPTION 'Only the Super Admin can change the discount.';
  END IF;

  -- ---------- items ----------
  IF p_changes ? 'items' THEN
    IF jsonb_typeof(p_changes -> 'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes -> 'items') = 0 THEN
      RAISE EXCEPTION 'An order needs at least one item.';
    END IF;

    SELECT COALESCE(array_agg((e ->> 'id')::uuid), '{}'::uuid[]) INTO v_keep
    FROM jsonb_array_elements(p_changes -> 'items') e
    WHERE NULLIF(e ->> 'id', '') IS NOT NULL;

    PERFORM set_config('app.order_stock_change', 'on', true);
    -- Batch 39: while On the order_items triggers take / give back units in
    -- lots. Short: STOCK_WARNING (the screen asks "sell anyway?") unless
    -- the admin already said yes (allow_short).
    PERFORM set_config('inventory.short_warn', 'on', true);
    PERFORM set_config('inventory.short_ok',
      CASE WHEN COALESCE((p_changes ->> 'allow_short')::boolean, false) THEN 'on' ELSE '' END, true);

    -- Lines left out: removed, their stock put back.
    FOR v_old IN SELECT * FROM order_items WHERE order_id = p_order_id AND NOT (id = ANY (v_keep)) LOOP
      v_label := v_old.product_name || COALESCE(' (' || v_old.variant_label || ')', '');
      IF v_moves_stock AND v_old.sold_unit IS NULL THEN
        PERFORM order_edit_stock(v_old.product_id, v_old.variant_id, v_old.quantity, v_label);
      END IF;
      DELETE FROM order_items WHERE id = v_old.id;
      v_notes := v_notes || format('Removed %s ×%s%s', v_label, v_old.quantity, COALESCE(' ' || v_old.sold_unit, ''));
    END LOOP;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_changes -> 'items') LOOP
      v_qty := NULLIF(v_item ->> 'quantity', '')::integer;
      IF v_qty IS NULL OR v_qty <= 0 THEN
        RAISE EXCEPTION 'Quantity must be 1 or more.';
      END IF;
      v_price := round(NULLIF(v_item ->> 'unit_price', '')::numeric, 2);
      IF v_price IS NOT NULL AND v_price < 0 THEN
        RAISE EXCEPTION 'Price must be 0 or more.';
      END IF;

      IF NULLIF(v_item ->> 'id', '') IS NOT NULL THEN
        SELECT * INTO v_old FROM order_items WHERE id = (v_item ->> 'id')::uuid AND order_id = p_order_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'One of the items is no longer on this order. Close the sheet and try again.';
        END IF;
        v_label := v_old.product_name || COALESCE(' (' || v_old.variant_label || ')', '');
        IF v_qty <> v_old.quantity THEN
          IF v_moves_stock AND v_old.sold_unit IS NULL THEN
            PERFORM order_edit_stock(v_old.product_id, v_old.variant_id, v_old.quantity - v_qty, v_label);
          END IF;
          v_notes := v_notes || format('Quantity of %s %s → %s%s', v_label, v_old.quantity, v_qty, COALESCE(' ' || v_old.sold_unit, ''));
        END IF;
        v_price := COALESCE(v_price, v_old.unit_price);
        IF v_price <> v_old.unit_price THEN
          IF NOT v_is_admin THEN
            RAISE EXCEPTION 'Only the Super Admin can change prices.';
          END IF;
          v_notes := v_notes || format('Price of %s %s → %s', v_label, taka_text(v_old.unit_price), taka_text(v_price));
        END IF;
        UPDATE order_items SET
          quantity = v_qty,
          unit_price = v_price,
          line_total = v_price * v_qty,
          reason = CASE WHEN v_price < list_price THEN COALESCE(reason, 'other') ELSE NULL END
        WHERE id = v_old.id;
      ELSE
        v_product_id := NULLIF(v_item ->> 'product_id', '')::uuid;
        v_variant_id := NULLIF(v_item ->> 'variant_id', '')::uuid;
        IF v_product_id IS NULL THEN
          RAISE EXCEPTION 'Choose a product for the new item.';
        END IF;
        IF v_variant_id IS NOT NULL THEN
          SELECT
            CASE WHEN pv.offer_price IS NOT NULL AND pv.offer_price < pv.retail_price THEN pv.offer_price ELSE pv.retail_price END,
            pv.region, pv.size, COALESCE(pv.image_url, p.image_url), p.name, p.is_active
          INTO v_list, v_region, v_size, v_image, v_pname, v_active
          FROM product_variants pv JOIN products p ON p.id = pv.product_id
          WHERE pv.id = v_variant_id AND pv.product_id = v_product_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'That product option no longer exists.';
          END IF;
          v_vlabel := NULLIF(trim(both ' ' from concat_ws(' · ', NULLIF(v_region, ''), NULLIF(v_size, ''))), '');
        ELSE
          SELECT
            CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price THEN p.offer_price ELSE p.retail_price END,
            p.image_url, p.name, p.is_active
          INTO v_list, v_image, v_pname, v_active
          FROM products p WHERE p.id = v_product_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'That product no longer exists.';
          END IF;
          v_vlabel := NULL;
        END IF;
        IF NOT v_active THEN
          RAISE EXCEPTION '"%" is not active — reactivate it first if you really want to sell it.', v_pname;
        END IF;
        -- Batch 39: 'pcs' / 'ml' / 'g' = a new line sold in loose units.
        v_sold_unit := NULLIF(trim(COALESCE(v_item ->> 'sold_unit', '')), '');
        v_pack := inventory_pack_size(v_product_id, v_variant_id);
        IF v_sold_unit IS NOT NULL THEN
          IF v_pack <= 1 THEN
            RAISE EXCEPTION '"%" is sold in whole packs only (its pack size is 1).', v_pname;
          END IF;
          v_sold_unit := inventory_stock_unit(v_product_id, v_variant_id);
          v_list := round(v_list / v_pack, 2);
        END IF;
        v_price := COALESCE(v_price, v_list);
        IF v_price <> v_list AND NOT v_is_admin THEN
          RAISE EXCEPTION 'Only the Super Admin can change prices.';
        END IF;
        v_label := v_pname || COALESCE(' (' || v_vlabel || ')', '');
        IF v_moves_stock AND v_sold_unit IS NULL THEN
          PERFORM order_edit_stock(v_product_id, v_variant_id, -v_qty, v_label);
        END IF;
        INSERT INTO order_items (
          order_id, product_id, variant_id, product_name, variant_label, image_url,
          list_price, unit_price, quantity, line_total, reason, sold_unit
        ) VALUES (
          p_order_id, v_product_id, v_variant_id, v_pname, v_vlabel, v_image,
          v_list, v_price, v_qty, v_price * v_qty,
          CASE WHEN v_price < v_list THEN 'other' END, v_sold_unit
        );
        v_notes := v_notes || format('Added %s ×%s%s (%s each)', v_label, v_qty, COALESCE(' ' || v_sold_unit, ''), taka_text(v_price));
      END IF;
    END LOOP;

    PERFORM set_config('app.order_stock_change', 'off', true);
    PERFORM set_config('inventory.short_warn', '', true);
    PERFORM set_config('inventory.short_ok', '', true);
  END IF;

  -- ---------- totals ----------
  SELECT COALESCE(sum(line_total), 0),
         COALESCE(sum(list_price * quantity), 0),
         COALESCE(sum(CASE WHEN unit_price = 0 THEN list_price * quantity ELSE 0 END), 0)
  INTO v_subtotal, v_list_value, v_free
  FROM order_items WHERE order_id = p_order_id;

  IF v_fee IS DISTINCT FROM v_order.delivery_fee THEN
    v_notes := v_notes || format('Delivery fee %s → %s', taka_text(v_order.delivery_fee), taka_text(v_fee));
  END IF;
  v_discount := LEAST(v_discount, v_subtotal);
  IF v_discount IS DISTINCT FROM v_order.discount THEN
    v_notes := v_notes || format('Discount %s → %s%s', taka_text(v_order.discount), taka_text(v_discount),
      COALESCE(' (' || v_dnote || ')', ''));
  ELSIF v_dnote IS DISTINCT FROM v_order.discount_note THEN
    v_notes := v_notes || format('Discount reason %s → %s', COALESCE(v_order.discount_note, '(none)'), COALESCE(v_dnote, '(none)'));
  END IF;
  v_total := GREATEST(v_subtotal + v_fee - v_discount, 0);

  IF cardinality(v_notes) = 0 THEN
    RETURN jsonb_build_object('changed', 0, 'total', v_order.total, 'steadfast_outdated', to_jsonb(v_order.steadfast_outdated));
  END IF;

  IF v_total IS DISTINCT FROM v_order.total THEN
    v_notes := v_notes || format('Total %s → %s', taka_text(v_order.total), taka_text(v_total));
  END IF;

  v_outdated := v_order.steadfast_outdated;
  IF v_booked AND cardinality(v_courier) > 0 THEN
    SELECT COALESCE(array_agg(f ORDER BY array_position(ARRAY['Name', 'Phone', 'Alternative phone', 'Address', 'Note'], f)), '{}'::text[])
    INTO v_outdated
    FROM (SELECT DISTINCT unnest(v_order.steadfast_outdated || v_courier) AS f) x;
  END IF;

  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders SET
    customer_name   = v_name,
    customer_phone  = v_phone,
    alt_phone       = v_alt,
    division        = v_division,
    district        = v_district,
    thana           = v_thana,
    address_line    = v_address,
    courier_note    = v_cnote,
    delivery_fee    = v_fee,
    discount        = v_discount,
    discount_reason = CASE
                        WHEN v_discount = 0 THEN NULL
                        WHEN v_discount <= COALESCE(v_order.advance_discount, 0) THEN NULL
                        WHEN v_order.promo_code IS NULL THEN COALESCE(v_order.discount_reason, 'other')
                        ELSE v_order.discount_reason
                      END,
    discount_note   = CASE WHEN v_discount = 0 THEN NULL ELSE v_dnote END,
    advance_discount = LEAST(COALESCE(v_order.advance_discount, 0), v_discount),
    subtotal        = v_subtotal,
    list_value      = v_list_value,
    free_value      = v_free,
    total           = v_total,
    steadfast_outdated = v_outdated,
    updated_at      = now()
  WHERE id = p_order_id;
  PERFORM set_config('app.activity_quiet', 'off', true);

  FOREACH v_note IN ARRAY v_notes LOOP
    PERFORM order_history_line(p_order_id, v_order.status, v_note);
  END LOOP;

  PERFORM write_activity('order.edited', 'order', p_order_id::text, v_order.order_number,
    format('%s: %s', v_order.order_number, array_to_string(v_notes, '; ')),
    jsonb_build_object(
      'changes', to_jsonb(v_notes),
      'total', jsonb_build_object('from', v_order.total, 'to', v_total),
      'steadfast_consignment_id', v_order.steadfast_consignment_id));

  PERFORM order_payments_sync(p_order_id);

  RETURN jsonb_build_object('changed', cardinality(v_notes), 'total', v_total, 'steadfast_outdated', to_jsonb(v_outdated));
END;
$function$;

-- ---------------------------------------------------------------------
-- 8. Edit order: change Cash on Delivery / bKash / Nagad
--
-- bKash or Nagad -> Cash on Delivery: the advance discount comes off and
-- the total goes up by it. bKash <-> Nagad: the discount stays, and a
-- confirmed advance moves to the other wallet. Every change is written
-- in the order's History and the Activity Log.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_order_payment_method(p_order_id uuid, p_method text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_order    orders%ROWTYPE;
  v_notes    text[] := '{}';
  v_discount numeric(10,2);
  v_advance  numeric(10,2);
  v_total    numeric(10,2);
  v_status   text;
  v_note     text;
BEGIN
  IF NOT staff_can('edit_orders') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('cod', 'bkash', 'nagad') THEN
    RAISE EXCEPTION 'Choose Cash on Delivery, bKash or Nagad.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.payment_method NOT IN ('cod', 'bkash', 'nagad') THEN
    RAISE EXCEPTION 'This order''s payment is set in the Payment section, not here.';
  END IF;
  IF v_order.payment_method = p_method THEN
    RETURN jsonb_build_object('changed', 0, 'total', v_order.total);
  END IF;

  v_discount := v_order.discount;
  v_advance := COALESCE(v_order.advance_discount, 0);
  v_status := v_order.payment_status;

  v_notes := v_notes || format('Payment method %s → %s',
    CASE v_order.payment_method WHEN 'cod' THEN 'Cash on Delivery' WHEN 'bkash' THEN 'bKash' ELSE 'Nagad' END,
    CASE p_method WHEN 'cod' THEN 'Cash on Delivery' WHEN 'bkash' THEN 'bKash' ELSE 'Nagad' END);

  IF p_method = 'cod' THEN
    IF v_advance > 0 THEN
      v_discount := GREATEST(v_discount - v_advance, 0);
      v_notes := v_notes || format('Advance payment discount %s removed', taka_text(v_advance));
      v_advance := 0;
    END IF;
    IF v_status = 'pending_verification' THEN
      v_status := 'unpaid';
    END IF;
  END IF;

  v_total := GREATEST(v_order.subtotal + v_order.delivery_fee - v_discount, 0);
  IF v_total IS DISTINCT FROM v_order.total THEN
    v_notes := v_notes || format('Total %s → %s', taka_text(v_order.total), taka_text(v_total));
  END IF;

  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders SET
    payment_method         = p_method,
    payment_status         = v_status,
    discount               = v_discount,
    advance_discount       = v_advance,
    advance_discount_type  = CASE WHEN v_advance > 0 THEN v_order.advance_discount_type END,
    advance_discount_value = CASE WHEN v_advance > 0 THEN v_order.advance_discount_value END,
    discount_reason        = CASE WHEN v_discount = 0 THEN NULL ELSE v_order.discount_reason END,
    discount_note          = CASE WHEN v_discount = 0 THEN NULL ELSE v_order.discount_note END,
    total                  = v_total,
    updated_at             = now()
  WHERE id = p_order_id;
  PERFORM set_config('app.activity_quiet', 'off', true);

  -- bKash <-> Nagad: an advance already confirmed moves to the other wallet.
  IF v_order.payment_method IN ('bkash', 'nagad') AND p_method IN ('bkash', 'nagad') THEN
    UPDATE order_payments SET method = p_method
     WHERE order_id = p_order_id AND source = 'status_paid' AND method = v_order.payment_method;
  END IF;

  FOREACH v_note IN ARRAY v_notes LOOP
    PERFORM order_history_line(p_order_id, v_order.status, v_note);
  END LOOP;

  PERFORM write_activity('order.edited', 'order', p_order_id::text, v_order.order_number,
    format('%s: %s', v_order.order_number, array_to_string(v_notes, '; ')),
    jsonb_build_object(
      'changes', to_jsonb(v_notes),
      'total', jsonb_build_object('from', v_order.total, 'to', v_total),
      'payment_method', jsonb_build_object('from', v_order.payment_method, 'to', p_method)));

  PERFORM order_payments_sync(p_order_id);

  RETURN jsonb_build_object('changed', cardinality(v_notes), 'total', v_total);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_order_payment_method(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_order_payment_method(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
