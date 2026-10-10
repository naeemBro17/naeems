-- ============================================================
-- migration-041 — Fix: order actions (version 1.38.1)
--
--   PART 1  admin_reopen_order(): a cancelled order goes back to the
--           status it had before it was cancelled and takes its stock
--           again (refused with a clear message when stock is short).
--   PART 2  admin_delete_orders(): orders never booked on Steadfast and
--           not sent / delivered (Pending, Confirmed, Cancelled before
--           booking) can be deleted without the Safety Lock. Booked, in
--           transit and delivered orders still need the Safety Lock.
--           Stock handling is unchanged.
--
-- Additive and safe to run more than once.
-- ============================================================


-- PART 1 — Reopen a cancelled order
CREATE OR REPLACE FUNCTION admin_reopen_order(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order  orders%ROWTYPE;
  v_line   record;
  v_back   text;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Only a cancelled order can be reopened.';
  END IF;

  -- The status it had just before the latest cancel.
  SELECT h.old_status INTO v_back
  FROM order_status_history h
  WHERE h.order_id = p_order_id AND h.new_status = 'cancelled'
  ORDER BY h.changed_at DESC
  LIMIT 1;
  IF v_back IS NULL OR v_back NOT IN ('pending', 'confirmed', 'shipped', 'delivered') THEN
    v_back := 'pending';
  END IF;

  -- Take the stock again, exactly like a new order does; any line that is
  -- short stops the whole reopen (nothing is changed).
  IF v_order.stock_released THEN
    PERFORM set_config('app.order_stock_change', 'on', true);
    FOR v_line IN SELECT * FROM order_items oi WHERE oi.order_id = p_order_id
    LOOP
      PERFORM order_edit_stock(
        v_line.product_id, v_line.variant_id, -v_line.quantity,
        v_line.product_name || COALESCE(' (' || v_line.variant_label || ')', '')
      );
    END LOOP;
    PERFORM set_config('app.order_stock_change', 'off', true);
  END IF;

  UPDATE orders SET status = v_back, stock_released = false, updated_at = now() WHERE id = p_order_id;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, 'cancelled', v_back, auth.uid(), 'Reopened (stock taken again)');

  RETURN v_back;
END;
$$;

REVOKE ALL ON FUNCTION admin_reopen_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_reopen_order(uuid) TO authenticated;


-- PART 2 — Delete rule: not booked and not sent = no Safety Lock needed
CREATE OR REPLACE FUNCTION admin_delete_orders(p_order_ids uuid[])
RETURNS TABLE (order_id uuid, order_number text, deleted boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id        uuid;
  v_order     orders%ROWTYPE;
  v_line      record;
  v_is_admin  boolean := is_admin();
  v_lock_open boolean := false;
  v_early     boolean;
BEGIN
  IF NOT (v_is_admin OR staff_can('delete_early_orders')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  IF v_is_admin THEN
    v_lock_open := EXISTS (
      SELECT 1 FROM admin_safety_locks
      WHERE user_id = auth.uid() AND delete_any_until > now()
    );
  END IF;

  FOREACH v_id IN ARRAY COALESCE(p_order_ids, '{}'::uuid[])
  LOOP
    SELECT * INTO v_order FROM orders WHERE id = v_id FOR UPDATE;

    IF NOT FOUND THEN
      order_id := v_id; order_number := NULL; deleted := false; reason := 'Order not found.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    v_early := v_order.steadfast_consignment_id IS NULL
               AND v_order.status IN ('pending', 'confirmed', 'cancelled');

    IF NOT v_early AND NOT v_lock_open THEN
      order_id := v_id; order_number := v_order.order_number; deleted := false;
      reason := CASE WHEN v_is_admin
        THEN 'Locked: turn on "Allow deleting orders at any stage" in Safety Locks.'
        ELSE 'Only orders not booked on Steadfast and not sent (Pending, Confirmed or Cancelled) can be deleted.' END;
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF NOT v_order.stock_released AND v_order.status <> 'cancelled' THEN
      PERFORM set_config('app.order_stock_change', 'on', true);
      FOR v_line IN SELECT * FROM order_items oi WHERE oi.order_id = v_id
      LOOP
        IF v_line.variant_id IS NOT NULL THEN
          UPDATE product_variants SET stock_quantity = stock_quantity + v_line.quantity
            WHERE id = v_line.variant_id AND stock_quantity IS NOT NULL;
        ELSIF v_line.product_id IS NOT NULL THEN
          UPDATE products SET stock_quantity = stock_quantity + v_line.quantity
            WHERE id = v_line.product_id AND stock_quantity IS NOT NULL;
        END IF;
      END LOOP;
      PERFORM set_config('app.order_stock_change', 'off', true);
    END IF;

    DELETE FROM order_status_history h WHERE h.order_id = v_id;
    DELETE FROM order_items oi WHERE oi.order_id = v_id;
    DELETE FROM orders o WHERE o.id = v_id;

    order_id := v_id; order_number := v_order.order_number; deleted := true; reason := NULL;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_delete_orders(uuid[]) TO authenticated;
