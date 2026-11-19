-- Batch 53 database tests (run by e2e/batch-53.spec.ts through the Supabase
-- command line). The runner puts e2e/sql/batch-53-before.sql and the whole
-- Batch 53 migration (supabase/migration-054-batch53.sql, without its own
-- BEGIN / COMMIT) in front of this script, so everything runs inside ONE
-- transaction that always ends with ROLLBACK. Nothing real is changed.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin   uuid;
  c_admin   text;
  v_json    jsonb;
  v_int     integer;
  v_num     numeric;
  v_bill    numeric;
  v_order   uuid;
  v_cod     numeric;
  v_kind    text;
  v_amount  numeric;
  v_pos     jsonb;
  v_pos0    jsonb;
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the admin test account was not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  PERFORM set_config('request.jwt.claims', c_admin, true);

  -- ------------------------------------------------------------ schema
  PERFORM pg_temp.ck('New columns exist',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'steadfast_payout_items' AND column_name = 'bill_paid_separately')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_courier_costs' AND column_name = 'bill_paid_separately')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_courier_costs' AND column_name = 'split_rule'));
  PERFORM pg_temp.ck('Helpers are not callable by shop users',
    NOT has_function_privilege('authenticated', 'order_courier_costs_for(uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'order_courier_costs_for(uuid[])', 'EXECUTE'));

  -- ------------------------------------------------- payouts still add up
  SELECT count(*) INTO v_int FROM (
    SELECT p.id FROM steadfast_payouts p JOIN steadfast_payout_items i ON i.payout_id = p.id
    GROUP BY p.id HAVING p.total_amount <> sum(i.net_paid)) x;
  PERFORM pg_temp.ck('Every payout: the parcels still add up to what Steadfast paid', v_int = 0, v_int || ' payouts off');
  SELECT count(*) INTO v_int FROM t_payouts0 b JOIN (
    SELECT payout_id, sum(delivery_charge + cod_fee + other_deduction) AS kept FROM steadfast_payout_items GROUP BY payout_id) a
    ON a.payout_id = b.id WHERE a.kept <> b.in_payout_kept;
  PERFORM pg_temp.ck('Every payout: what Steadfast kept from it is unchanged', v_int = 0, v_int || ' payouts changed');
  SELECT count(*) INTO v_int FROM steadfast_payouts p JOIN (
    SELECT payout_id, sum(bill_paid_separately) AS sep FROM steadfast_payout_items GROUP BY payout_id) s ON s.payout_id = p.id
    WHERE s.sep <> COALESCE((p.raw ->> 'paid_bills')::numeric, 0)
      AND EXISTS (SELECT 1 FROM steadfast_payout_items x WHERE x.payout_id = p.id AND x.split_rule IS NOT NULL);
  PERFORM pg_temp.ck('Every recalculated payout: the bills paid separately add up to paid_bills', v_int = 0, v_int || ' payouts off');

  -- ------------------------------------------------- the real examples
  SELECT order_profit(id) INTO v_json FROM orders WHERE order_number = 'NM-3917';
  PERFORM pg_temp.ck('NM-3917: courier + COD ৳114 (৳105 bill + ৳9 COD fee), "Share of payout"',
    (v_json ->> 'courier')::numeric = 114 AND v_json ->> 'courier_kind' = 'share'
    AND (v_json ->> 'courier_charge')::numeric = 105 AND (v_json ->> 'cod_fee')::numeric = 9, v_json::text);
  PERFORM pg_temp.ck('NM-3917: profit ৳311', (v_json ->> 'profit')::numeric = 311, v_json ->> 'profit');
  SELECT order_profit(id) INTO v_json FROM orders WHERE order_number = 'NM-3890';
  PERFORM pg_temp.ck('NM-3890: its own ৳65 bill (paid outside the payout)',
    (v_json ->> 'courier')::numeric = 65 AND (v_json ->> 'bill_paid_separately')::numeric = 65, v_json::text);
  SELECT order_profit(id) INTO v_json FROM orders WHERE order_number = 'NM-3330';
  PERFORM pg_temp.ck('NM-3330: ৳110 (half of ৳220)', (v_json ->> 'courier')::numeric = 110, v_json::text);
  SELECT order_profit(id) INTO v_json FROM orders WHERE order_number = 'NM-3790';
  PERFORM pg_temp.ck('NM-3790: ৳110 + ৳14 COD fee', (v_json ->> 'courier')::numeric = 124, v_json::text);

  -- ------------------------------------------------- money unchanged
  SELECT p INTO v_pos0 FROM t_pos0;
  v_pos := money_position();
  PERFORM pg_temp.ck('Money: every account balance is unchanged', v_pos -> 'accounts' = v_pos0 -> 'accounts',
    (v_pos -> 'accounts')::text);
  PERFORM pg_temp.ck('Money: "With Steadfast" and net worth unchanged',
    v_pos -> 'with_steadfast' = v_pos0 -> 'with_steadfast' AND v_pos -> 'net_worth' = v_pos0 -> 'net_worth');

  -- ------------------------------------------------- labels
  SELECT o.id INTO v_order FROM orders o JOIN order_courier_costs cc ON cc.order_id = o.id
  WHERE (SELECT count(*) FROM steadfast_payout_items i WHERE i.payout_id = cc.payout_id) = 1 LIMIT 1;
  SELECT kind INTO v_kind FROM order_courier_costs_for(ARRAY[v_order]);
  PERFORM pg_temp.ck('A payout with one parcel: "From Steadfast" (exact)', v_order IS NOT NULL AND v_kind = 'exact', COALESCE(v_kind, 'none found'));
  SELECT o.id INTO v_order FROM orders o WHERE o.delivery_zone = 'hand_delivered' AND o.status = 'delivered' LIMIT 1;
  SELECT kind, amount INTO v_kind, v_amount FROM order_courier_costs_for(ARRAY[v_order]);
  PERFORM pg_temp.ck('Hand delivery: "No courier", ৳0, final', v_kind = 'none' AND v_amount = 0
    AND (order_profit(v_order) ->> 'courier_known')::boolean, COALESCE(v_kind, 'no hand-delivered order'));
  SELECT o.id INTO v_order FROM orders o
  WHERE o.status = 'delivered' AND o.steadfast_consignment_id IS NULL AND o.delivery_zone <> 'hand_delivered' LIMIT 1;
  SELECT kind, amount INTO v_kind, v_amount FROM order_courier_costs_for(ARRAY[v_order]);
  PERFORM pg_temp.ck('Never booked on Steadfast: "Not booked on Steadfast", ৳0 as before', v_kind = 'not_booked' AND v_amount = 0, COALESCE(v_kind, 'none found'));
  v_json := inventory_sales_profit('2026-11-01', '2026-11-30');
  PERFORM pg_temp.ck('Sales profit lists a label on every order',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json -> 'orders') e WHERE e ->> 'courier_kind' IS NULL));

  -- ------------------------------------------------- expected fee
  -- Enough history: an inside-Dhaka COD order loses its payout row here.
  SELECT o.id, o.steadfast_cod_amount INTO v_order, v_cod FROM orders o JOIN order_courier_costs cc ON cc.order_id = o.id
  WHERE o.status = 'delivered' AND o.delivery_zone = 'inside_dhaka' AND o.steadfast_consignment_id IS NOT NULL
    AND COALESCE(o.steadfast_cod_amount, 0) > 500
  ORDER BY o.created_at DESC LIMIT 1;
  DELETE FROM order_courier_costs WHERE order_id = v_order;
  SELECT round(avg(b)) INTO v_bill FROM (
    SELECT cc.delivery_charge + cc.bill_paid_separately AS b FROM order_courier_costs cc JOIN orders o ON o.id = cc.order_id
    WHERE o.status = 'delivered' AND o.delivery_zone = 'inside_dhaka' ORDER BY o.created_at DESC, o.order_number DESC LIMIT 10) h;
  SELECT kind, amount, cod_fee INTO v_kind, v_amount, v_num FROM order_courier_costs_for(ARRAY[v_order]);
  PERFORM pg_temp.ck('Expected fee (enough history): average bill of the last 10 inside-Dhaka orders + 1% COD fee on (COD − bill)',
    v_kind = 'expected' AND v_amount = v_bill + round(0.01 * (v_cod - v_bill)) AND v_num = round(0.01 * (v_cod - v_bill)),
    format('kind %s amount %s bill %s cod %s', v_kind, v_amount, v_bill, v_cod));
  v_json := order_profit(v_order);
  PERFORM pg_temp.ck('Expected fee is counted in the order profit', (v_json ->> 'courier')::numeric = v_amount
    AND v_json ->> 'courier_kind' = 'expected' AND NOT (v_json ->> 'courier_known')::boolean, v_json::text);

  -- Fewer than 3: no outside-Dhaka payout rows at all; a prepaid order.
  SELECT o.id INTO v_order FROM orders o JOIN order_courier_costs cc ON cc.order_id = o.id
  WHERE o.status = 'delivered' AND o.delivery_zone = 'outside_dhaka' AND o.steadfast_consignment_id IS NOT NULL LIMIT 1;
  DELETE FROM order_courier_costs cc USING orders o WHERE o.id = cc.order_id AND o.delivery_zone = 'outside_dhaka';
  UPDATE orders SET steadfast_cod_amount = 0 WHERE id = v_order;
  SELECT kind, amount, cod_fee INTO v_kind, v_amount, v_num FROM order_courier_costs_for(ARRAY[v_order]);
  PERFORM pg_temp.ck('Expected fee (fewer than 3 orders): the outside-Dhaka delivery fee in Settings; prepaid (COD ৳0): no COD fee',
    v_kind = 'expected' AND v_amount = courier_zone_fee('outside_dhaka') AND v_num = 0,
    format('kind %s amount %s', v_kind, v_amount));

  -- ------------------------------------------------- the guard
  SELECT order_id INTO v_order FROM order_courier_costs WHERE split_rule = 'b53-backfill' LIMIT 1;
  SELECT total_kept INTO v_num FROM order_courier_costs WHERE order_id = v_order;
  UPDATE order_courier_costs SET delivery_charge = 1, total_kept = 1, net_received = 1 WHERE order_id = v_order;
  PERFORM pg_temp.ck('Guard: the old Steadfast code cannot undo the recalculated numbers',
    (SELECT total_kept FROM order_courier_costs WHERE order_id = v_order) = v_num);
  UPDATE order_courier_costs SET total_kept = 1, split_rule = 'b53' WHERE order_id = v_order;
  PERFORM pg_temp.ck('Guard: the new Steadfast code can change them',
    (SELECT total_kept FROM order_courier_costs WHERE order_id = v_order) = 1);
END
$test$;

SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
