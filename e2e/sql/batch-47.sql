-- Batch 47 database tests (run by e2e/batch-47.spec.ts through the Supabase
-- command line). The runner puts the whole Batch 47 migration
-- (supabase/migration-048-batch47.sql, without its own BEGIN / COMMIT) in
-- front of this script, so everything — the migration, the throwaway
-- product, orders and payout — runs inside ONE transaction that always
-- ends with ROLLBACK. No real order, customer or payout is ever changed.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin  uuid;
  v_cust   uuid;
  v_other  uuid;
  c_admin  text;
  c_cust   text;
  c_other  text;
  v_tag    text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_prod   uuid;
  v_o1     uuid;
  v_o2     uuid;
  v_o3     uuid;
  v_stock  integer;
  v_paid   numeric;
  v_total  numeric;
  v_payout uuid;
  v_l1     uuid;
  v_l2     uuid;
  v_l3     uuid;
  v_l4     uuid;
  v_l5     uuid;
  v_int    integer;
  v_err    text;
  v_json   jsonb;
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  SELECT id INTO v_other FROM profiles WHERE role = 'customer' AND id <> v_cust ORDER BY created_at LIMIT 1;
  IF v_other IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:no second customer account to move an order to';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;
  c_other := json_build_object('sub', v_other, 'role', 'authenticated')::text;

  -- ================================================ the migration itself
  PERFORM pg_temp.ck('Migration: the new functions are there',
    to_regprocedure('admin_set_order_source(uuid,text)') IS NOT NULL
    AND to_regprocedure('admin_move_order_customer(uuid,uuid)') IS NOT NULL
    AND to_regprocedure('admin_settle_payout_line(uuid,text,text)') IS NOT NULL
    AND to_regprocedure('admin_unsettle_payout_line(uuid)') IS NOT NULL);
  PERFORM pg_temp.ck('Migration: no admin order is linked to a customer account in the admin only any more',
    NOT EXISTS (SELECT 1 FROM orders o JOIN profiles p ON p.id = o.admin_customer_id AND p.role = 'customer'
                WHERE o.customer_id IS NULL));
  PERFORM pg_temp.ck('Migration: the lines Batch 46 settled (NM-3315, NM-1721) carry their reason',
    NOT EXISTS (SELECT 1 FROM steadfast_payout_items WHERE line_kind <> 'order' AND settle_reason IS NULL));
  PERFORM pg_temp.ck('Migration: every real payout still adds up exactly to what Steadfast paid',
    NOT EXISTS (SELECT 1 FROM steadfast_payouts p
                WHERE p.items_synced AND p.total_amount <> (SELECT COALESCE(sum(i.net_paid), 0) FROM steadfast_payout_items i WHERE i.payout_id = p.id)));
  PERFORM pg_temp.ck('Migration: nobody outside the admin can call the new functions',
    NOT has_function_privilege('anon', 'admin_move_order_customer(uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'admin_settle_payout_line(uuid,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'admin_unsettle_payout_line(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'admin_set_order_source(uuid,text)', 'EXECUTE'));

  -- ================================================ setup (rolled back)
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  PERFORM set_config('inventory.test_mode', '', true);
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B47-' || v_tag, 'e2e-b47-' || v_tag, 'E2E B47 Cream', 1000, 'in_stock', 50, true) RETURNING id INTO v_prod;

  -- ================================================ TASK 6a
  -- New order with a picked customer who has an account: hers.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  SELECT order_id INTO v_o1 FROM admin_create_order_v2(
    p_source => 'facebook', p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    p_full_name => 'E2E B47', p_phone => '01700000047', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 60,
    p_linked_customer_id => v_cust);
  PERFORM admin_link_order_customer(v_o1, v_cust);
  PERFORM pg_temp.ck('Task 6a: an admin order for a customer with an account belongs to that account',
    (SELECT customer_id = v_cust AND admin_customer_id = v_cust FROM orders WHERE id = v_o1));
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT count(*) INTO v_int FROM orders WHERE id = v_o1;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Task 6a: … and shows in her My Orders (she can read it)', v_int = 1, v_int::text);

  -- The older way (created without, linked after): the link fills it too.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  SELECT order_id INTO v_o2 FROM admin_create_order_v2(
    p_source => 'shop', p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 2)),
    p_full_name => 'E2E B47', p_phone => '01700000047', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'hand_delivered', p_delivery_fee => 0);
  PERFORM pg_temp.ck('Task 6a: an order for a customer with no account keeps no owner',
    (SELECT customer_id IS NULL AND admin_customer_id IS NULL FROM orders WHERE id = v_o2));
  PERFORM admin_link_order_customer(v_o2, v_cust);
  PERFORM pg_temp.ck('Task 6a: linking an order to an account afterwards puts it in her My Orders too',
    (SELECT customer_id = v_cust FROM orders WHERE id = v_o2));
  PERFORM admin_link_order_customer(v_o2, v_other);
  PERFORM pg_temp.ck('Task 6a: … but a link never takes an order out of the account it is in',
    (SELECT customer_id = v_cust AND admin_customer_id = v_other FROM orders WHERE id = v_o2));

  -- ================================================ TASK 4
  PERFORM admin_set_order_source(v_o1, 'shop');
  PERFORM pg_temp.ck('Task 4: the source of an order can be changed to Shop/in person',
    (SELECT source FROM orders WHERE id = v_o1) = 'shop');
  PERFORM pg_temp.ck('Task 4: … only the source changed (total and delivery charge as they were)',
    (SELECT total = 1060 AND delivery_fee = 60 FROM orders WHERE id = v_o1),
    (SELECT total || ' / ' || delivery_fee FROM orders WHERE id = v_o1));
  PERFORM pg_temp.ck('Task 4: … and the change is in the Activity Log',
    EXISTS (SELECT 1 FROM activity_log WHERE entity_id = v_o1::text AND action = 'order.source'));
  v_err := NULL;
  BEGIN
    PERFORM admin_set_order_source(v_o1, 'pickup');
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Task 4: an unknown source is refused', v_err = 'Invalid order source.', COALESCE(v_err, 'it ran'));
  v_err := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', c_cust, true);
    PERFORM admin_set_order_source(v_o1, 'web');
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Task 4: a customer cannot change a source', v_err = 'Not authorized.', COALESCE(v_err, 'it ran'));

  -- ================================================ TASK 6b
  -- A delivered, paid order with a due reminder, in the wrong account.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  SELECT order_id INTO v_o3 FROM admin_create_order_v2(
    p_source => 'whatsapp', p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 3)),
    p_full_name => 'E2E B47 Wife', p_phone => '01700000048', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 60,
    p_paid_amount => 3060, p_paid_method => 'cash', p_linked_customer_id => v_cust);
  UPDATE orders SET status = 'delivered' WHERE id = v_o3;
  INSERT INTO customer_due_reminders (customer_key, phone_key, amount, order_id, how, created_by_username)
  VALUES ('p:' || v_cust, '1700000048', 0, v_o3, 'whatsapp', 'e2e');
  SELECT stock_quantity INTO v_stock FROM products WHERE id = v_prod;
  SELECT total INTO v_total FROM orders WHERE id = v_o3;
  SELECT COALESCE(sum(amount), 0) INTO v_paid FROM order_payments WHERE order_id = v_o3;

  v_err := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', c_cust, true);
    PERFORM admin_move_order_customer(v_o3, v_cust);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Task 6b: a customer cannot move an order', v_err = 'Not authorized.', COALESCE(v_err, 'it ran'));
  v_err := NULL;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM admin_move_order_customer(v_o3, v_other);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Task 6b: an anonymous visitor cannot even call it', v_err = '42501', COALESCE(v_err, 'it ran'));
  v_err := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', c_admin, true);
    PERFORM admin_move_order_customer(v_o3, v_admin);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Task 6b: an order can only be moved to a customer account', v_err = 'Customer not found.', COALESCE(v_err, 'it ran'));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_json := admin_move_order_customer(v_o3, v_other);
  PERFORM pg_temp.ck('Task 6b: the order moves — login, admin link and due reminder all point to the new customer',
    (SELECT customer_id = v_other AND admin_customer_id = v_other FROM orders WHERE id = v_o3)
    AND (SELECT customer_key FROM customer_due_reminders WHERE order_id = v_o3) = 'p:' || v_other, v_json::text);
  PERFORM pg_temp.ck('Task 6b: … its money, payments, status and stock are untouched',
    (SELECT total = v_total AND status = 'delivered' FROM orders WHERE id = v_o3)
    AND (SELECT COALESCE(sum(amount), 0) FROM order_payments WHERE order_id = v_o3) = v_paid
    AND (SELECT stock_quantity FROM products WHERE id = v_prod) = v_stock);
  PERFORM pg_temp.ck('Task 6b: … and its delivery name and phone stay as printed',
    (SELECT customer_name = 'E2E B47 Wife' AND customer_phone = '01700000048' FROM orders WHERE id = v_o3));
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT count(*) INTO v_int FROM orders WHERE id = v_o3;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Task 6b: it left the old account''s My Orders', v_int = 0, v_int::text);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', c_other, true);
  SELECT count(*) INTO v_int FROM orders WHERE id = v_o3;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Task 6b: … and is in the new customer''s My Orders', v_int = 1, v_int::text);
  PERFORM pg_temp.ck('Task 6b: the move is in the Activity Log',
    EXISTS (SELECT 1 FROM activity_log WHERE entity_id = v_o3::text AND action = 'order.customer'));

  -- ================================================ TASK 12
  PERFORM set_config('request.jwt.claims', c_admin, true);
  INSERT INTO steadfast_payouts (steadfast_payment_id, paid_at, total_amount, parcel_count, items_synced)
  VALUES ('E2E-B47-' || v_tag, now(), -50 + 435 + (1000 - 60 - 10) - 75 - 40, 5, true)
  RETURNING id INTO v_payout;
  -- l1: nothing collected, no order (a returned parcel).
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, cod_collected, delivery_charge, net_paid, match_status, match_reason, note)
  VALUES (v_payout, 'i:l1', 'NM-E2E47A', 0, 50, -50, 'to_check', 'order_not_found', 'Order not found') RETURNING id INTO v_l1;
  -- l2: money collected, no order (a friend's parcel).
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, cod_collected, delivery_charge, cod_fee, net_paid, match_status, match_reason, note)
  VALUES (v_payout, 'i:l2', 'NM-E2E47B', 500, 60, 5, 435, 'to_check', 'order_not_found', 'Order not found') RETURNING id INTO v_l2;
  -- l3: linked to an order, "to check".
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, order_id, cod_collected, delivery_charge, cod_fee, net_paid, expected_cod, match_status, match_reason, note)
  VALUES (v_payout, 'i:l3', (SELECT order_number FROM orders WHERE id = v_o1), v_o1, 1000, 60, 10, 930, 1060, 'to_check', 'cod_differs', 'COD differs')
  RETURNING id INTO v_l3;
  -- l4: nothing collected, no order ("Other").
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, cod_collected, delivery_charge, net_paid, match_status, match_reason, note)
  VALUES (v_payout, 'i:l4', 'NM-E2E47D', 0, 75, -75, 'to_check', 'order_not_found', 'Order not found') RETURNING id INTO v_l4;
  -- l5: settled the Batch 46 way (no saved state to undo to).
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, cod_collected, delivery_charge, net_paid, match_status, line_kind, note, settle_reason, settled_by_username)
  VALUES (v_payout, 'i:l5', 'NM-E2E47E', 0, 40, -40, 'matched', 'returned', 'Returned parcel (order deleted)', 'order_deleted', 'Batch 46')
  RETURNING id INTO v_l5;

  -- Who may settle.
  v_err := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', c_cust, true);
    PERFORM admin_settle_payout_line(v_l1, 'returned', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Task 12: a customer cannot settle a payout line', v_err = 'Not authorized.', COALESCE(v_err, 'it ran'));
  v_err := NULL;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM admin_settle_payout_line(v_l1, 'returned', NULL);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Task 12: an anonymous visitor cannot even call it', v_err = '42501', COALESCE(v_err, 'it ran'));
  v_err := NULL;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', c_cust, true);
    UPDATE steadfast_payout_items SET match_status = 'matched' WHERE id = v_l1;
    GET DIAGNOSTICS v_int = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    IF v_int = 0 THEN v_err := 'no rows'; END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Task 12: nobody can mark a line by writing to the table directly', v_err IS NOT NULL, COALESCE(v_err, 'it changed'));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  -- "Returned parcel" on a line with no order and nothing collected.
  v_json := admin_settle_payout_line(v_l1, 'returned', 'came back 3 Nov');
  PERFORM pg_temp.ck('Task 12: Returned parcel → settled as a returned parcel (charge = delivery cost), with reason, note, who and when',
    (SELECT line_kind = 'returned' AND match_status = 'matched' AND match_reason IS NULL AND settle_reason = 'returned'
            AND settle_note = 'came back 3 Nov' AND settled_by = v_admin AND settled_at IS NOT NULL
            AND settled_by_username IS NOT NULL AND note LIKE 'Returned parcel%came back 3 Nov'
     FROM steadfast_payout_items WHERE id = v_l1), v_json::text);
  -- Money was collected: "Returned" would drop it from the books — refused.
  v_err := NULL;
  BEGIN
    PERFORM admin_settle_payout_line(v_l2, 'returned', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Task 12: a line where Steadfast collected money cannot be called "returned"',
    v_err LIKE 'Steadfast collected%', COALESCE(v_err, 'it ran'));
  PERFORM admin_settle_payout_line(v_l2, 'not_shop_sale', 'friend''s parcel');
  PERFORM pg_temp.ck('Task 12: Not a shop sale → kept outside sales (courier only)',
    (SELECT line_kind = 'courier_only' AND match_status = 'matched' FROM steadfast_payout_items WHERE id = v_l2));
  -- A line linked to an order.
  v_err := NULL;
  BEGIN
    PERFORM admin_settle_payout_line(v_l3, 'not_shop_sale', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Task 12: a line whose order is still there cannot be "Not a shop sale"',
    v_err LIKE 'This line belongs to order%', COALESCE(v_err, 'it ran'));
  PERFORM admin_settle_payout_line(v_l3, 'paid_direct', NULL);
  PERFORM pg_temp.ck('Task 12: Paid to me directly on an order line → matched, still booked through its order',
    (SELECT line_kind = 'order' AND order_id = v_o1 AND match_status = 'matched' AND settle_reason = 'paid_direct'
     FROM steadfast_payout_items WHERE id = v_l3));
  -- "Other" needs a note.
  v_err := NULL;
  BEGIN
    PERFORM admin_settle_payout_line(v_l4, 'other', '  ');
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Task 12: "Other" without a note is refused', v_err LIKE 'Write a short note%', COALESCE(v_err, 'it ran'));
  PERFORM admin_settle_payout_line(v_l4, 'other', 'sample parcel');
  v_err := NULL;
  BEGIN
    PERFORM admin_settle_payout_line(v_l4, 'returned', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Task 12: a settled line is not settled twice (undo first)', v_err LIKE 'This line is already settled%', COALESCE(v_err, 'it ran'));

  PERFORM pg_temp.ck('Task 12: no amount changed, so the payout still adds up exactly',
    (SELECT total_amount FROM steadfast_payouts WHERE id = v_payout) = (SELECT sum(net_paid) FROM steadfast_payout_items WHERE payout_id = v_payout),
    (SELECT total_amount FROM steadfast_payouts WHERE id = v_payout) || ' vs ' || (SELECT sum(net_paid) FROM steadfast_payout_items WHERE payout_id = v_payout));
  PERFORM pg_temp.ck('Task 12: nothing on the payout is "to check" any more',
    NOT EXISTS (SELECT 1 FROM steadfast_payout_items WHERE payout_id = v_payout AND match_status = 'to_check'));
  IF money_start_date() IS NOT NULL THEN
    PERFORM pg_temp.ck('Task 12: in the books the returned line is a delivery cost, the friend''s parcel outside sales',
      (SELECT type FROM money_ledger WHERE source_id = v_l1::text) = 'courier_fees'
      AND (SELECT type FROM money_ledger WHERE source_id = v_l2::text) = 'steadfast_courier_only');
  END IF;
  PERFORM pg_temp.ck('Task 12: each settle is in the Activity Log',
    (SELECT count(*) FROM activity_log WHERE action = 'payout.settle' AND entity_id = v_payout::text) = 4);

  -- Steadfast read again: every settled line stays settled.
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, order_id, cod_collected, delivery_charge, cod_fee, net_paid, expected_cod, match_status, match_reason, note)
  VALUES (v_payout, 'i:l3', (SELECT order_number FROM orders WHERE id = v_o1), v_o1, 1000, 60, 10, 930, 1060, 'to_check', 'cod_differs', 'COD differs'),
         (v_payout, 'i:l1', 'NM-E2E47A', NULL, 0, 50, 0, -50, NULL, 'to_check', 'order_not_found', 'Order not found')
  ON CONFLICT (payout_id, item_key) DO UPDATE
    SET order_id = EXCLUDED.order_id, match_status = EXCLUDED.match_status, match_reason = EXCLUDED.match_reason,
        note = EXCLUDED.note, net_paid = EXCLUDED.net_paid;
  PERFORM pg_temp.ck('Task 12: reading Steadfast again keeps hand-settled lines settled (with and without an order)',
    (SELECT match_status FROM steadfast_payout_items WHERE id = v_l3) = 'matched'
    AND (SELECT match_status || '/' || line_kind FROM steadfast_payout_items WHERE id = v_l1) = 'matched/returned');

  -- Undo.
  PERFORM admin_unsettle_payout_line(v_l3);
  PERFORM pg_temp.ck('Task 12: undo puts an order line back exactly as it was',
    (SELECT line_kind = 'order' AND match_status = 'to_check' AND match_reason = 'cod_differs' AND note = 'COD differs'
            AND settle_reason IS NULL AND settled_at IS NULL AND settled_by IS NULL AND settle_undo IS NULL
     FROM steadfast_payout_items WHERE id = v_l3));
  PERFORM pg_temp.ck('Task 12: … and never changes the order''s payments on the way',
    NOT EXISTS (SELECT 1 FROM order_payments WHERE order_id = v_o1));
  PERFORM admin_unsettle_payout_line(v_l1);
  PERFORM pg_temp.ck('Task 12: undo of a returned line → "to check: order not found" again',
    (SELECT line_kind = 'order' AND match_status = 'to_check' AND match_reason = 'order_not_found' AND note = 'Order not found'
     FROM steadfast_payout_items WHERE id = v_l1));
  PERFORM admin_settle_payout_line(v_l1, 'courier_charge', NULL);
  PERFORM pg_temp.ck('Task 12: after an undo another reason can be picked',
    (SELECT settle_reason FROM steadfast_payout_items WHERE id = v_l1) = 'courier_charge');
  PERFORM admin_unsettle_payout_line(v_l5);
  PERFORM pg_temp.ck('Task 12: a line settled by Batch 46 can be undone too',
    (SELECT line_kind = 'order' AND match_status = 'to_check' AND match_reason = 'order_not_found' AND settle_reason IS NULL
     FROM steadfast_payout_items WHERE id = v_l5));
  v_err := NULL;
  BEGIN
    PERFORM admin_unsettle_payout_line(v_l5);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Task 12: undo of a line that is not settled is refused', v_err = 'This line is not settled.', COALESCE(v_err, 'it ran'));
  PERFORM pg_temp.ck('Task 12: after all that the payout still adds up exactly',
    (SELECT total_amount FROM steadfast_payouts WHERE id = v_payout) = (SELECT sum(net_paid) FROM steadfast_payout_items WHERE payout_id = v_payout));
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
