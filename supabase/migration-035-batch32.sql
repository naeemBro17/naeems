-- ============================================================
-- NAEEM'S — Migration 035 (Batch 32: payment section with "pay later",
-- customers add / hide / delete)
-- Run this in the Supabase SQL Editor after migration-034. Safe to re-run.
--
-- ADDITIVE ONLY. No table or column is dropped or renamed, and every
-- existing function keeps its exact name, arguments and meaning, so the
-- live site (built from main) keeps working the moment this runs.
--
-- What it adds:
--   PART 1  orders.collect_mode — 'cod' (the courier collects what is still
--           due; every existing order gets this, so nothing changes for
--           them) or 'pay_later' (the courier collects ৳0, the rest stays
--           due on the customer). New order saves "Paid now" as a real
--           payment in the same step. Edit order can switch the mode
--           (History + Activity Log). Two existing functions learn the new
--           mode: "Done, I updated Steadfast" and the automatic "COD via
--           Steadfast" payment on a confirmed delivery (a pay-later order
--           records nothing — the courier collected ৳0).
--   PART 2  customers — customers added by hand (before their first
--           order), plus a note and a Hide switch for any customer.
--           A new staff switch "Manage customers" (off for every role).
-- ============================================================


-- ============================================================
-- PART 1 — paid now, then collect on delivery or pay later
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS collect_mode text NOT NULL DEFAULT 'cod';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_collect_mode_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_collect_mode_check CHECK (collect_mode IN ('cod', 'pay_later'));
  END IF;
END;
$$;

-- The one COD rule (the same as supabase/functions/_shared/cod.ts):
--   courier_cod = collect_mode = 'pay_later' ? 0 : max(0, total − paid)
CREATE OR REPLACE FUNCTION order_courier_cod(p_order_id uuid)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN o.collect_mode = 'pay_later' THEN 0
              ELSE GREATEST(o.total - order_payment_net(o.id), 0) END
  FROM orders o WHERE o.id = p_order_id;
$$;

REVOKE ALL ON FUNCTION order_courier_cod(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION collect_mode_label(p_mode text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_mode WHEN 'pay_later' THEN 'Customer pays later' ELSE 'Collect on delivery' END;
$$;

-- New order (Batch 32): the same order as admin_create_order() (which this
-- calls, so every price, stock and permission check stays exactly where it
-- is), plus in the same step:
--   - "Paid now": one real payment (method + TrxID, who and when);
--   - what happens to the rest: 'cod' or 'pay_later';
--   - the alternative phone.
-- The old payment column is kept in step for the invoice and older
-- screens: bKash / Cash when fully paid, 'due' for pay later, else COD.
CREATE OR REPLACE FUNCTION admin_create_order_v2(
  p_source               text,
  p_items                jsonb,
  p_full_name            text,
  p_phone                text,
  p_division             text,
  p_district             text,
  p_thana                text,
  p_address_line         text,
  p_delivery_zone        text,
  p_delivery_fee         numeric,
  p_order_discount       numeric DEFAULT 0,
  p_discount_reason      text DEFAULT NULL,
  p_discount_note        text DEFAULT NULL,
  p_linked_customer_id   uuid DEFAULT NULL,
  p_mark_delivered       boolean DEFAULT false,
  p_admin_note           text DEFAULT NULL,
  p_allow_negative_stock boolean DEFAULT false,
  p_paid_amount          numeric DEFAULT 0,
  p_paid_method          text DEFAULT NULL,
  p_paid_trx_id          text DEFAULT NULL,
  p_collect_mode         text DEFAULT 'cod',
  p_alt_phone            text DEFAULT NULL
)
RETURNS TABLE (order_id uuid, order_number text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    WHEN v_paid > 0 AND v_paid >= v_order.total THEN CASE WHEN p_paid_method = 'bkash' THEN 'bkash' ELSE 'cash' END
    WHEN v_mode = 'pay_later' THEN 'due'
    ELSE 'cod'
  END;

  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders
     SET collect_mode = v_mode,
         payment_method = v_legacy,
         bkash_trx_id = CASE WHEN v_legacy = 'bkash' THEN v_trx ELSE bkash_trx_id END,
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
$$;

GRANT EXECUTE ON FUNCTION admin_create_order_v2(
  text, jsonb, text, text, text, text, text, text, text, numeric,
  numeric, text, text, uuid, boolean, text, boolean,
  numeric, text, text, text, text
) TO authenticated;

-- Edit order: switch what happens to the rest of the money. "Edit orders".
CREATE OR REPLACE FUNCTION admin_set_order_collect_mode(p_order_id uuid, p_mode text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_text  text;
BEGIN
  IF NOT staff_can('edit_orders') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_mode NOT IN ('cod', 'pay_later') THEN
    RAISE EXCEPTION 'Choose what happens to the rest of the money.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.collect_mode = p_mode THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders SET collect_mode = p_mode, updated_at = now() WHERE id = p_order_id;
  PERFORM set_config('app.activity_quiet', 'off', true);

  v_text := 'Remaining money: ' || collect_mode_label(v_order.collect_mode) || ' → ' || collect_mode_label(p_mode)
            || ' (courier collects ' || taka_text(order_courier_cod(p_order_id)) || ')';
  PERFORM order_history_line(p_order_id, v_order.status, v_text);
  PERFORM write_activity('order.collect_mode', 'order', p_order_id::text, v_order.order_number,
    format('%s: %s', v_order.order_number, v_text),
    jsonb_build_object('from', v_order.collect_mode, 'to', p_mode));
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_set_order_collect_mode(uuid, text) TO authenticated;

-- Same as migration-033, except the COD Steadfast should have now follows
-- the one rule above (0 for a pay-later order).
CREATE OR REPLACE FUNCTION admin_mark_steadfast_updated(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_due   numeric(10,2);
  v_parts text[] := '{}';
BEGIN
  IF NOT (staff_can('edit_orders') OR staff_can('book_steadfast') OR staff_can('change_order_status')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.steadfast_consignment_id IS NULL THEN
    RAISE EXCEPTION 'This order is not booked on Steadfast.';
  END IF;

  v_due := order_courier_cod(p_order_id);
  IF cardinality(v_order.steadfast_outdated) > 0 THEN
    v_parts := v_parts || array_to_string(v_order.steadfast_outdated, ', ');
  END IF;
  IF v_order.steadfast_cod_amount IS DISTINCT FROM v_due THEN
    v_parts := v_parts || ('COD ' || taka_text(v_due));
  END IF;

  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders SET steadfast_outdated = '{}', steadfast_cod_amount = v_due, updated_at = now()
  WHERE id = p_order_id;
  PERFORM set_config('app.activity_quiet', 'off', true);

  PERFORM order_history_line(p_order_id, v_order.status,
    'Updated on Steadfast by hand' || COALESCE(': ' || NULLIF(array_to_string(v_parts, '; '), ''), ''));
  PERFORM write_activity('order.steadfast_updated', 'order', p_order_id::text, v_order.order_number,
    format('%s: details updated on Steadfast by hand%s', v_order.order_number,
           COALESCE(' (' || NULLIF(array_to_string(v_parts, '; '), '') || ')', '')),
    jsonb_build_object('fields', to_jsonb(v_order.steadfast_outdated), 'cod_amount', v_due));
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_mark_steadfast_updated(uuid) TO authenticated;

-- Same as migration-033, plus one line: a pay-later order records nothing
-- on a confirmed delivery (the courier collected ৳0); it stays due.
CREATE OR REPLACE FUNCTION orders_record_steadfast_cod()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount numeric(10,2);
  v_text   text;
  v_id     uuid;
BEGIN
  IF NEW.steadfast_status IS DISTINCT FROM 'delivered' OR OLD.steadfast_status IS NOT DISTINCT FROM 'delivered' THEN
    RETURN NULL;
  END IF;
  IF NEW.collect_mode = 'pay_later' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM order_payments WHERE order_id = NEW.id AND source = 'steadfast_cod') THEN
    RETURN NULL;
  END IF;
  v_amount := COALESCE(NEW.steadfast_cod_amount, GREATEST(NEW.total - order_payment_net(NEW.id), 0));
  IF v_amount <= 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO order_payments (order_id, amount, method, note, source, created_by, created_by_username)
  VALUES (NEW.id, v_amount, 'cod_steadfast', 'Collected by Steadfast on delivery', 'steadfast_cod',
          auth.uid(), current_actor_username())
  ON CONFLICT (order_id) WHERE source = 'steadfast_cod' DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_text := 'COD ' || taka_text(v_amount) || ' collected by Steadfast (recorded automatically)';
  PERFORM order_history_line(NEW.id, NEW.status, v_text);
  PERFORM write_activity('order.payment_added', 'order', NEW.id::text, NEW.order_number,
    format('%s: %s', NEW.order_number, v_text),
    jsonb_build_object('kind', 'payment', 'amount', v_amount, 'method', 'cod_steadfast'));
  PERFORM order_payments_sync(NEW.id);
  RETURN NULL;
END;
$$;



-- ============================================================
-- PART 2 — customers: add by hand, note, hide / unhide, delete
-- ============================================================

-- New staff switch "Manage customers" (hide / unhide / delete). Off for
-- every existing role — the list below only adds the name at the end.
CREATE OR REPLACE FUNCTION staff_permission_names()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'view_orders', 'change_order_status', 'create_orders', 'book_steadfast',
    'edit_products', 'edit_categories', 'view_customers', 'delete_early_orders',
    'view_wholesalers', 'see_sales', 'edit_brands', 'edit_customer_notes',
    'edit_orders', 'manage_customers'
  ];
$$;

-- One row per customer that was added by hand or has a flag. Keyed by the
-- same customer key as the Customers page (Batch 30 grouping):
-- "p:<profile id>" for a registered customer, "ph:<phone>" otherwise.
-- Existing data is never changed: orders still group by phone exactly as
-- before; this table only adds people (before their first order), a note
-- and the Hide switch.
CREATE TABLE IF NOT EXISTS customers (
  customer_key        text PRIMARY KEY,
  phone_key           text,
  full_name           text NOT NULL DEFAULT '',
  phone               text NOT NULL DEFAULT '',
  alt_phone           text,
  division            text NOT NULL DEFAULT '',
  district            text NOT NULL DEFAULT '',
  thana               text NOT NULL DEFAULT '',
  address_line        text NOT NULL DEFAULT '',
  note                text,
  -- true = added with "Add customer" (shown even with no orders yet).
  added_by_hand       boolean NOT NULL DEFAULT false,
  hidden              boolean NOT NULL DEFAULT false,
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_username text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_phone_key ON customers (phone_key);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customers_staff_read" ON customers;
CREATE POLICY "customers_staff_read"
  ON customers FOR SELECT TO authenticated
  USING (staff_can('view_customers') OR staff_can('create_orders'));

-- Reads only. Every write goes through the functions below.
REVOKE ALL ON customers FROM anon, authenticated;
GRANT SELECT ON customers TO authenticated;
GRANT ALL ON customers TO service_role;

-- The Customers page (Batch 32): the Batch 30 list, plus Hide / note /
-- alternative phone, plus customers added by hand who have no order yet.
CREATE OR REPLACE FUNCTION admin_customers_v3()
RETURNS TABLE (
  customer_key   text,
  profile_id     uuid,
  full_name      text,
  email          text,
  phone          text,
  order_count    bigint,
  total_spent    numeric,
  total_due      numeric,
  last_order_at  timestamptz,
  joined_at      timestamptz,
  all_orders     bigint,
  hidden         boolean,
  note           text,
  alt_phone      text,
  added_by_hand  boolean,
  added_at       timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH base AS (SELECT * FROM admin_customers_v2()),
  allcounts AS (SELECT k.customer_key, count(*) AS n FROM order_customer_keys() k GROUP BY k.customer_key),
  rows_with_flags AS (
    SELECT b.*,
           COALESCE(a.n, 0) AS all_n,
           COALESCE(c1.hidden, c2.hidden, false) AS is_hidden,
           COALESCE(c1.note, c2.note) AS c_note,
           COALESCE(c1.alt_phone, c2.alt_phone) AS c_alt,
           COALESCE(c1.added_by_hand, c2.added_by_hand, false) AS c_hand,
           COALESCE(c1.created_at, c2.created_at) AS c_created
    FROM base b
    LEFT JOIN allcounts a ON a.customer_key = b.customer_key
    LEFT JOIN customers c1 ON c1.customer_key = b.customer_key
    LEFT JOIN LATERAL (
      SELECT * FROM customers c
      WHERE c.customer_key <> b.customer_key AND c.phone_key IS NOT NULL AND c.phone_key = bd_phone_key(b.phone)
      ORDER BY c.created_at LIMIT 1
    ) c2 ON true
  )
  SELECT r.customer_key, r.profile_id, r.full_name, r.email, r.phone, r.order_count, r.total_spent, r.total_due,
         r.last_order_at, r.joined_at, r.all_n, r.is_hidden, r.c_note, r.c_alt, r.c_hand, r.c_created
  FROM rows_with_flags r
  UNION ALL
  SELECT c.customer_key, NULL::uuid, c.full_name, ''::text, c.phone, 0::bigint,
         CASE WHEN staff_can('see_sales') THEN 0::numeric END,
         CASE WHEN staff_can('see_sales') OR staff_can('view_orders') THEN 0::numeric END,
         NULL::timestamptz, NULL::timestamptz, 0::bigint, c.hidden, c.note, c.alt_phone, true, c.created_at
  FROM customers c
  WHERE c.added_by_hand
    AND staff_can('view_customers')
    AND NOT EXISTS (SELECT 1 FROM base b WHERE b.customer_key = c.customer_key)
    AND NOT EXISTS (SELECT 1 FROM base b WHERE c.phone_key IS NOT NULL AND bd_phone_key(b.phone) = c.phone_key);
$$;

GRANT EXECUTE ON FUNCTION admin_customers_v3() TO authenticated;

-- "Add customer" (the Customers page and New order use the same form). The
-- phone is the key: when the number already belongs to a customer (an
-- account, a past order or an earlier add) nothing is added and that
-- customer's key comes back with existed = true, so the screen opens them.
CREATE OR REPLACE FUNCTION admin_add_customer(
  p_full_name    text,
  p_phone        text,
  p_alt_phone    text DEFAULT NULL,
  p_division     text DEFAULT NULL,
  p_district     text DEFAULT NULL,
  p_thana        text DEFAULT NULL,
  p_address_line text DEFAULT NULL,
  p_note         text DEFAULT NULL
)
RETURNS TABLE (customer_key text, existed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key   text := bd_phone_key(p_phone);
  v_found text;
  v_new   text;
BEGIN
  IF NOT (is_admin() OR staff_can('create_orders') OR staff_can('manage_customers')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF trim(COALESCE(p_full_name, '')) = '' THEN
    RAISE EXCEPTION 'Enter the name of the customer.';
  END IF;
  IF v_key IS NULL OR v_key !~ '^01[3-9][0-9]{8}$' THEN
    RAISE EXCEPTION 'Enter a valid Bangladeshi mobile number (01XXXXXXXXX).';
  END IF;

  SELECT 'p:' || p.id INTO v_found
  FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = v_key
  ORDER BY p.created_at, p.id LIMIT 1;
  IF v_found IS NULL THEN
    SELECT k.customer_key INTO v_found
    FROM order_customer_keys() k JOIN orders o ON o.id = k.order_id
    WHERE bd_phone_key(o.customer_phone) = v_key
    ORDER BY o.created_at DESC LIMIT 1;
  END IF;
  IF v_found IS NULL THEN
    SELECT c.customer_key INTO v_found FROM customers c WHERE c.phone_key = v_key AND c.added_by_hand LIMIT 1;
  END IF;
  IF v_found IS NOT NULL THEN
    RETURN QUERY SELECT v_found, true;
    RETURN;
  END IF;

  v_new := 'ph:' || v_key;
  INSERT INTO customers AS c (customer_key, phone_key, full_name, phone, alt_phone, division, district, thana, address_line,
                         note, added_by_hand, created_by, created_by_username, updated_by_username)
  VALUES (v_new, v_key, trim(p_full_name), v_key, NULLIF(trim(COALESCE(p_alt_phone, '')), ''),
          COALESCE(p_division, ''), COALESCE(p_district, ''), COALESCE(p_thana, ''), trim(COALESCE(p_address_line, '')),
          NULLIF(trim(COALESCE(p_note, '')), ''), true, auth.uid(), current_actor_username(), current_actor_username())
  ON CONFLICT ON CONSTRAINT customers_pkey DO UPDATE
    SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, alt_phone = EXCLUDED.alt_phone,
        division = EXCLUDED.division, district = EXCLUDED.district, thana = EXCLUDED.thana,
        address_line = EXCLUDED.address_line, note = COALESCE(EXCLUDED.note, c.note),
        added_by_hand = true, updated_by_username = EXCLUDED.updated_by_username, updated_at = now();

  PERFORM write_activity('customer.added', 'customer', v_new, trim(p_full_name),
    format('Added customer %s (%s)', trim(p_full_name), v_key), '{}'::jsonb);
  RETURN QUERY SELECT v_new, false;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_add_customer(text, text, text, text, text, text, text, text) TO authenticated;

-- Hide / Unhide — for customers with orders (their orders and dues stay
-- exactly as they are). Super Admin, or staff with "Manage customers".
CREATE OR REPLACE FUNCTION admin_set_customer_hidden(p_customer_key text, p_hidden boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone_key text;
  v_label     text;
BEGIN
  IF NOT (is_admin() OR staff_can('manage_customers')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_customer_key IS NULL OR p_customer_key !~ '^(p|ph|n):.+' THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;
  IF p_customer_key LIKE 'p:%' THEN
    SELECT bd_phone_key(p.phone), COALESCE(NULLIF(p.full_name, ''), p.phone) INTO v_phone_key, v_label
    FROM profiles p WHERE 'p:' || p.id = p_customer_key AND p.role = 'customer';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer not found.';
    END IF;
  ELSIF p_customer_key LIKE 'ph:%' THEN
    v_phone_key := substr(p_customer_key, 4);
    v_label := v_phone_key;
  ELSE
    v_label := substr(p_customer_key, 3);
  END IF;

  INSERT INTO customers AS c (customer_key, phone_key, hidden, created_by, created_by_username, updated_by_username)
  VALUES (p_customer_key, v_phone_key, COALESCE(p_hidden, false), auth.uid(), current_actor_username(), current_actor_username())
  ON CONFLICT ON CONSTRAINT customers_pkey DO UPDATE
    SET hidden = COALESCE(p_hidden, false), updated_by_username = EXCLUDED.updated_by_username, updated_at = now();
  -- A customer added by hand under their phone who later got an account:
  -- the same switch applies to that row too.
  IF v_phone_key IS NOT NULL THEN
    UPDATE customers SET hidden = COALESCE(p_hidden, false), updated_at = now()
    WHERE phone_key = v_phone_key AND customers.customer_key <> p_customer_key;
  END IF;

  PERFORM write_activity(CASE WHEN p_hidden THEN 'customer.hidden' ELSE 'customer.unhidden' END,
    'customer', p_customer_key, v_label,
    format('%s customer %s', CASE WHEN p_hidden THEN 'Hid' ELSE 'Unhid' END, v_label), '{}'::jsonb);
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_set_customer_hidden(text, boolean) TO authenticated;

-- Delete — only a customer added by hand who has no orders (so no payments
-- either) and no website account (hide those instead). Super Admin, or
-- staff with "Manage customers".
CREATE OR REPLACE FUNCTION admin_delete_customer(p_customer_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row customers%ROWTYPE;
BEGIN
  IF NOT (is_admin() OR staff_can('manage_customers')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_row FROM customers WHERE customers.customer_key = p_customer_key FOR UPDATE;
  IF NOT FOUND OR NOT v_row.added_by_hand THEN
    RAISE EXCEPTION 'Only a customer added by hand can be deleted. Hide this customer instead.';
  END IF;
  IF EXISTS (SELECT 1 FROM order_customer_keys() k WHERE k.customer_key = p_customer_key)
     OR (v_row.phone_key IS NOT NULL AND EXISTS (SELECT 1 FROM orders o WHERE bd_phone_key(o.customer_phone) = v_row.phone_key))
     OR (v_row.phone_key IS NOT NULL AND EXISTS (
           SELECT 1 FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = v_row.phone_key)) THEN
    RAISE EXCEPTION 'This customer has orders or an account. Hide them instead.';
  END IF;
  DELETE FROM customers WHERE customers.customer_key = p_customer_key;
  PERFORM write_activity('customer.deleted', 'customer', p_customer_key, v_row.full_name,
    format('Deleted customer %s (%s)', v_row.full_name, v_row.phone), '{}'::jsonb);
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_delete_customer(text) TO authenticated;

-- New order → Customer (Batch 32): the Batch 30 search without hidden
-- customers, plus customers added by hand who have no order yet.
CREATE OR REPLACE FUNCTION admin_find_customers_v2(p_query text)
RETURNS TABLE (
  customer_key text,
  profile_id   uuid,
  full_name    text,
  phone        text,
  alt_phone    text,
  division     text,
  district     text,
  thana        text,
  address_line text,
  order_count  bigint,
  total_due    numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_q    text := trim(COALESCE(p_query, ''));
  v_core text;
BEGIN
  IF NOT (staff_can('create_orders') OR staff_can('view_customers') OR staff_can('edit_orders')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF length(v_q) < 2 THEN
    RETURN;
  END IF;
  v_core := regexp_replace(regexp_replace(regexp_replace(v_q, '[^0-9]', '', 'g'), '^(00)?880', ''), '^0', '');

  RETURN QUERY
  WITH found AS (SELECT * FROM admin_find_customers(v_q))
  SELECT f.customer_key, f.profile_id, f.full_name, f.phone, f.alt_phone, f.division, f.district, f.thana,
         f.address_line, f.order_count, f.total_due
  FROM found f
  WHERE NOT EXISTS (
    SELECT 1 FROM customers c
    WHERE c.hidden AND (c.customer_key = f.customer_key OR (c.phone_key IS NOT NULL AND c.phone_key = bd_phone_key(f.phone)))
  )
  UNION ALL
  SELECT c.customer_key, NULL::uuid, c.full_name, c.phone, c.alt_phone, c.division, c.district, c.thana,
         c.address_line, 0::bigint,
         CASE WHEN staff_can('see_sales') OR staff_can('view_orders') THEN 0::numeric END
  FROM customers c
  WHERE c.added_by_hand AND NOT c.hidden
    AND NOT EXISTS (SELECT 1 FROM found f WHERE f.customer_key = c.customer_key OR bd_phone_key(f.phone) = c.phone_key)
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE bd_phone_key(o.customer_phone) = c.phone_key)
    AND ((length(v_core) >= 3 AND c.phone_key LIKE '%' || v_core || '%')
      OR (length(v_core) < 3 AND c.full_name ILIKE '%' || v_q || '%'));
END;
$$;

GRANT EXECUTE ON FUNCTION admin_find_customers_v2(text) TO authenticated;

-- ---------- Verify ----------
-- 1. SELECT count(*) FROM orders WHERE collect_mode = 'cod';      → every order
-- 2. SELECT 'manage_customers' = ANY (staff_permission_names());  → true
-- 3. SELECT to_regclass('public.customers');                      → customers
-- 4. SELECT count(*) FROM admin_customers_v3();  (as Naeem)       → the Customers list
