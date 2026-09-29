-- ============================================================
-- Migration 029 — English order-history notes (Batch 23 Part 6)
-- ============================================================
-- The three Steadfast functions wrote their order-history note in Bengali.
-- This re-creates them EXACTLY as migrations 025/026 left them, changing
-- only that note text to English, and translates the notes already saved.
--
-- Optional: the admin screen already shows these old notes in English
-- without this (see src/lib/orderHistoryNotes.ts). Running it just makes
-- the stored text itself English. Safe to run more than once.
-- ============================================================

CREATE OR REPLACE FUNCTION admin_record_steadfast_shipment(
  p_order_id        uuid,
  p_consignment_id  text,
  p_tracking_code   text,
  p_tracking_link   text,
  p_courier_status  text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Order is not confirmed.';
  END IF;
  IF v_order.steadfast_consignment_id IS NOT NULL THEN
    RAISE EXCEPTION 'This order has already been booked with Steadfast.';
  END IF;

  UPDATE orders SET
    steadfast_consignment_id = p_consignment_id,
    steadfast_tracking_code  = p_tracking_code,
    steadfast_tracking_link  = NULLIF(p_tracking_link, ''),
    steadfast_status         = p_courier_status,
    tracking_number          = p_tracking_code,
    status                   = 'shipped',
    updated_at               = now()
  WHERE id = p_order_id;

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_order.status, 'shipped', auth.uid(), 'Sent to Steadfast');

  RETURN true;
END;
$$;

-- Old 4-argument version (pre-migration-026) is now shadowed by the 5-arg
-- one above; drop it so nothing accidentally still resolves to it.
DROP FUNCTION IF EXISTS admin_record_steadfast_shipment(uuid, text, text, text);

GRANT EXECUTE ON FUNCTION admin_record_steadfast_shipment(uuid, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION admin_update_steadfast_status(
  p_order_id       uuid,
  p_courier_status text,
  p_mark_delivered boolean DEFAULT false
)
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

  SELECT status INTO v_old_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  UPDATE orders SET steadfast_status = p_courier_status, updated_at = now()
  WHERE id = p_order_id;

  IF p_mark_delivered AND v_old_status NOT IN ('delivered', 'cancelled') THEN
    UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = p_order_id;
    INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
    VALUES (p_order_id, v_old_status, 'delivered', auth.uid(), 'Steadfast: delivered');
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_steadfast_status(uuid, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION system_update_steadfast_status(
  p_order_id       uuid,
  p_courier_status text,
  p_mark_delivered boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_status text;
BEGIN
  SELECT status INTO v_old_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  UPDATE orders SET steadfast_status = p_courier_status, updated_at = now()
  WHERE id = p_order_id;

  IF p_mark_delivered AND v_old_status NOT IN ('delivered', 'cancelled') THEN
    UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = p_order_id;
    INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
    VALUES (p_order_id, v_old_status, 'delivered', NULL, 'Steadfast (auto): delivered');
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION system_update_steadfast_status(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION system_update_steadfast_status(uuid, text, boolean) TO service_role;

-- ---------- Translate notes already saved ----------
UPDATE order_status_history SET note = 'Sent to Steadfast'
WHERE note = 'Steadfast-এ পাঠানো হয়েছে';

UPDATE order_status_history SET note = 'Steadfast: delivered'
WHERE note = 'Steadfast: ডেলিভারি সম্পন্ন হয়েছে';

UPDATE order_status_history SET note = 'Steadfast (auto): delivered'
WHERE note = 'Steadfast (auto): ডেলিভারি সম্পন্ন হয়েছে';

-- ---------- Verify ----------
-- Should return 0:
-- SELECT count(*) FROM order_status_history WHERE note ~ '[ঀ-৿]';
