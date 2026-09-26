-- ============================================================
-- Naeem's Price Hub — Migration 027 (Batch 21 Part 4: admin bulk-delete
-- for cancelled orders)
-- Run this in the Supabase SQL Editor. Safe to re-run.
--
-- Naeem has a growing pile of demo/test orders cluttering the admin Orders
-- list. This adds one function that permanently removes CANCELLED orders
-- only — pending/confirmed/shipped/delivered can never be deleted this way,
-- enforced here in the database, not just hidden in the admin UI.
-- ============================================================

CREATE OR REPLACE FUNCTION admin_delete_cancelled_orders(p_order_ids uuid[])
RETURNS TABLE (order_id uuid, order_number text, deleted boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id     uuid;
  v_order  orders%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  FOREACH v_id IN ARRAY p_order_ids
  LOOP
    SELECT * INTO v_order FROM orders WHERE id = v_id;

    IF NOT FOUND THEN
      order_id := v_id;
      order_number := NULL;
      deleted := false;
      reason := 'Order not found.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_order.status <> 'cancelled' THEN
      order_id := v_id;
      order_number := v_order.order_number;
      deleted := false;
      reason := 'Only a cancelled order can be deleted.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Stock was already restored back when this order was cancelled
    -- (cancel_order / admin_set_order_status, migration-021) — deleting the
    -- order now must never touch stock a second time.
    DELETE FROM order_status_history WHERE order_status_history.order_id = v_id;
    DELETE FROM order_items WHERE order_items.order_id = v_id;
    DELETE FROM orders WHERE id = v_id;

    order_id := v_id;
    order_number := v_order.order_number;
    deleted := true;
    reason := NULL;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_delete_cancelled_orders(uuid[]) TO authenticated;

-- ============================================================
-- ---------- Verify ----------
-- As an admin session, with at least one cancelled order's id:
--   SELECT * FROM admin_delete_cancelled_orders(ARRAY['<that order id>'::uuid]);
--   → one row, deleted = true, reason null; the order is gone from `orders`.
-- As a non-admin session, the same call must fail with "Not authorized." —
-- it never reaches the loop, the is_admin() check runs first.
-- Order numbers (order_number, from the orders_number_seq sequence) keep
-- counting upward even after a delete — expected, not a bug; the next new
-- order simply doesn't reuse a deleted number.
-- ============================================================
