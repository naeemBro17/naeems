-- ============================================================
-- Naeem's Price Hub — Migration 033 (Batch 30: edit any order, payments,
-- pick a customer, real Steadfast steps)
-- Run this in the Supabase SQL Editor after migration-032. Safe to re-run.
--
-- ADDITIVE ONLY. No table or column is dropped or renamed, and every
-- existing function keeps its exact name, arguments and meaning, so the
-- live site (built from main) keeps working the moment this runs.
--
-- What it adds:
--   PART 1  A new staff switch "Edit orders" (off for every existing role).
--   PART 2  New order columns: alternative phone, note for the courier, an
--           admin-only customer link, the COD amount Steadfast was given,
--           and the list of details Steadfast still has the old version of.
--   PART 3  order_payments — every payment and refund on an order. Old
--           "paid" orders get one payment row copied from what is saved on
--           them today (nothing is moved or deleted).
--   PART 4  admin_edit_order() — change anything on an order at any stage,
--           with stock kept right and every change in History and the
--           Activity Log.
--   PART 5  Payment functions (add, mark fully paid, edit, delete) and the
--           automatic "COD via Steadfast" payment on a confirmed delivery.
--   PART 6  Customers grouped by phone number (registered or not), with
--           what each one still owes, and the customer search for New order.
--   PART 7  A staff-only cache of Steadfast's tracking steps (so Steadfast
--           is never asked about one parcel more than once a minute).
-- ============================================================


-- ============================================================
-- PART 0 — small helpers
-- ============================================================

-- One key per Bangladeshi mobile number, however it was typed:
-- "+880 1712-345678", "8801712345678", "01712345678" and "1712345678" all
-- become "01712345678". Anything else is kept as its digits.
CREATE OR REPLACE FUNCTION bd_phone_key(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN d ~ '^(00)?8801[0-9]{9}$' THEN right(d, 11)
    WHEN d ~ '^01[0-9]{9}$' THEN d
    WHEN d ~ '^1[0-9]{9}$' THEN '0' || d
    ELSE NULLIF(d, '')
  END
  FROM (SELECT regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g') AS d) x;
$$;

-- "130.00" → "130", "99.50" → "99.5" — for History lines.
CREATE OR REPLACE FUNCTION taka_text(p_amount numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '৳' || trim_scale(COALESCE(p_amount, 0))::text;
$$;

CREATE OR REPLACE FUNCTION payment_method_label(p_method text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_method
    WHEN 'bkash' THEN 'bKash'
    WHEN 'nagad' THEN 'Nagad'
    WHEN 'cash' THEN 'Cash'
    WHEN 'bank' THEN 'Bank'
    WHEN 'cod_steadfast' THEN 'COD via Steadfast'
    ELSE 'Other'
  END;
$$;


-- ============================================================
-- PART 1 — the "Edit orders" switch
-- ============================================================

CREATE OR REPLACE FUNCTION staff_permission_names()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'view_orders', 'change_order_status', 'create_orders', 'book_steadfast',
    'edit_products', 'edit_categories', 'view_customers', 'delete_early_orders',
    'view_wholesalers', 'see_sales', 'edit_brands', 'edit_customer_notes',
    'edit_orders'
  ];
$$;

-- Same as migration-031, plus "Edit orders" switches "View orders" on.
CREATE OR REPLACE FUNCTION normalize_staff_permissions(p_permissions text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  WITH cleaned AS (
    SELECT DISTINCT p FROM unnest(COALESCE(p_permissions, '{}'::text[])) p
    WHERE p = ANY (staff_permission_names())
  ),
  with_view AS (
    SELECT p FROM cleaned
    UNION
    SELECT 'view_orders' WHERE EXISTS (
      SELECT 1 FROM cleaned
      WHERE p IN ('change_order_status', 'create_orders', 'book_steadfast', 'delete_early_orders', 'edit_orders'))
  )
  SELECT COALESCE(array_agg(p ORDER BY array_position(staff_permission_names(), p)), '{}'::text[])
  FROM with_view;
$$;


-- ============================================================
-- PART 2 — new order columns
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS alt_phone text,
  ADD COLUMN IF NOT EXISTS courier_note text,
  -- Admin-only link to a registered customer, set when a manual order is
  -- entered for a customer picked from the list. Unlike customer_id, it
  -- never makes the order appear in that customer's own "My Orders".
  ADD COLUMN IF NOT EXISTS admin_customer_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  -- The COD amount Steadfast was given (at booking, or when Naeem pressed
  -- "Done, I updated Steadfast"). NULL for parcels booked before Batch 30.
  ADD COLUMN IF NOT EXISTS steadfast_cod_amount numeric(10,2),
  -- Details changed after booking that Steadfast still has the old
  -- version of ("Name", "Phone", "Alternative phone", "Address", "Note").
  ADD COLUMN IF NOT EXISTS steadfast_outdated text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_orders_admin_customer ON orders (admin_customer_id);


-- ============================================================
-- PART 3 — order_payments
-- ============================================================

CREATE TABLE IF NOT EXISTS order_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- 'payment' = money in, 'refund' = money given back.
  kind                text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'refund')),
  amount              numeric(10,2) NOT NULL CHECK (amount > 0),
  method              text NOT NULL CHECK (method IN ('bkash', 'nagad', 'cash', 'bank', 'cod_steadfast', 'other')),
  trx_id              text,
  paid_at             timestamptz NOT NULL DEFAULT now(),
  note                text,
  -- Where the row came from: typed by staff ('manual'), "Mark fully paid"
  -- ('mark_paid'), the old "paid" switch ('status_paid'), or Steadfast's
  -- confirmed delivery ('steadfast_cod').
  source              text NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual', 'mark_paid', 'status_paid', 'steadfast_cod')),
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_username text
);

CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments (order_id);
-- "COD via Steadfast" is recorded once per order, never twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_payments_steadfast_cod
  ON order_payments (order_id) WHERE source = 'steadfast_cod';

ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;

-- Staff who can see orders can see their payments. Customers never read
-- this table (their order page uses order_payment_summary() below, which
-- gives only the amounts, never notes or who typed them).
DROP POLICY IF EXISTS "order_payments_staff_read" ON order_payments;
CREATE POLICY "order_payments_staff_read"
  ON order_payments FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

-- Reads only. Every write goes through the functions below.
REVOKE ALL ON order_payments FROM anon, authenticated;
GRANT SELECT ON order_payments TO authenticated;
GRANT ALL ON order_payments TO service_role;

-- Money in minus money given back.
CREATE OR REPLACE FUNCTION order_payment_net(p_order_id uuid)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(sum(CASE WHEN kind = 'refund' THEN -amount ELSE amount END), 0)
  FROM order_payments WHERE order_id = p_order_id;
$$;

REVOKE ALL ON FUNCTION order_payment_net(uuid) FROM PUBLIC, anon, authenticated;

-- Keeps the old orders.payment_status column in step with the payments, so
-- every screen that still reads it (invoice, the old site, Telegram) agrees.
-- 'paid' once everything is paid; otherwise 'unpaid' (a bKash order still
-- waiting for its TrxID check stays 'pending_verification').
CREATE OR REPLACE FUNCTION order_payments_sync(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_net   numeric;
  v_new   text;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_net := order_payment_net(p_order_id);
  v_new := CASE
    WHEN v_net > 0 AND v_net >= v_order.total THEN 'paid'
    WHEN v_order.payment_status = 'pending_verification' AND v_net <= 0 THEN 'pending_verification'
    ELSE 'unpaid'
  END;
  IF v_new IS DISTINCT FROM v_order.payment_status THEN
    PERFORM set_config('app.payments_sync', 'on', true);
    UPDATE orders SET payment_status = v_new, updated_at = now() WHERE id = p_order_id;
    PERFORM set_config('app.payments_sync', 'off', true);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION order_payments_sync(uuid) FROM PUBLIC, anon, authenticated;

-- The old "paid" switch (Mark as paid on a bKash order, a manual order
-- typed in as Cash, or the live site's old code) still works: switching it
-- on records the rest of the money as one payment; switching it off again
-- removes only that automatic row. Payments typed by staff are never
-- touched by this.
CREATE OR REPLACE FUNCTION orders_payment_status_bridge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
        CASE NEW.payment_method WHEN 'bkash' THEN 'bkash' WHEN 'cash' THEN 'cash' ELSE 'other' END,
        CASE WHEN NEW.payment_method = 'bkash' THEN NEW.bkash_trx_id END,
        CASE WHEN NEW.payment_method IN ('bkash', 'cash') THEN NEW.created_at ELSE now() END,
        CASE NEW.payment_method
          WHEN 'bkash' THEN 'bKash advance'
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
$$;

DROP TRIGGER IF EXISTS orders_payment_bridge ON orders;
CREATE TRIGGER orders_payment_bridge
  AFTER INSERT OR UPDATE OF payment_status ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_payment_status_bridge();

-- Orders already marked paid: one payment row copied from what is saved on
-- them today. The order rows themselves are not changed.
INSERT INTO order_payments (order_id, amount, method, trx_id, paid_at, note, source, created_by_username)
SELECT o.id, o.total,
       CASE o.payment_method WHEN 'bkash' THEN 'bkash' WHEN 'cash' THEN 'cash' ELSE 'other' END,
       CASE WHEN o.payment_method = 'bkash' THEN o.bkash_trx_id END,
       CASE WHEN o.payment_method IN ('bkash', 'cash') THEN o.created_at ELSE o.updated_at END,
       CASE o.payment_method
         WHEN 'bkash' THEN 'bKash advance'
         WHEN 'cash' THEN 'Cash paid when the order was entered'
         ELSE 'Marked as paid'
       END,
       'status_paid', 'system'
FROM orders o
WHERE o.payment_status = 'paid' AND o.total > 0
  AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id = o.id);

-- Cash-on-delivery orders already delivered before payments were tracked:
-- the courier collected the money, so it is recorded once as collected.
INSERT INTO order_payments (order_id, amount, method, paid_at, note, source, created_by_username)
SELECT o.id, o.total,
       CASE WHEN o.steadfast_consignment_id IS NOT NULL THEN 'cod_steadfast' ELSE 'cash' END,
       o.updated_at, 'Collected on delivery (recorded before payments were tracked)',
       CASE WHEN o.steadfast_consignment_id IS NOT NULL THEN 'steadfast_cod' ELSE 'status_paid' END,
       'system'
FROM orders o
WHERE o.status = 'delivered' AND o.payment_method = 'cod' AND o.payment_status <> 'paid' AND o.total > 0
  AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id = o.id);


-- ============================================================
-- PART 3b — orders_activity: same as migration-030, plus one line: it
-- stays quiet while a Batch 30 function writes its own, clearer log line
-- (an order edit logs every change in one entry, not one per column).
-- ============================================================
CREATE OR REPLACE FUNCTION orders_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF activity_quiet() THEN
    RETURN NULL;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT is_staff() THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM write_activity(
      'order.deleted', 'order', OLD.id::text, OLD.order_number,
      format('Deleted order %s (%s, ৳%s, was %s)', OLD.order_number, OLD.customer_name, OLD.total, OLD.status),
      jsonb_build_object(
        'order_number', OLD.order_number,
        'customer_name', OLD.customer_name,
        'customer_phone', OLD.customer_phone,
        'total', OLD.total,
        'status', OLD.status,
        'steadfast_consignment_id', OLD.steadfast_consignment_id
      )
    );
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.source <> 'web' THEN
      PERFORM write_activity(
        'order.created', 'order', NEW.id::text, NEW.order_number,
        format('Created manual order %s for %s (৳%s)', NEW.order_number, NEW.customer_name, NEW.total),
        jsonb_build_object('source', NEW.source, 'total', NEW.total)
      );
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM write_activity(
      'order.status', 'order', NEW.id::text, NEW.order_number,
      format('Status %s → %s', OLD.status, NEW.status),
      jsonb_build_object('status', jsonb_build_object('from', OLD.status, 'to', NEW.status))
    );
  END IF;
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    PERFORM write_activity(
      'order.payment', 'order', NEW.id::text, NEW.order_number,
      format('Payment %s → %s', OLD.payment_status, NEW.payment_status),
      jsonb_build_object('payment_status', jsonb_build_object('from', OLD.payment_status, 'to', NEW.payment_status))
    );
  END IF;
  IF NEW.tracking_number IS DISTINCT FROM OLD.tracking_number
     AND NEW.steadfast_consignment_id IS NOT DISTINCT FROM OLD.steadfast_consignment_id THEN
    PERFORM write_activity(
      'order.tracking', 'order', NEW.id::text, NEW.order_number,
      format('Tracking number %s → %s', COALESCE(OLD.tracking_number, '(none)'), COALESCE(NEW.tracking_number, '(none)')),
      jsonb_build_object('tracking_number', jsonb_build_object('from', OLD.tracking_number, 'to', NEW.tracking_number))
    );
  END IF;
  IF NEW.admin_note IS DISTINCT FROM OLD.admin_note THEN
    PERFORM write_activity(
      'order.note', 'order', NEW.id::text, NEW.order_number, 'Admin note changed',
      jsonb_build_object('admin_note', jsonb_build_object('from', OLD.admin_note, 'to', NEW.admin_note))
    );
  END IF;
  IF NEW.delivery_fee IS DISTINCT FROM OLD.delivery_fee THEN
    PERFORM write_activity(
      'order.delivery_fee', 'order', NEW.id::text, NEW.order_number,
      format('Delivery fee ৳%s → ৳%s', OLD.delivery_fee, NEW.delivery_fee),
      jsonb_build_object('delivery_fee', jsonb_build_object('from', OLD.delivery_fee, 'to', NEW.delivery_fee))
    );
  END IF;
  IF OLD.steadfast_consignment_id IS NULL AND NEW.steadfast_consignment_id IS NOT NULL THEN
    PERFORM write_activity(
      'order.steadfast_booked', 'order', NEW.id::text, NEW.order_number,
      format('Booked on Steadfast (consignment %s)', NEW.steadfast_consignment_id),
      jsonb_build_object('consignment_id', NEW.steadfast_consignment_id, 'tracking_code', NEW.steadfast_tracking_code)
    );
  ELSIF NEW.steadfast_status IS DISTINCT FROM OLD.steadfast_status THEN
    PERFORM write_activity(
      'order.steadfast_status', 'order', NEW.id::text, NEW.order_number,
      format('Courier status %s → %s', COALESCE(OLD.steadfast_status, '(none)'), COALESCE(NEW.steadfast_status, '(none)')),
      jsonb_build_object('steadfast_status', jsonb_build_object('from', OLD.steadfast_status, 'to', NEW.steadfast_status))
    );
  END IF;
  RETURN NULL;
END;
$$;


-- ============================================================
-- PART 4 — edit anything on an order, at any stage
-- ============================================================

-- Moves tracked stock for one order line: a positive change puts stock
-- back, a negative one takes it. Never lets tracked stock go below 0.
-- A deleted product/option, or one whose stock isn't tracked, is skipped.
CREATE OR REPLACE FUNCTION order_edit_stock(p_product_id uuid, p_variant_id uuid, p_change integer, p_label text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stock integer;
BEGIN
  IF p_change IS NULL OR p_change = 0 THEN
    RETURN;
  END IF;
  IF p_variant_id IS NOT NULL THEN
    SELECT stock_quantity INTO v_stock FROM product_variants WHERE id = p_variant_id FOR UPDATE;
    IF NOT FOUND OR v_stock IS NULL THEN
      RETURN;
    END IF;
    IF v_stock + p_change < 0 THEN
      RAISE EXCEPTION 'Only % in stock for %.', GREATEST(v_stock, 0), p_label;
    END IF;
    UPDATE product_variants SET stock_quantity = stock_quantity + p_change WHERE id = p_variant_id;
  ELSIF p_product_id IS NOT NULL THEN
    SELECT stock_quantity INTO v_stock FROM products WHERE id = p_product_id FOR UPDATE;
    IF NOT FOUND OR v_stock IS NULL THEN
      RETURN;
    END IF;
    IF v_stock + p_change < 0 THEN
      RAISE EXCEPTION 'Only % in stock for %.', GREATEST(v_stock, 0), p_label;
    END IF;
    UPDATE products SET stock_quantity = stock_quantity + p_change WHERE id = p_product_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION order_edit_stock(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;

-- One History line (the order keeps its status; the note says what changed).
CREATE OR REPLACE FUNCTION order_history_line(p_order_id uuid, p_status text, p_note text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, changed_at, note)
  VALUES (p_order_id, p_status, p_status, auth.uid(), clock_timestamp(), p_note);
$$;

REVOKE ALL ON FUNCTION order_history_line(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- p_changes holds only what changed, any of:
--   customer_name, customer_phone, alt_phone, division, district, thana,
--   address_line, courier_note, delivery_fee, discount, discount_note,
--   items: [{ id (existing line) | product_id + variant_id (new line),
--             quantity, unit_price (optional) }, ...] — the full new list;
--             a line left out is removed.
-- Allowed at any status for the Super Admin and for staff with "Edit
-- orders". Prices and the order discount stay Super Admin only (the same
-- rule as the existing price edit). Stock moves only while the order
-- still holds stock (not cancelled).
CREATE OR REPLACE FUNCTION admin_edit_order(p_order_id uuid, p_changes jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    -- Lines left out: removed, their stock put back.
    FOR v_old IN SELECT * FROM order_items WHERE order_id = p_order_id AND NOT (id = ANY (v_keep)) LOOP
      v_label := v_old.product_name || COALESCE(' (' || v_old.variant_label || ')', '');
      IF v_moves_stock THEN
        PERFORM order_edit_stock(v_old.product_id, v_old.variant_id, v_old.quantity, v_label);
      END IF;
      DELETE FROM order_items WHERE id = v_old.id;
      v_notes := v_notes || format('Removed %s ×%s', v_label, v_old.quantity);
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
          IF v_moves_stock THEN
            PERFORM order_edit_stock(v_old.product_id, v_old.variant_id, v_old.quantity - v_qty, v_label);
          END IF;
          v_notes := v_notes || format('Quantity of %s %s → %s', v_label, v_old.quantity, v_qty);
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
        v_price := COALESCE(v_price, v_list);
        IF v_price <> v_list AND NOT v_is_admin THEN
          RAISE EXCEPTION 'Only the Super Admin can change prices.';
        END IF;
        v_label := v_pname || COALESCE(' (' || v_vlabel || ')', '');
        IF v_moves_stock THEN
          PERFORM order_edit_stock(v_product_id, v_variant_id, -v_qty, v_label);
        END IF;
        INSERT INTO order_items (
          order_id, product_id, variant_id, product_name, variant_label, image_url,
          list_price, unit_price, quantity, line_total, reason
        ) VALUES (
          p_order_id, v_product_id, v_variant_id, v_pname, v_vlabel, v_image,
          v_list, v_price, v_qty, v_price * v_qty,
          CASE WHEN v_price < v_list THEN 'other' END
        );
        v_notes := v_notes || format('Added %s ×%s (%s each)', v_label, v_qty, taka_text(v_price));
      END IF;
    END LOOP;

    PERFORM set_config('app.order_stock_change', 'off', true);
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
                        WHEN v_order.promo_code IS NULL THEN COALESCE(v_order.discount_reason, 'other')
                        ELSE v_order.discount_reason
                      END,
    discount_note   = CASE WHEN v_discount = 0 THEN NULL ELSE v_dnote END,
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
$$;

GRANT EXECUTE ON FUNCTION admin_edit_order(uuid, jsonb) TO authenticated;

-- "Done, I updated Steadfast": the banner goes away, and the COD amount
-- Steadfast now has is taken to be what is due today.
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

  v_due := GREATEST(v_order.total - order_payment_net(p_order_id), 0);
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

-- Called by the steadfast function right after a booking: the COD amount
-- it sent.
CREATE OR REPLACE FUNCTION admin_set_steadfast_cod(p_order_id uuid, p_amount numeric)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT staff_can('book_steadfast') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'Invalid amount.';
  END IF;
  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders SET steadfast_cod_amount = round(p_amount, 2)
  WHERE id = p_order_id AND steadfast_consignment_id IS NOT NULL;
  PERFORM set_config('app.activity_quiet', 'off', true);
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_set_steadfast_cod(uuid, numeric) TO authenticated;


-- ============================================================
-- PART 5 — payments
-- ============================================================

-- Total, paid, due and a plain state for one order. The customer who owns
-- the order may read this (amounts only); staff with "View orders" too.
CREATE OR REPLACE FUNCTION order_payment_summary(p_order_id uuid)
RETURNS TABLE (total numeric, paid numeric, refunded numeric, due numeric, payment_state text)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_order    orders%ROWTYPE;
  v_in       numeric;
  v_out      numeric;
  v_net      numeric;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND OR NOT (COALESCE(v_order.customer_id = auth.uid(), false) OR staff_can('view_orders')) THEN
    RETURN;
  END IF;
  SELECT COALESCE(sum(amount) FILTER (WHERE kind = 'payment'), 0),
         COALESCE(sum(amount) FILTER (WHERE kind = 'refund'), 0)
  INTO v_in, v_out
  FROM order_payments WHERE order_id = p_order_id;
  v_net := v_in - v_out;
  RETURN QUERY SELECT
    v_order.total, v_net, v_out, GREATEST(v_order.total - v_net, 0),
    CASE
      WHEN v_out > 0 AND v_net <= 0 THEN 'refunded'
      WHEN v_net > 0 AND v_net >= v_order.total THEN 'paid'
      WHEN v_net > 0 THEN 'partly_paid'
      ELSE 'unpaid'
    END;
END;
$$;

GRANT EXECUTE ON FUNCTION order_payment_summary(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION payment_history_text(p_kind text, p_amount numeric, p_method text, p_trx text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_kind = 'refund' THEN 'Refund ' ELSE 'Payment ' END
         || taka_text(p_amount) || ' (' || payment_method_label(p_method)
         || COALESCE(', TrxID ' || NULLIF(trim(p_trx), ''), '') || ')';
$$;

-- Add a payment (or a refund) — "Change order status" (which already covers
-- "mark paid"). Refunds are Super Admin only.
CREATE OR REPLACE FUNCTION admin_add_order_payment(
  p_order_id uuid,
  p_amount   numeric,
  p_method   text,
  p_trx_id   text DEFAULT NULL,
  p_paid_at  timestamptz DEFAULT NULL,
  p_note     text DEFAULT NULL,
  p_kind     text DEFAULT 'payment'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order  orders%ROWTYPE;
  v_amount numeric(10,2) := round(p_amount, 2);
  v_kind   text := COALESCE(p_kind, 'payment');
  v_id     uuid;
  v_text   text;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_kind NOT IN ('payment', 'refund') THEN
    RAISE EXCEPTION 'Invalid payment type.';
  END IF;
  IF v_kind = 'refund' AND NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can record a refund.';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be more than 0.';
  END IF;
  IF v_amount > 10000000 THEN
    RAISE EXCEPTION 'That amount is too large.';
  END IF;
  IF p_method NOT IN ('bkash', 'nagad', 'cash', 'bank', 'cod_steadfast', 'other') THEN
    RAISE EXCEPTION 'Choose how it was paid.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  INSERT INTO order_payments (order_id, kind, amount, method, trx_id, paid_at, note, source, created_by, created_by_username)
  VALUES (p_order_id, v_kind, v_amount, p_method, NULLIF(trim(COALESCE(p_trx_id, '')), ''),
          COALESCE(p_paid_at, now()), NULLIF(trim(COALESCE(p_note, '')), ''), 'manual',
          auth.uid(), current_actor_username())
  RETURNING id INTO v_id;

  v_text := payment_history_text(v_kind, v_amount, p_method, p_trx_id) || ' added';
  PERFORM order_history_line(p_order_id, v_order.status, v_text);
  PERFORM write_activity('order.payment_added', 'order', p_order_id::text, v_order.order_number,
    format('%s: %s', v_order.order_number, v_text),
    jsonb_build_object('kind', v_kind, 'amount', v_amount, 'method', p_method));
  PERFORM order_payments_sync(p_order_id);
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_add_order_payment(uuid, numeric, text, text, timestamptz, text, text) TO authenticated;

-- "Mark fully paid": one payment for whatever is still due.
CREATE OR REPLACE FUNCTION admin_mark_order_fully_paid(
  p_order_id uuid,
  p_method   text,
  p_trx_id   text DEFAULT NULL,
  p_note     text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_due   numeric(10,2);
  v_text  text;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_method NOT IN ('bkash', 'nagad', 'cash', 'bank', 'cod_steadfast', 'other') THEN
    RAISE EXCEPTION 'Choose how it was paid.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  v_due := v_order.total - order_payment_net(p_order_id);
  IF v_due <= 0 THEN
    RAISE EXCEPTION 'Nothing is due on this order.';
  END IF;

  INSERT INTO order_payments (order_id, amount, method, trx_id, note, source, created_by, created_by_username)
  VALUES (p_order_id, v_due, p_method, NULLIF(trim(COALESCE(p_trx_id, '')), ''),
          NULLIF(trim(COALESCE(p_note, '')), ''), 'mark_paid', auth.uid(), current_actor_username());

  v_text := 'Marked fully paid: ' || payment_history_text('payment', v_due, p_method, p_trx_id);
  PERFORM order_history_line(p_order_id, v_order.status, v_text);
  PERFORM write_activity('order.payment_added', 'order', p_order_id::text, v_order.order_number,
    format('%s: %s', v_order.order_number, v_text),
    jsonb_build_object('kind', 'payment', 'amount', v_due, 'method', p_method, 'mark_paid', true));
  PERFORM order_payments_sync(p_order_id);
  RETURN v_due;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_mark_order_fully_paid(uuid, text, text, text) TO authenticated;

-- Edit one payment — Super Admin only.
CREATE OR REPLACE FUNCTION admin_update_order_payment(
  p_payment_id uuid,
  p_amount     numeric,
  p_method     text,
  p_trx_id     text,
  p_paid_at    timestamptz,
  p_note       text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pay    order_payments%ROWTYPE;
  v_order  orders%ROWTYPE;
  v_amount numeric(10,2) := round(p_amount, 2);
  v_trx    text := NULLIF(trim(COALESCE(p_trx_id, '')), '');
  v_note   text := NULLIF(trim(COALESCE(p_note, '')), '');
  v_parts  text[] := '{}';
  v_text   text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can change a payment.';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount > 10000000 THEN
    RAISE EXCEPTION 'Amount must be more than 0.';
  END IF;
  IF p_method NOT IN ('bkash', 'nagad', 'cash', 'bank', 'cod_steadfast', 'other') THEN
    RAISE EXCEPTION 'Choose how it was paid.';
  END IF;
  SELECT * INTO v_pay FROM order_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = v_pay.order_id FOR UPDATE;

  IF v_amount <> v_pay.amount THEN
    v_parts := v_parts || format('amount %s → %s', taka_text(v_pay.amount), taka_text(v_amount));
  END IF;
  IF p_method <> v_pay.method THEN
    v_parts := v_parts || format('method %s → %s', payment_method_label(v_pay.method), payment_method_label(p_method));
  END IF;
  IF v_trx IS DISTINCT FROM v_pay.trx_id THEN
    v_parts := v_parts || format('TrxID %s → %s', COALESCE(v_pay.trx_id, '(none)'), COALESCE(v_trx, '(none)'));
  END IF;
  IF p_paid_at IS NOT NULL AND p_paid_at <> v_pay.paid_at THEN
    v_parts := v_parts || 'date changed'::text;
  END IF;
  IF v_note IS DISTINCT FROM v_pay.note THEN
    v_parts := v_parts || 'note changed'::text;
  END IF;
  IF cardinality(v_parts) = 0 THEN
    RETURN true;
  END IF;

  UPDATE order_payments SET
    amount = v_amount, method = p_method, trx_id = v_trx,
    paid_at = COALESCE(p_paid_at, paid_at), note = v_note,
    updated_at = now(), updated_by_username = current_actor_username()
  WHERE id = p_payment_id;

  v_text := payment_history_text(v_pay.kind, v_pay.amount, v_pay.method, v_pay.trx_id)
            || ' changed: ' || array_to_string(v_parts, ', ');
  PERFORM order_history_line(v_order.id, v_order.status, v_text);
  PERFORM write_activity('order.payment_changed', 'order', v_order.id::text, v_order.order_number,
    format('%s: %s', v_order.order_number, v_text),
    jsonb_build_object('payment_id', p_payment_id, 'amount', jsonb_build_object('from', v_pay.amount, 'to', v_amount)));
  PERFORM order_payments_sync(v_order.id);
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_order_payment(uuid, numeric, text, text, timestamptz, text) TO authenticated;

-- Delete one payment — Super Admin only.
CREATE OR REPLACE FUNCTION admin_delete_order_payment(p_payment_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pay   order_payments%ROWTYPE;
  v_order orders%ROWTYPE;
  v_text  text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can delete a payment.';
  END IF;
  SELECT * INTO v_pay FROM order_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = v_pay.order_id FOR UPDATE;

  DELETE FROM order_payments WHERE id = p_payment_id;

  v_text := payment_history_text(v_pay.kind, v_pay.amount, v_pay.method, v_pay.trx_id) || ' deleted';
  PERFORM order_history_line(v_order.id, v_order.status, v_text);
  PERFORM write_activity('order.payment_deleted', 'order', v_order.id::text, v_order.order_number,
    format('%s: %s', v_order.order_number, v_text),
    jsonb_build_object('payment_id', p_payment_id, 'amount', v_pay.amount, 'method', v_pay.method));
  PERFORM order_payments_sync(v_order.id);
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_delete_order_payment(uuid) TO authenticated;

-- Steadfast CONFIRMED delivery (exactly 'delivered' — never an
-- '_approval_pending' status, never 'partial_delivered'): the COD it
-- collected is recorded once as "COD via Steadfast". Works for the manual
-- "Check delivery status", the 3-hourly refresh and the live site's old
-- code alike, because it watches the saved courier status itself.
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

DROP TRIGGER IF EXISTS orders_steadfast_cod ON orders;
CREATE TRIGGER orders_steadfast_cod
  AFTER UPDATE OF steadfast_status ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_record_steadfast_cod();


-- ============================================================
-- PART 6 — customers grouped by phone number
-- ============================================================

-- Which customer each order belongs to, and what is still due on it:
--   1. the order's own online account (a website order), else
--   2. the registered customer Naeem picked for a manual order, else
--   3. a registered customer with the same phone number, else
--   4. the phone number itself (a customer who never made an account).
CREATE OR REPLACE FUNCTION order_customer_keys()
RETURNS TABLE (order_id uuid, customer_key text, profile_id uuid, due numeric)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH prof AS (
    SELECT p.id, bd_phone_key(p.phone) AS pkey, p.created_at
    FROM profiles p WHERE p.role = 'customer'
  ),
  prof_by_key AS (
    SELECT DISTINCT ON (pkey) pkey, id FROM prof WHERE pkey IS NOT NULL ORDER BY pkey, created_at, id
  ),
  paid AS (
    SELECT order_id, sum(CASE WHEN kind = 'refund' THEN -amount ELSE amount END) AS net
    FROM order_payments GROUP BY order_id
  )
  SELECT o.id,
         CASE
           WHEN own.id IS NOT NULL THEN 'p:' || own.id
           WHEN picked.id IS NOT NULL THEN 'p:' || picked.id
           WHEN pk.id IS NOT NULL THEN 'p:' || pk.id
           WHEN bd_phone_key(o.customer_phone) IS NOT NULL THEN 'ph:' || bd_phone_key(o.customer_phone)
           ELSE 'n:' || lower(trim(o.customer_name))
         END,
         COALESCE(own.id, picked.id, pk.id),
         CASE WHEN o.status = 'cancelled' THEN 0 ELSE GREATEST(o.total - COALESCE(pd.net, 0), 0) END
  FROM orders o
  LEFT JOIN prof own ON own.id = o.customer_id
  LEFT JOIN prof picked ON picked.id = o.admin_customer_id
  LEFT JOIN prof_by_key pk ON pk.pkey = bd_phone_key(o.customer_phone)
  LEFT JOIN paid pd ON pd.order_id = o.id;
$$;

REVOKE ALL ON FUNCTION order_customer_keys() FROM PUBLIC, anon, authenticated;

-- The Customers page: every registered customer, plus everyone who only
-- ever ordered through Naeem (grouped by phone number). Money columns
-- follow the same switches as before ("See sales figures" for spent;
-- "See sales figures" or "View orders" for what is due).
CREATE OR REPLACE FUNCTION admin_customers_v2()
RETURNS TABLE (
  customer_key  text,
  profile_id    uuid,
  full_name     text,
  email         text,
  phone         text,
  order_count   bigint,
  total_spent   numeric,
  total_due     numeric,
  last_order_at timestamptz,
  joined_at     timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH k AS (SELECT * FROM order_customer_keys()),
  agg AS (
    SELECT k.customer_key,
           count(*) FILTER (WHERE o.status <> 'cancelled') AS order_count,
           COALESCE(sum(o.total) FILTER (WHERE o.status <> 'cancelled'), 0) AS spent,
           COALESCE(sum(k.due), 0) AS due,
           max(o.created_at) AS last_at,
           (array_agg(o.customer_name ORDER BY o.created_at DESC))[1] AS last_name,
           (array_agg(o.customer_phone ORDER BY o.created_at DESC))[1] AS last_phone
    FROM k JOIN orders o ON o.id = k.order_id
    GROUP BY k.customer_key
  ),
  allrows AS (
    SELECT 'p:' || p.id AS customer_key, p.id AS profile_id, COALESCE(p.full_name, '') AS full_name,
           u.email::text AS email, COALESCE(p.phone, '') AS phone,
           COALESCE(a.order_count, 0) AS order_count, COALESCE(a.spent, 0) AS spent,
           COALESCE(a.due, 0) AS due, a.last_at, p.created_at AS joined_at
    FROM profiles p
    JOIN auth.users u ON u.id = p.id
    LEFT JOIN agg a ON a.customer_key = 'p:' || p.id
    WHERE p.role = 'customer'
    UNION ALL
    SELECT a.customer_key, NULL::uuid, COALESCE(a.last_name, ''), '', COALESCE(a.last_phone, ''),
           a.order_count, a.spent, a.due, a.last_at, NULL::timestamptz
    FROM agg a
    WHERE a.customer_key NOT LIKE 'p:%'
  )
  SELECT r.customer_key, r.profile_id, r.full_name, r.email, r.phone, r.order_count,
         CASE WHEN staff_can('see_sales') THEN r.spent END,
         CASE WHEN staff_can('see_sales') OR staff_can('view_orders') THEN r.due END,
         r.last_at, r.joined_at
  FROM allrows r
  WHERE staff_can('view_customers')
  ORDER BY r.last_at DESC NULLS LAST, r.joined_at DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION admin_customers_v2() TO authenticated;

-- One customer's orders (by the key above), with what is due on each.
CREATE OR REPLACE FUNCTION admin_customer_orders_v2(p_customer_key text)
RETURNS TABLE (id uuid, order_number text, created_at timestamptz, status text, item_count bigint, total numeric, due numeric)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT o.id, o.order_number, o.created_at, o.status,
         (SELECT COALESCE(sum(i.quantity), 0) FROM order_items i WHERE i.order_id = o.id),
         CASE WHEN staff_can('see_sales') OR staff_can('view_orders') THEN o.total END,
         CASE WHEN staff_can('see_sales') OR staff_can('view_orders') THEN k.due END
  FROM order_customer_keys() k
  JOIN orders o ON o.id = k.order_id
  WHERE staff_can('view_customers') AND k.customer_key = p_customer_key
  ORDER BY o.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION admin_customer_orders_v2(text) TO authenticated;

-- New order → Customer: matches by phone (any way it was typed) or name.
-- Returns the last address used, to fill the form.
CREATE OR REPLACE FUNCTION admin_find_customers(p_query text)
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
  v_q      text := trim(COALESCE(p_query, ''));
  v_digits text := regexp_replace(v_q, '[^0-9]', '', 'g');
  v_core   text;
BEGIN
  IF NOT (staff_can('create_orders') OR staff_can('view_customers') OR staff_can('edit_orders')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF length(v_q) < 2 THEN
    RETURN;
  END IF;
  -- The part of a typed number that survives any prefix: "+880 17..",
  -- "017.." and "17.." all search for "17..".
  v_core := regexp_replace(v_digits, '^(00)?880', '');
  v_core := regexp_replace(v_core, '^0', '');

  RETURN QUERY
  WITH k AS (SELECT * FROM order_customer_keys()),
  last_order AS (
    SELECT DISTINCT ON (k.customer_key) k.customer_key, o.customer_name, o.customer_phone, o.alt_phone,
           o.division, o.district, o.thana, o.address_line
    FROM k JOIN orders o ON o.id = k.order_id
    ORDER BY k.customer_key, o.created_at DESC
  ),
  counts AS (
    SELECT k.customer_key, count(*) FILTER (WHERE o.status <> 'cancelled') AS n, COALESCE(sum(k.due), 0) AS due
    FROM k JOIN orders o ON o.id = k.order_id GROUP BY k.customer_key
  ),
  people AS (
    SELECT 'p:' || p.id AS customer_key, p.id AS profile_id,
           COALESCE(NULLIF(lo.customer_name, ''), p.full_name, '') AS full_name,
           COALESCE(NULLIF(p.phone, ''), lo.customer_phone, '') AS phone,
           lo.alt_phone,
           COALESCE(lo.division, p.division, '') AS division,
           COALESCE(lo.district, p.district, '') AS district,
           COALESCE(lo.thana, p.thana, '') AS thana,
           COALESCE(lo.address_line, p.address_line, '') AS address_line
    FROM profiles p
    LEFT JOIN last_order lo ON lo.customer_key = 'p:' || p.id
    WHERE p.role = 'customer'
    UNION ALL
    SELECT lo.customer_key, NULL::uuid, lo.customer_name, lo.customer_phone, lo.alt_phone,
           lo.division, lo.district, lo.thana, lo.address_line
    FROM last_order lo
    WHERE lo.customer_key NOT LIKE 'p:%'
  )
  SELECT pe.customer_key, pe.profile_id, pe.full_name, pe.phone, pe.alt_phone,
         pe.division, pe.district, pe.thana, pe.address_line,
         COALESCE(c.n, 0),
         CASE WHEN staff_can('see_sales') OR staff_can('view_orders') THEN COALESCE(c.due, 0) END
  FROM people pe
  LEFT JOIN counts c ON c.customer_key = pe.customer_key
  WHERE (length(v_core) >= 3 AND regexp_replace(COALESCE(pe.phone, ''), '[^0-9]', '', 'g') LIKE '%' || v_core || '%')
     OR (length(v_core) < 3 AND pe.full_name ILIKE '%' || v_q || '%')
  ORDER BY COALESCE(c.n, 0) DESC, pe.full_name
  LIMIT 8;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_find_customers(text) TO authenticated;

-- Links a manual order to the registered customer picked in New order —
-- admin only: it never shows in that customer's own "My Orders".
CREATE OR REPLACE FUNCTION admin_link_order_customer(p_order_id uuid, p_profile_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (staff_can('create_orders') OR staff_can('edit_orders')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_profile_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_profile_id AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;
  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders SET admin_customer_id = p_profile_id WHERE id = p_order_id;
  PERFORM set_config('app.activity_quiet', 'off', true);
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_link_order_customer(uuid, uuid) TO authenticated;


-- ============================================================
-- PART 7 — Steadfast tracking steps cache (staff only)
-- ============================================================

-- The last answer from Steadfast's /trackings_by_invoice for one parcel.
-- Written only by the steadfast functions (service role). The full steps
-- (rider name and phone included) are staff only; customers get a cleaned
-- copy from the steadfast function, never this table.
CREATE TABLE IF NOT EXISTS steadfast_tracking_cache (
  order_id        uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  delivery_status text,
  events          jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE steadfast_tracking_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "steadfast_tracking_cache_staff_read" ON steadfast_tracking_cache;
CREATE POLICY "steadfast_tracking_cache_staff_read"
  ON steadfast_tracking_cache FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

REVOKE ALL ON steadfast_tracking_cache FROM anon, authenticated;
GRANT SELECT ON steadfast_tracking_cache TO authenticated;
GRANT ALL ON steadfast_tracking_cache TO service_role;

-- ============================================================
-- ---------- Verify ----------
-- 1. SELECT bd_phone_key('+880 1712-345678'), bd_phone_key('01712345678'); → 01712345678 twice
-- 2. SELECT count(*) FROM order_payments;                       → paid / delivered COD orders copied
-- 3. SELECT 'edit_orders' = ANY (staff_permission_names());     → true
-- 4. SELECT customer_key, full_name, total_due FROM admin_customers_v2(); (as admin)
-- ============================================================
