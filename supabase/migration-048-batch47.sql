-- =====================================================================
-- Batch 47 — admin and customer bug fixes + settle a payout line by hand
--
-- Paste the whole file into the Supabase SQL Editor and press Run.
-- It is safe to run more than once. Nothing here changes any money,
-- stock, lot or payout amount by itself.
--
--   1. admin_set_order_source   — change an order's Source (Shop/in person
--                                  and the others) from Edit order.
--   2. admin_link_order_customer — an order the admin makes for a customer
--                                  with an account shows in her My Orders
--                                  (and the 1 older such order is fixed).
--   3. admin_move_order_customer — move an order to another customer
--                                  (Super Admin only).
--   4. admin_settle_payout_line / admin_unsettle_payout_line — settle a
--                                  Steadfast payout line by hand, and undo
--                                  it (Super Admin only).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Change an order's Source (Task 4)
--
-- Same permission as editing an order. Only the source changes; the
-- delivery charge is saved separately by admin_edit_order (the form puts
-- 0 there when Shop/in person is picked, and he may type another amount).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_order_source(p_order_id uuid, p_source text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_order orders%ROWTYPE;
BEGIN
  IF NOT staff_can('edit_orders') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('web', 'facebook', 'whatsapp', 'phone', 'shop', 'family', 'other') THEN
    RAISE EXCEPTION 'Invalid order source.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.source = p_source THEN
    RETURN;
  END IF;
  UPDATE orders SET source = p_source, updated_at = now() WHERE id = p_order_id;
  PERFORM write_activity(
    'order.source', 'order', v_order.id::text, v_order.order_number,
    format('Source %s → %s', v_order.source, p_source),
    jsonb_build_object('source', jsonb_build_object('from', v_order.source, 'to', p_source))
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_order_source(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_order_source(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. An admin order for a customer with an account shows in her My Orders
--    (Task 6a)
--
-- My Orders lists orders.customer_id (the login). Until now picking a
-- customer in New order set only admin_customer_id (the admin's own link),
-- so the order never reached her My Orders. Now both are set — never over
-- an order that already belongs to another login (that is what "Move
-- order to another customer" is for).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_link_order_customer(p_order_id uuid, p_profile_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (staff_can('create_orders') OR staff_can('edit_orders')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_profile_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_profile_id AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;
  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders
     SET admin_customer_id = p_profile_id,
         customer_id = CASE WHEN customer_id IS NULL THEN p_profile_id ELSE customer_id END
   WHERE id = p_order_id;
  PERFORM set_config('app.activity_quiet', 'off', true);
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_link_order_customer(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_link_order_customer(uuid, uuid) TO authenticated;

-- The older admin orders linked to a customer account in the admin only:
-- they now show in that customer's My Orders too. Only the owner columns
-- change — no money, stock or status — so no lock, alert or log fires.
DO $$
BEGIN
  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders o
     SET customer_id = o.admin_customer_id
   WHERE o.customer_id IS NULL
     AND o.admin_customer_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = o.admin_customer_id AND p.role = 'customer');
  PERFORM set_config('app.activity_quiet', 'off', true);
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Move an order to another customer (Task 6b)
--
-- For an order that sits in the wrong account (placed while logged in as
-- someone else). Super Admin only. Everything the order is linked to a
-- person by moves: the login (customer_id, My Orders), the admin's
-- customer link (admin_customer_id, the Customers list) and the order's
-- due reminders (customer_key). Nothing else is touched — not the money,
-- payments, stock, lots, Steadfast or payout rows, and not the delivery
-- name / phone / address printed on it (that is where it was sent). Safe
-- on a delivered and paid order, and in a locked month (only the owner
-- columns change).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_move_order_customer(p_order_id uuid, p_profile_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_order   orders%ROWTYPE;
  v_to      profiles%ROWTYPE;
  v_from    text;
  v_label   text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_to FROM profiles WHERE id = p_profile_id AND role = 'customer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.customer_id IS NOT DISTINCT FROM p_profile_id
     AND v_order.admin_customer_id IS NOT DISTINCT FROM p_profile_id THEN
    RETURN jsonb_build_object('order_number', v_order.order_number, 'moved', false);
  END IF;

  SELECT COALESCE(NULLIF(trim(p.full_name), ''), NULLIF(trim(u.email), ''), p.id::text) INTO v_from
    FROM profiles p LEFT JOIN auth.users u ON u.id = p.id
   WHERE p.id = COALESCE(v_order.customer_id, v_order.admin_customer_id);
  v_label := COALESCE(NULLIF(trim(v_to.full_name), ''), NULLIF(trim((SELECT u.email FROM auth.users u WHERE u.id = v_to.id)), ''), v_to.id::text);

  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders SET customer_id = p_profile_id, admin_customer_id = p_profile_id WHERE id = p_order_id;
  UPDATE customer_due_reminders SET customer_key = 'p:' || p_profile_id WHERE order_id = p_order_id;
  PERFORM set_config('app.activity_quiet', 'off', true);

  PERFORM write_activity(
    'order.customer', 'order', v_order.id::text, v_order.order_number,
    format('Moved order %s from %s to %s', v_order.order_number, COALESCE(v_from, 'no account'), v_label),
    jsonb_build_object(
      'customer_id', jsonb_build_object('from', v_order.customer_id, 'to', p_profile_id),
      'admin_customer_id', jsonb_build_object('from', v_order.admin_customer_id, 'to', p_profile_id)
    )
  );
  RETURN jsonb_build_object('order_number', v_order.order_number, 'moved', true, 'to', v_label);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_move_order_customer(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_move_order_customer(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. Settle a payout line by hand (Task 12)
--
-- The same mechanism Batch 46 used for NM-3315 and NM-1721: the line's
-- kind (line_kind) says how its money is booked, match_status becomes
-- 'matched' and the note says why. Now Naeem does it from the payout
-- screen, with a reason, his note, and who / when; and he can undo it.
--
--   Reason                 Line without an order          Line with an order
--   Courier charge only    returned (charge = cost)       stays order
--   Returned parcel        returned (charge = cost)       stays order
--   Paid to me directly    returned (charge = cost)       stays order
--   Order deleted          returned (charge = cost)       not allowed
--   Not a shop sale        courier_only (outside sales)   not allowed
--   Other (with a note)    courier_only (outside sales)   stays order
--
-- "returned" books only Steadfast's charge, so it is allowed only when
-- Steadfast collected nothing for the parcel. No amount on the line ever
-- changes, so every payout still adds up to what Steadfast paid. A line
-- still linked to its order keeps being booked through that order.
-- ---------------------------------------------------------------------
ALTER TABLE steadfast_payout_items ADD COLUMN IF NOT EXISTS settle_reason text;
ALTER TABLE steadfast_payout_items ADD COLUMN IF NOT EXISTS settle_note text;
ALTER TABLE steadfast_payout_items ADD COLUMN IF NOT EXISTS settled_by uuid;
ALTER TABLE steadfast_payout_items ADD COLUMN IF NOT EXISTS settled_by_username text;
ALTER TABLE steadfast_payout_items ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE steadfast_payout_items ADD COLUMN IF NOT EXISTS settle_undo jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'steadfast_payout_items_settle_reason_check') THEN
    ALTER TABLE steadfast_payout_items ADD CONSTRAINT steadfast_payout_items_settle_reason_check
      CHECK (settle_reason IS NULL OR settle_reason IN
        ('courier_charge', 'returned', 'paid_direct', 'not_shop_sale', 'order_deleted', 'other'));
  END IF;
END $$;

-- The two lines Batch 46 settled get their reason (who: Batch 46).
UPDATE steadfast_payout_items SET settle_reason = 'not_shop_sale', settled_by_username = 'Batch 46'
 WHERE upper(trim(invoice)) = 'NM-3315' AND line_kind = 'courier_only' AND settle_reason IS NULL;
UPDATE steadfast_payout_items SET settle_reason = 'order_deleted', settled_by_username = 'Batch 46'
 WHERE upper(trim(invoice)) = 'NM-1721' AND line_kind = 'returned' AND settle_reason IS NULL;

-- The Batch 46 guard, plus two things: a hand-settled line that is still
-- linked to its order keeps its settlement when Steadfast is read again,
-- and an undo never changes an order's payment.
CREATE OR REPLACE FUNCTION public.steadfast_payout_item_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pay   order_payments%ROWTYPE;
  v_order orders%ROWTYPE;
  v_text  text;
BEGIN
  -- A settled line (courier only / returned) keeps its settlement when
  -- Steadfast is read again; only a deliberate change of kind changes it.
  IF TG_OP = 'UPDATE' AND OLD.line_kind <> 'order' AND NEW.line_kind = OLD.line_kind THEN
    NEW.order_id := OLD.order_id;
    NEW.match_status := OLD.match_status;
    NEW.match_reason := OLD.match_reason;
    NEW.note := OLD.note;
    RETURN NEW;
  END IF;

  -- Batch 47: a line settled by hand that is still linked to its order
  -- (kind 'order') keeps its settlement too, the same way.
  IF TG_OP = 'UPDATE' AND OLD.settled_at IS NOT NULL AND NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at
     AND NEW.line_kind = OLD.line_kind THEN
    NEW.order_id := OLD.order_id;
    NEW.match_status := OLD.match_status;
    NEW.match_reason := OLD.match_reason;
    NEW.note := OLD.note;
    RETURN NEW;
  END IF;

  -- Batch 47: undoing a settle puts the line back exactly as it was; it
  -- never changes an order's payment on the way.
  IF COALESCE(current_setting('payout.unsettle', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  -- Steadfast collected a different COD than the order's "COD via
  -- Steadfast" payment says: the payment becomes what was collected.
  IF NEW.line_kind = 'order' AND NEW.order_id IS NOT NULL AND NEW.match_reason = 'cod_differs'
     AND NEW.cod_collected > 0 THEN
    SELECT * INTO v_pay FROM order_payments
    WHERE order_id = NEW.order_id AND source = 'steadfast_cod' AND kind = 'payment';
    IF FOUND THEN
      v_text := format('Steadfast collected %s (booked %s); the order''s "COD via Steadfast" payment is %s',
                       taka_text(NEW.cod_collected), taka_text(COALESCE(NEW.expected_cod, v_pay.amount)),
                       taka_text(NEW.cod_collected));
      IF v_pay.amount = NEW.cod_collected THEN
        NEW.match_status := 'matched';
        NEW.match_reason := NULL;
        NEW.note := v_text;
      ELSE
        BEGIN
          UPDATE order_payments
          SET amount = NEW.cod_collected, updated_at = now(), updated_by_username = 'steadfast'
          WHERE id = v_pay.id;
          SELECT * INTO v_order FROM orders WHERE id = NEW.order_id;
          PERFORM order_history_line(NEW.order_id, v_order.status,
            format('COD via Steadfast changed from %s to %s: the Steadfast payout shows %s collected',
                   taka_text(v_pay.amount), taka_text(NEW.cod_collected), taka_text(NEW.cod_collected)));
          PERFORM write_activity('order.payment_changed', 'order', NEW.order_id::text, v_order.order_number,
            format('%s: COD via Steadfast changed from %s to %s (Steadfast payout)', v_order.order_number,
                   taka_text(v_pay.amount), taka_text(NEW.cod_collected)),
            jsonb_build_object('payment_id', v_pay.id, 'amount',
                               jsonb_build_object('from', v_pay.amount, 'to', NEW.cod_collected)));
          PERFORM order_payments_sync(NEW.order_id);
          NEW.match_status := 'matched';
          NEW.match_reason := NULL;
          NEW.note := v_text;
        EXCEPTION WHEN OTHERS THEN
          -- e.g. the month is locked: the line stays "to check" with why.
          NEW.note := left(COALESCE(NEW.note, '') || ' (payment not changed: ' || SQLERRM || ')', 500);
        END;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.payout_settle_label(p_reason text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
AS $function$
  SELECT CASE p_reason
    WHEN 'courier_charge' THEN 'Courier charge only (nothing collected)'
    WHEN 'returned' THEN 'Returned parcel (nothing collected)'
    WHEN 'paid_direct' THEN 'Paid to me directly'
    WHEN 'not_shop_sale' THEN 'Not a shop sale'
    WHEN 'order_deleted' THEN 'Order deleted'
    WHEN 'other' THEN 'Other'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_settle_payout_line(p_item_id uuid, p_reason text, p_note text DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_item   steadfast_payout_items%ROWTYPE;
  v_paid   timestamptz;
  v_note   text := NULLIF(left(trim(COALESCE(p_note, '')), 200), '');
  v_kind   text;
  v_order  text;
  v_text   text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF payout_settle_label(p_reason) IS NULL THEN
    RAISE EXCEPTION 'Pick a reason.';
  END IF;
  IF p_reason = 'other' AND v_note IS NULL THEN
    RAISE EXCEPTION 'Write a short note for "Other".';
  END IF;
  SELECT * INTO v_item FROM steadfast_payout_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout line not found.';
  END IF;
  IF v_item.line_kind <> 'order' OR v_item.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This line is already settled. Undo it first to pick another reason.';
  END IF;
  IF v_item.match_status <> 'to_check' THEN
    RAISE EXCEPTION 'This line is already matched to its order.';
  END IF;
  SELECT paid_at INTO v_paid FROM steadfast_payouts WHERE id = v_item.payout_id;
  IF v_paid IS NOT NULL AND money_any_month_locked() THEN
    PERFORM money_lock_refuse(money_dhaka_date(v_paid), 'a Steadfast payout line');
  END IF;

  IF v_item.order_id IS NOT NULL THEN
    SELECT order_number INTO v_order FROM orders WHERE id = v_item.order_id;
    IF p_reason IN ('not_shop_sale', 'order_deleted') THEN
      RAISE EXCEPTION 'This line belongs to order %, which is still there. Pick another reason.', COALESCE(v_order, '(an order)');
    END IF;
    v_kind := 'order';
    v_text := payout_settle_label(p_reason);
  ELSIF p_reason IN ('not_shop_sale', 'other') THEN
    v_kind := 'courier_only';
    v_text := payout_settle_label(p_reason) || ': kept outside sales';
  ELSE
    IF v_item.cod_collected <> 0 THEN
      RAISE EXCEPTION 'Steadfast collected % for this parcel, so it is not "%". Pick "Not a shop sale" or "Other".',
        taka_text(v_item.cod_collected), payout_settle_label(p_reason);
    END IF;
    v_kind := 'returned';
    v_text := payout_settle_label(p_reason) || ': the charge counts as a delivery cost';
  END IF;
  IF v_note IS NOT NULL THEN
    v_text := v_text || ' — ' || v_note;
  END IF;

  UPDATE steadfast_payout_items
     SET settle_undo = jsonb_build_object('line_kind', line_kind, 'match_status', match_status,
                                          'match_reason', match_reason, 'note', note),
         line_kind = v_kind,
         match_status = 'matched',
         match_reason = NULL,
         note = left(v_text, 500),
         settle_reason = p_reason,
         settle_note = v_note,
         settled_by = auth.uid(),
         settled_by_username = current_actor_username(),
         settled_at = now()
   WHERE id = p_item_id;

  PERFORM write_activity(
    'payout.settle', 'payout', v_item.payout_id::text, COALESCE(v_item.invoice, v_item.consignment_id),
    format('Settled payout line %s: %s', COALESCE(v_item.invoice, v_item.consignment_id, v_item.item_key), v_text),
    jsonb_build_object('item_id', v_item.id, 'reason', p_reason, 'note', v_note, 'line_kind', v_kind)
  );
  RETURN jsonb_build_object('line_kind', v_kind, 'note', v_text);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_unsettle_payout_line(p_item_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_item  steadfast_payout_items%ROWTYPE;
  v_paid  timestamptz;
  v_undo  jsonb;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_item FROM steadfast_payout_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout line not found.';
  END IF;
  IF v_item.line_kind = 'order' AND v_item.settled_at IS NULL THEN
    RAISE EXCEPTION 'This line is not settled.';
  END IF;
  SELECT paid_at INTO v_paid FROM steadfast_payouts WHERE id = v_item.payout_id;
  IF v_paid IS NOT NULL AND money_any_month_locked() THEN
    PERFORM money_lock_refuse(money_dhaka_date(v_paid), 'a Steadfast payout line');
  END IF;
  -- Back to what it was; a line settled before Batch 47 (no saved state)
  -- goes back to "to check: order not found".
  v_undo := COALESCE(v_item.settle_undo, jsonb_build_object(
    'line_kind', 'order', 'match_status', 'to_check',
    'match_reason', CASE WHEN v_item.order_id IS NULL THEN 'order_not_found' END,
    'note', CASE WHEN v_item.order_id IS NULL THEN 'Order not found' END));

  PERFORM set_config('payout.unsettle', 'on', true);
  UPDATE steadfast_payout_items
     SET line_kind = COALESCE(v_undo ->> 'line_kind', 'order'),
         match_status = COALESCE(v_undo ->> 'match_status', 'to_check'),
         match_reason = v_undo ->> 'match_reason',
         note = v_undo ->> 'note',
         settle_reason = NULL,
         settle_note = NULL,
         settled_by = NULL,
         settled_by_username = NULL,
         settled_at = NULL,
         settle_undo = NULL
   WHERE id = p_item_id;
  PERFORM set_config('payout.unsettle', '', true);

  PERFORM write_activity(
    'payout.unsettle', 'payout', v_item.payout_id::text, COALESCE(v_item.invoice, v_item.consignment_id),
    format('Undid the settle of payout line %s (was: %s)', COALESCE(v_item.invoice, v_item.consignment_id, v_item.item_key), COALESCE(v_item.note, '-')),
    jsonb_build_object('item_id', v_item.id, 'reason', v_item.settle_reason)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_settle_payout_line(uuid, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.admin_unsettle_payout_line(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_settle_payout_line(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unsettle_payout_line(uuid) TO authenticated;

COMMIT;
