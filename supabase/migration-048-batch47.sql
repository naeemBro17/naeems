-- =====================================================================
-- Batch 47 — admin and customer bug fixes + settle a payout line by hand
--
-- Paste the whole file into the Supabase SQL Editor and press Run.
-- It is safe to run more than once. Nothing here changes any money,
-- stock, lot or payout amount by itself.
--
--   1. admin_set_order_source   — change an order's Source (Shop/in person
--                                  and the others) from Edit order.
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

COMMIT;
