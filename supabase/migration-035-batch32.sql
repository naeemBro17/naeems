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
