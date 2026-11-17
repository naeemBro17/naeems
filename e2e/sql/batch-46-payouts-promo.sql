-- Batch 46 database tests (run by e2e/batch-46.spec.ts through the Supabase
-- command line). The runner puts the whole Batch 46 migration
-- (supabase/migration-047-batch46-payouts-promo.sql, without its own BEGIN /
-- COMMIT) in front of this script, so everything — the migration, the
-- throwaway product, promo code, orders and payout — runs inside ONE
-- transaction that always ends with ROLLBACK. No real promo code count and
-- no real payout is ever changed.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin  uuid;
  v_cust   uuid;
  c_admin  text;
  c_cust   text;
  v_tag    text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_code   text;
  v_prod   uuid;
  v_o1     uuid;
  v_o2     uuid;
  v_o3     uuid;
  v_total  numeric;
  v_payout uuid;
  v_l1     uuid;
  v_l2     uuid;
  v_l3     uuid;
  v_l4     uuid;
  v_int    integer;
  v_num    numeric;
  v_num2   numeric;
  v_err    text;
  v_err2   text;
  v_json   jsonb;
  v_json2  jsonb;
  v_ok     boolean;
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.used(p_code text) RETURNS integer
    LANGUAGE sql AS 'SELECT times_used FROM promo_codes WHERE code = p_code'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;

  -- ================================================ the migration itself
  PERFORM pg_temp.ck('Migration: payout lines have a kind (order / courier_only / returned)',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'steadfast_payout_items' AND column_name = 'line_kind'));
  PERFORM pg_temp.ck('Migration: every real payout adds up exactly to what Steadfast paid',
    NOT EXISTS (SELECT 1 FROM steadfast_payouts p
                WHERE p.items_synced AND p.total_amount <> (SELECT COALESCE(sum(i.net_paid), 0) FROM steadfast_payout_items i WHERE i.payout_id = p.id)));
  PERFORM pg_temp.ck('Migration: no payout line counts COD on a parcel Steadfast returned',
    NOT EXISTS (SELECT 1 FROM steadfast_payout_items WHERE raw ->> 'status' ILIKE '%cancel%' AND cod_collected <> 0));
  PERFORM pg_temp.ck('Migration: NM-3315 is courier only, NM-1721 a returned parcel, neither "to check"',
    (SELECT count(*) FROM steadfast_payout_items
     WHERE (upper(invoice) = 'NM-3315' AND line_kind = 'courier_only' AND match_status = 'matched')
        OR (upper(invoice) = 'NM-1721' AND line_kind = 'returned' AND match_status = 'matched')) = 2);
  PERFORM pg_temp.ck('Migration: each promo code counts its real, not-cancelled orders',
    NOT EXISTS (SELECT 1 FROM promo_codes c WHERE c.times_used <>
      (SELECT count(*) FROM orders o WHERE upper(trim(o.promo_code)) = upper(c.code) AND o.status <> 'cancelled')));
  PERFORM pg_temp.ck('Migration: the backup tables are not readable by the website',
    NOT has_table_privilege('anon', '_b46_backup_promo_codes', 'SELECT')
    AND NOT has_table_privilege('authenticated', '_b46_backup_payout_lines', 'SELECT'));

  -- ================================================ setup (rolled back)
  -- Inventory mode Off for this transaction only, so the throwaway product
  -- sells from its own stock count (no lots). Rolled back with the rest.
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  PERFORM set_config('inventory.test_mode', '', true);
  v_code := 'E2E-B46-' || v_tag;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B46-' || v_tag, 'e2e-b46-' || v_tag, 'E2E B46 Cream', 1000, 'in_stock', 50, true) RETURNING id INTO v_prod;
  INSERT INTO promo_codes (code, discount_amount, discount_type, max_uses, active)
  VALUES (v_code, 100, 'fixed', 3, true);

  -- ================================================ PROMO
  -- Checking / applying a code (the cart's read) many times: no change.
  EXECUTE 'SET LOCAL ROLE anon';
  FOR v_int IN 1..5 LOOP
    PERFORM code FROM promo_codes WHERE code = v_code;
  END LOOP;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Promo: applying a code 5 times without ordering leaves times_used at 0', pg_temp.used(v_code) = 0,
    pg_temp.used(v_code)::text);

  -- Nobody outside place_order can count a use.
  v_err := NULL;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM increment_promo_usage(v_code);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Promo: an anonymous visitor cannot call the use counter', v_err = '42501', COALESCE(v_err, 'it ran'));
  v_err := NULL;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', c_cust, true);
    PERFORM increment_promo_usage(v_code);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Promo: a signed-in customer cannot call the use counter either', v_err = '42501', COALESCE(v_err, 'it ran'));
  v_err := NULL;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    UPDATE promo_codes SET times_used = 0 WHERE code = v_code;
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Promo: an anonymous direct UPDATE of times_used is refused', v_err = '42501', COALESCE(v_err, 'it ran'));
  PERFORM pg_temp.ck('Promo: still 0 after those attempts', pg_temp.used(v_code) = 0, pg_temp.used(v_code)::text);

  -- A real order counts exactly one use and stores the code.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o1 FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    p_full_name => 'E2E B46', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod',
    p_promo_code => lower(v_code));
  PERFORM pg_temp.ck('Promo: placing one order raises times_used by exactly one', pg_temp.used(v_code) = 1, pg_temp.used(v_code)::text);
  PERFORM pg_temp.ck('Promo: the order stores the code it used',
    (SELECT upper(promo_code) FROM orders WHERE id = v_o1) = v_code);

  -- A failed order (more than the stock) counts nothing.
  v_err := NULL;
  BEGIN
    PERFORM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 999)),
      p_full_name => 'E2E B46', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod',
      p_promo_code => v_code);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Promo: a failed order does not change times_used', v_err IS NOT NULL AND pg_temp.used(v_code) = 1,
    COALESCE(v_err, 'the order went through') || ' / ' || pg_temp.used(v_code));

  -- Cancel gives the use back; reopening counts it again; deleting gives it back.
  PERFORM cancel_order(v_o1, NULL);
  PERFORM pg_temp.ck('Promo: cancelling the order gives the use back', pg_temp.used(v_code) = 0, pg_temp.used(v_code)::text);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_reopen_order(v_o1);
  PERFORM pg_temp.ck('Promo: reopening the cancelled order counts it again', pg_temp.used(v_code) = 1, pg_temp.used(v_code)::text);
  PERFORM admin_delete_orders(ARRAY[v_o1]);
  PERFORM pg_temp.ck('Promo: deleting the order gives the use back', pg_temp.used(v_code) = 0, pg_temp.used(v_code)::text);

  -- Never below zero.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o1 FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    p_full_name => 'E2E B46', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod',
    p_promo_code => v_code);
  UPDATE promo_codes SET times_used = 0 WHERE code = v_code;
  PERFORM cancel_order(v_o1, NULL);
  PERFORM pg_temp.ck('Promo: a give-back never goes below zero', pg_temp.used(v_code) = 0, pg_temp.used(v_code)::text);

  -- The same refusal for every kind of bad code (never says why).
  UPDATE promo_codes SET expires_at = now() - interval '1 day' WHERE code = v_code;
  v_err := NULL;
  v_err2 := NULL;
  BEGIN
    PERFORM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
      p_full_name => 'E2E B46', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod',
      p_promo_code => v_code);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  BEGIN
    PERFORM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
      p_full_name => 'E2E B46', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod',
      p_promo_code => 'NO-SUCH-CODE-' || v_tag);
  EXCEPTION WHEN OTHERS THEN
    v_err2 := SQLERRM;
  END;
  PERFORM pg_temp.ck('Promo: an expired code and a code that does not exist are refused with the same message',
    v_err IS NOT NULL AND v_err = v_err2, COALESCE(v_err, '-') || ' / ' || COALESCE(v_err2, '-'));
  PERFORM pg_temp.ck('Promo: the expired code still shows 0 uses', pg_temp.used(v_code) = 0, pg_temp.used(v_code)::text);

  -- ================================================ PAYOUTS
  -- o2: a delivered COD order whose "COD via Steadfast" payment says the
  -- full total, but Steadfast collected ৳50 less.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o2 FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 2)),
    p_full_name => 'E2E B46', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  -- o3: a cancelled order whose parcel Steadfast still charged for.
  SELECT order_id INTO v_o3 FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    p_full_name => 'E2E B46', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_set_order_status(v_o2, 'delivered', 'e2e');
  PERFORM admin_set_order_status(v_o3, 'cancelled', 'e2e');
  SELECT total INTO v_total FROM orders WHERE id = v_o2;
  -- Only the courier's payment on this order (whatever "delivered" added).
  DELETE FROM order_payments WHERE order_id = v_o2 AND source <> 'steadfast_cod';
  INSERT INTO order_payments (order_id, amount, method, note, source)
  VALUES (v_o2, v_total, 'cod_steadfast', 'e2e', 'steadfast_cod')
  ON CONFLICT (order_id) WHERE source = 'steadfast_cod' DO UPDATE SET amount = EXCLUDED.amount;

  -- One payout: a delivered line, a prepaid line (only a charge), a
  -- returned line, a courier-only line, and a line whose order was deleted.
  -- Paid = (total − 50) − 60 − fee  − 60  − 50  − 75  + (500 − 60 − 5).
  v_num := round((v_total - 50) * 0.01, 2);
  INSERT INTO steadfast_payouts (steadfast_payment_id, paid_at, total_amount, parcel_count, items_synced)
  VALUES ('E2E-B46-' || v_tag, now(), (v_total - 50 - 60 - v_num) - 60 - 50 - 75 + 435, 5, true)
  RETURNING id INTO v_payout;
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, order_id, cod_collected, delivery_charge, cod_fee, net_paid,
                                      expected_cod, match_status, match_reason)
  VALUES (v_payout, 'i:delivered', (SELECT order_number FROM orders WHERE id = v_o2), v_o2, v_total - 50, 60, v_num,
          v_total - 50 - 60 - v_num, v_total, 'to_check', 'cod_differs')
  RETURNING id INTO v_l1;
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, order_id, cod_collected, delivery_charge, net_paid, match_status)
  VALUES (v_payout, 'i:prepaid', (SELECT order_number FROM orders WHERE id = v_o3), v_o3, 0, 60, -60, 'matched');
  INSERT INTO order_courier_costs (order_id, delivery_charge, total_kept, cod_collected, net_received, payout_id, paid_at)
  VALUES (v_o3, 60, 60, 0, -60, v_payout, now());
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, cod_collected, delivery_charge, net_paid, match_status, match_reason)
  VALUES (v_payout, 'i:returned', 'NM-E2E46R', 0, 50, -50, 'to_check', 'order_not_found') RETURNING id INTO v_l2;
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, cod_collected, delivery_charge, net_paid, match_status, match_reason)
  VALUES (v_payout, 'i:courier', 'NM-E2E46C', 0, 75, -75, 'to_check', 'order_not_found') RETURNING id INTO v_l3;
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, cod_collected, delivery_charge, cod_fee, net_paid, match_status, match_reason)
  VALUES (v_payout, 'i:deleted', 'NM-E2E46D', 500, 60, 5, 435, 'to_check', 'order_not_found') RETURNING id INTO v_l4;

  PERFORM pg_temp.ck('Payout: COD differs → the order''s "COD via Steadfast" payment becomes what Steadfast collected',
    (SELECT amount FROM order_payments WHERE order_id = v_o2 AND source = 'steadfast_cod') = v_total - 50,
    (SELECT amount FROM order_payments WHERE order_id = v_o2 AND source = 'steadfast_cod')::text || ' vs ' || (v_total - 50));
  PERFORM pg_temp.ck('Payout: … and the line is Matched (the site now agrees with Steadfast)',
    (SELECT match_status FROM steadfast_payout_items WHERE id = v_l1) = 'matched');
  PERFORM pg_temp.ck('Payout: … and the order shows the ৳50 still due',
    (SELECT total FROM orders WHERE id = v_o2) - order_payment_net(v_o2) = 50);

  -- Settle the returned and the courier-only lines, watching the books.
  SELECT (money_position() ->> 'difference')::numeric INTO v_num;
  SELECT inventory_sales_profit_core((now() AT TIME ZONE 'Asia/Dhaka')::date, (now() AT TIME ZONE 'Asia/Dhaka')::date, false) -> 'totals' INTO v_json;
  UPDATE steadfast_payout_items SET line_kind = 'returned', match_status = 'matched', match_reason = NULL, note = 'e2e returned'
  WHERE id = v_l2;
  UPDATE steadfast_payout_items SET line_kind = 'courier_only', match_status = 'matched', match_reason = NULL, note = 'e2e courier only'
  WHERE id = v_l3;
  SELECT (money_position() ->> 'difference')::numeric INTO v_num2;
  SELECT inventory_sales_profit_core((now() AT TIME ZONE 'Asia/Dhaka')::date, (now() AT TIME ZONE 'Asia/Dhaka')::date, false) -> 'totals' INTO v_json2;

  PERFORM pg_temp.ck('Payout: the five lines add up exactly to what Steadfast paid',
    (SELECT total_amount FROM steadfast_payouts WHERE id = v_payout)
      = (SELECT sum(net_paid) FROM steadfast_payout_items WHERE payout_id = v_payout));
  PERFORM pg_temp.ck('Payout: the returned line adds its ৳50 charge to the courier cost, the courier-only line adds nothing',
    (v_json2 ->> 'courier')::numeric - (v_json ->> 'courier')::numeric = 50,
    ((v_json2 ->> 'courier')::numeric - (v_json ->> 'courier')::numeric)::text);
  PERFORM pg_temp.ck('Payout: neither the returned nor the courier-only line adds a sale or an order',
    (v_json2 ->> 'sales') = (v_json ->> 'sales') AND (v_json2 ->> 'orders') = (v_json ->> 'orders'));
  PERFORM pg_temp.ck('Payout: settling them leaves the Money balance check where it was',
    v_num = v_num2, v_num::text || ' → ' || v_num2::text);
  PERFORM pg_temp.ck('Payout: in the books the courier-only line is "not a shop sale", the returned one a courier charge',
    (SELECT type FROM money_ledger WHERE source_id = v_l3::text) = 'steadfast_courier_only'
    AND (SELECT type FROM money_ledger WHERE source_id = v_l2::text) = 'courier_fees');

  -- The prepaid line on the cancelled order: no sale, its charge is a cost.
  SELECT value INTO v_json FROM jsonb_array_elements(
    inventory_sales_profit_core((now() AT TIME ZONE 'Asia/Dhaka')::date, (now() AT TIME ZONE 'Asia/Dhaka')::date, false) -> 'orders')
  WHERE value ->> 'order_id' = v_o3::text;
  PERFORM pg_temp.ck('Payout: a cancelled order''s Steadfast charge is listed as its courier cost, with no sale',
    v_json IS NOT NULL AND (v_json ->> 'sale')::numeric = 0 AND (v_json ->> 'courier')::numeric = 60, COALESCE(v_json::text, 'not listed'));

  -- The line whose order was deleted stays unmatched and is never a sale.
  PERFORM pg_temp.ck('Payout: a line whose order was deleted stays "to check: order not found"',
    (SELECT match_status || '/' || match_reason FROM steadfast_payout_items WHERE id = v_l4) = 'to_check/order_not_found');
  PERFORM pg_temp.ck('Payout: … it is in the books only as "not matched to an order", never as a sale',
    (SELECT type FROM money_ledger WHERE source_id = v_l4::text) = 'steadfast_unmatched'
    AND (v_json2 ->> 'sales') = (inventory_sales_profit_core((now() AT TIME ZONE 'Asia/Dhaka')::date, (now() AT TIME ZONE 'Asia/Dhaka')::date, false) -> 'totals' ->> 'sales'));

  -- Steadfast read again (old or new sync): a settled line keeps its kind.
  INSERT INTO steadfast_payout_items (payout_id, item_key, invoice, cod_collected, delivery_charge, net_paid, match_status, match_reason, note)
  VALUES (v_payout, 'i:courier', 'NM-E2E46C', 0, 75, -75, 'to_check', 'order_not_found', 'Order not found')
  ON CONFLICT (payout_id, item_key) DO UPDATE
    SET match_status = EXCLUDED.match_status, match_reason = EXCLUDED.match_reason, note = EXCLUDED.note,
        net_paid = EXCLUDED.net_paid;
  PERFORM pg_temp.ck('Payout: reading Steadfast again keeps a settled line settled',
    (SELECT line_kind || '/' || match_status || '/' || note FROM steadfast_payout_items WHERE id = v_l3) = 'courier_only/matched/e2e courier only');
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
