-- ============================================================
-- Naeem's Price Hub — Migration 025 (Batch 20: Steadfast Courier)
-- Run this in the Supabase SQL Editor. Safe to re-run.
--
-- Adds three columns to `orders` for the Steadfast booking (consignment id,
-- tracking code, and Steadfast's own raw status text), and two functions
-- that are the ONLY way those columns (and the status/tracking_number they
-- drive) ever get written — same pattern as every other order write in this
-- project (place_order, cancel_order, admin_set_order_status,
-- admin_update_order_delivery_fee): a SECURITY DEFINER function that checks
-- is_admin() itself and re-validates the order's own state before writing,
-- never trusting the caller.
--
-- No grant changes needed: `orders` already has a blanket (not
-- column-restricted) SELECT grant for authenticated (migration-021), so the
-- three new columns are readable the moment they exist; and both functions
-- below run as their owner (bypassing table grants entirely), the same way
-- every other admin write function here already does.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS steadfast_consignment_id text,
  ADD COLUMN IF NOT EXISTS steadfast_tracking_code  text,
  ADD COLUMN IF NOT EXISTS steadfast_status         text;

-- ---------- Booking a parcel ----------
-- Called once, right after the Edge Function's call to Steadfast's
-- create_order succeeds. Re-checks the order is still 'confirmed' and not
-- already booked (defense in depth against a double-click racing two admin
-- sessions — the Edge Function also checks this before ever calling
-- Steadfast, this is the second, authoritative check).
CREATE OR REPLACE FUNCTION admin_record_steadfast_shipment(
  p_order_id        uuid,
  p_consignment_id  text,
  p_tracking_code   text,
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
    steadfast_status         = p_courier_status,
    tracking_number          = p_tracking_code,
    status                   = 'shipped',
    updated_at               = now()
  WHERE id = p_order_id;

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_order.status, 'shipped', auth.uid(), 'Steadfast-এ পাঠানো হয়েছে');

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_record_steadfast_shipment(uuid, text, text, text) TO authenticated;

-- ---------- Refreshing delivery status ----------
-- p_mark_delivered is decided by the Edge Function (true only when
-- Steadfast's own delivery_status reads "delivered" or "partial_delivered")
-- — everything else (cancelled, hold, on the way, unknown) just updates the
-- visible steadfast_status text so Naeem can see it, exactly as the batch
-- spec asks ("don't auto-cancel; just show the courier status and flag it
-- for Naeem").
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
    VALUES (p_order_id, v_old_status, 'delivered', auth.uid(), 'Steadfast: ডেলিভারি সম্পন্ন হয়েছে');
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_steadfast_status(uuid, text, boolean) TO authenticated;

-- ============================================================
-- ---------- Verify ----------
-- 1. SELECT steadfast_consignment_id, steadfast_tracking_code, steadfast_status
--      FROM orders LIMIT 1;
--      → all three come back null, not an error.
-- 2. As admin, on a real 'confirmed' order:
--      SELECT admin_record_steadfast_shipment('<order id>', '12345', 'ABC123', 'in_review');
--      → succeeds; that order's status becomes 'shipped', tracking_number
--        becomes 'ABC123', and a new history row appears.
-- 3. Same call again on the same order → must fail ("already been booked").
-- 4. As a non-admin session: either call → must fail with 'Not authorized.'
-- ============================================================
