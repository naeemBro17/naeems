-- Batch 65, tested on the database (run by e2e/batch-65.spec.ts through
-- the Supabase command line).
--
-- SAFE ON THE LIVE DATABASE: everything runs inside ONE transaction that
-- always ends with ROLLBACK. Only made-up rows are added (product
-- "B65 …", made-up phones 0179996xxxx, a made-up Steadfast payout);
-- Inventory mode is set Off inside the transaction only.
--
-- Before Naeem has run migration-062 the spec puts the migration in front
-- of this file (same transaction, without its BEGIN / COMMIT).
--
-- Result: the row (tag TEST_RESULT, results = JSON list of
-- { name, ok, detail }) of the SELECT before the ROLLBACK.
CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text) ON COMMIT DROP;
GRANT ALL ON t_res TO authenticated, anon;
GRANT ALL ON SEQUENCE t_res_n_seq TO authenticated, anon;

DO $test$
DECLARE
  v_admin    uuid;
  v_cust     uuid;
  c_admin    text;
  c_cust     text;
  c_other    text;
  c_nobody   text;
  v_tag      text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_bank     uuid := money_account_for_method('bank');
  v_cash     uuid := money_account_for_method('cash');
  v_sf       uuid := money_steadfast_account();
  d0         numeric;
  v_err      text;
  v_j        jsonb;
  v_n        integer;
  v_prod     uuid;
  v_o1       uuid;
  v_o2       uuid;
  v_hand     uuid;
  v_ship     uuid;
  v_old      uuid;
  v_payout   uuid;
  v_row      record;
  v_cash0    numeric;
  v_sf0      numeric;
  v_bank0    numeric;
  v_profit0  numeric;
  v_at       timestamptz;
BEGIN
  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2')::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;
  -- Another signed-in person (a made-up login that owns none of these orders).
  c_other := json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text;
  c_nobody := json_build_object('role', 'anon')::text;

  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.diff() RETURNS numeric LANGUAGE sql AS
    'SELECT (money_position() ->> ''difference'')::numeric'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.bal(p_acc uuid) RETURNS numeric LANGUAGE sql AS
    'SELECT COALESCE(sum(amount), 0) FROM money_ledger WHERE account_id = p_acc'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.profit_today() RETURNS numeric LANGUAGE sql AS
    'SELECT (money_profit_parts(inventory_dhaka_today(), inventory_dhaka_today()) ->> ''net_profit'')::numeric'$f$;

  PERFORM set_config('request.jwt.claims', c_admin, true);
  d0 := pg_temp.diff();
  PERFORM pg_temp.ck('0 Balance check difference before the test is ৳0.00', abs(d0) < 0.01, d0::text);

  -- Inventory mode Off for this transaction (stock numbers, no lots).
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);

  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('B65-' || v_tag, 'b65-' || v_tag, 'B65 Test Cream', 1000, 'in_stock', 50, true)
  RETURNING id INTO v_prod;

  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o1 FROM place_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    'B65 Note One', '01799965001', 'Dhaka', 'Dhaka', 'Gulshan', 'B65 road', 'inside_dhaka', 'cod');
  SELECT order_id INTO v_o2 FROM place_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    'B65 Note Two', '01799965002', 'Dhaka', 'Dhaka', 'Gulshan', 'B65 road', 'inside_dhaka', 'cod');
  PERFORM pg_temp.ck('0 Setup: two orders for the test customer',
    (SELECT count(*) FROM orders WHERE id IN (v_o1, v_o2) AND customer_id = v_cust) = 2);

  -- ------------------------------------------------------ 1. NOTE TO CUSTOMER
  PERFORM pg_temp.ck('1 New columns exist, return_delivery_paid is 0 on the new orders',
    (SELECT return_delivery_paid FROM orders WHERE id = v_o1) = 0
    AND (SELECT note_to_customer FROM orders WHERE id = v_o1) IS NULL);

  -- A customer may not write a note.
  v_err := NULL;
  BEGIN
    PERFORM admin_set_note_to_customer(v_o1, 'From the customer');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 A customer cannot send a note', v_err = 'Not authorized.', COALESCE(v_err, 'it ran'));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_set_note_to_customer(v_o1, '  Your parcel leaves tomorrow.' || chr(10) || 'Thank you!  ');
  SELECT * INTO v_row FROM orders WHERE id = v_o1;
  PERFORM pg_temp.ck('1 Send: the note is saved trimmed, with the time, not seen',
    v_row.note_to_customer = 'Your parcel leaves tomorrow.' || chr(10) || 'Thank you!'
    AND v_row.note_to_customer_at IS NOT NULL AND v_row.note_to_customer_seen_at IS NULL,
    COALESCE(v_row.note_to_customer, 'null'));

  v_err := NULL;
  BEGIN
    PERFORM admin_set_note_to_customer(v_o1, repeat('a', 501));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 More than 500 characters is refused', v_err = 'A note can be at most 500 characters.', COALESCE(v_err, 'it ran'));
  PERFORM pg_temp.ck('1 … and the note is unchanged',
    (SELECT note_to_customer FROM orders WHERE id = v_o1) = 'Your parcel leaves tomorrow.' || chr(10) || 'Thank you!');

  -- The customer sees her own unseen note; nobody else does.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT * INTO v_row FROM my_unseen_order_note();
  PERFORM pg_temp.ck('1 The customer gets her unseen note', v_row.order_id = v_o1, COALESCE(v_row.order_id::text, 'none'));
  PERFORM set_config('request.jwt.claims', c_other, true);
  SELECT count(*) INTO v_n FROM my_unseen_order_note();
  PERFORM pg_temp.ck('1 Another customer gets nothing', v_n = 0, v_n::text);
  PERFORM set_config('request.jwt.claims', c_nobody, true);
  SELECT count(*) INTO v_n FROM my_unseen_order_note();
  PERFORM pg_temp.ck('1 Not signed in: nothing', v_n = 0, v_n::text);
  PERFORM pg_temp.ck('1 Visitors (anon) cannot call the note functions at all',
    NOT has_function_privilege('anon', 'my_unseen_order_note()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'mark_order_note_seen(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'admin_set_note_to_customer(uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'admin_set_return_delivery_paid(uuid, numeric)', 'EXECUTE'));

  -- Another person marking it seen does nothing.
  PERFORM set_config('request.jwt.claims', c_other, true);
  PERFORM mark_order_note_seen(v_o1);
  PERFORM pg_temp.ck('1 Someone else marking it seen changes nothing',
    (SELECT note_to_customer_seen_at FROM orders WHERE id = v_o1) IS NULL);

  -- The newest unseen note comes first.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_set_note_to_customer(v_o2, 'Second order note');
  -- (One transaction has one clock: the first note is made a minute older.)
  UPDATE orders SET note_to_customer_at = note_to_customer_at - interval '1 minute' WHERE id = v_o1;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT * INTO v_row FROM my_unseen_order_note();
  PERFORM pg_temp.ck('1 Two unseen notes: the newest one is returned', v_row.order_id = v_o2 AND v_row.note = 'Second order note',
    COALESCE(v_row.order_id::text, 'none'));
  PERFORM mark_order_note_seen(v_o2);
  PERFORM pg_temp.ck('1 Her own mark seen works', (SELECT note_to_customer_seen_at FROM orders WHERE id = v_o2) IS NOT NULL);
  SELECT * INTO v_row FROM my_unseen_order_note();
  PERFORM pg_temp.ck('1 After seeing the newest, the other unseen one is next', v_row.order_id = v_o1, COALESCE(v_row.order_id::text, 'none'));
  PERFORM mark_order_note_seen(v_o1);
  SELECT count(*) INTO v_n FROM my_unseen_order_note();
  PERFORM pg_temp.ck('1 All seen: nothing to show', v_n = 0, v_n::text);

  -- Editing makes it new again; removing clears everything.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_set_note_to_customer(v_o1, 'Edited note');
  SELECT * INTO v_row FROM orders WHERE id = v_o1;
  PERFORM pg_temp.ck('1 Edit: new text, seen is cleared', v_row.note_to_customer = 'Edited note' AND v_row.note_to_customer_seen_at IS NULL);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT * INTO v_row FROM my_unseen_order_note();
  PERFORM pg_temp.ck('1 Edit: the customer sees it again', v_row.order_id = v_o1 AND v_row.note = 'Edited note',
    COALESCE(v_row.order_id::text, 'none'));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_set_note_to_customer(v_o1, '   ');
  SELECT * INTO v_row FROM orders WHERE id = v_o1;
  PERFORM pg_temp.ck('1 Remove (empty text): all three note columns are empty',
    v_row.note_to_customer IS NULL AND v_row.note_to_customer_at IS NULL AND v_row.note_to_customer_seen_at IS NULL);
  PERFORM mark_order_note_seen(v_o1);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM mark_order_note_seen(v_o1);
  PERFORM pg_temp.ck('1 Mark seen on an order with no note does nothing',
    (SELECT note_to_customer_seen_at FROM orders WHERE id = v_o1) IS NULL);

  -- A customer cannot write the four columns directly.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_n := -1;
  v_err := NULL;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE orders SET note_to_customer = 'hacked', note_to_customer_at = now(), note_to_customer_seen_at = now(),
                      return_delivery_paid = 999
    WHERE id = v_o2;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    EXECUTE 'RESET ROLE';
  END;
  PERFORM pg_temp.ck('1 A customer''s direct UPDATE of the four columns changes nothing',
    (v_n = 0 OR v_err IS NOT NULL)
    AND (SELECT note_to_customer FROM orders WHERE id = v_o2) = 'Second order note'
    AND (SELECT return_delivery_paid FROM orders WHERE id = v_o2) = 0,
    COALESCE(v_err, v_n::text || ' rows'));
  v_n := -1;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_n FROM orders WHERE id = v_o2 AND note_to_customer = 'Second order note';
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
  END;
  PERFORM pg_temp.ck('1 … but she can read the note on her own order', v_n = 1, v_n::text);

  -- ---------------------------------------------- 2. RETURNS WITH A PAID CHARGE
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_hand FROM place_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    'B65 Hand', '01799965003', 'Dhaka', 'Dhaka', 'Gulshan', 'B65 road', 'inside_dhaka', 'cod');
  SELECT order_id INTO v_ship FROM place_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    'B65 Steadfast', '01799965004', 'Dhaka', 'Dhaka', 'Gulshan', 'B65 road', 'inside_dhaka', 'cod');
  SELECT order_id INTO v_old FROM place_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    'B65 Old Call', '01799965005', 'Dhaka', 'Dhaka', 'Gulshan', 'B65 road', 'inside_dhaka', 'cod');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  -- The Steadfast one is booked (made-up consignment, nothing sent to Steadfast).
  UPDATE orders SET steadfast_consignment_id = 'E2E-B65-' || v_tag, steadfast_cod_amount = total WHERE id = v_ship;
  PERFORM admin_set_order_status(v_hand, 'confirmed');
  PERFORM admin_set_order_status(v_hand, 'shipped');
  PERFORM admin_set_order_status(v_ship, 'confirmed');
  PERFORM admin_set_order_status(v_ship, 'shipped');
  PERFORM admin_set_order_status(v_old, 'confirmed');
  PERFORM admin_set_order_status(v_old, 'shipped');
  PERFORM pg_temp.ck('2 Balance check unchanged with three orders in transit', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);

  v_cash0 := pg_temp.bal(v_cash);
  v_sf0 := pg_temp.bal(v_sf);
  v_bank0 := pg_temp.bal(v_bank);
  v_profit0 := pg_temp.profit_today();

  -- Old two-argument call (as every caller before Batch 65).
  PERFORM admin_mark_order_returned(v_old, 'e2e old call');
  PERFORM pg_temp.ck('2 Old 2-argument Mark returned still works, ৳0 stored',
    (SELECT status FROM orders WHERE id = v_old) = 'returned' AND (SELECT return_delivery_paid FROM orders WHERE id = v_old) = 0);
  PERFORM pg_temp.ck('2 … no money line for it', NOT EXISTS (SELECT 1 FROM money_ledger WHERE order_id = v_old AND type = 'return_delivery_paid'));
  PERFORM pg_temp.ck('2 … profit today unchanged (no courier bill yet)', abs(pg_temp.profit_today() - v_profit0) < 0.01,
    pg_temp.profit_today()::text || ' vs ' || v_profit0::text);

  -- Hand / other courier: ৳80 goes to Cash.
  PERFORM admin_mark_order_returned(v_hand, NULL, 80);
  PERFORM pg_temp.ck('2 Hand: Mark returned with ৳80 stores 80',
    (SELECT status FROM orders WHERE id = v_hand) = 'returned' AND (SELECT return_delivery_paid FROM orders WHERE id = v_hand) = 80);
  PERFORM pg_temp.ck('2 Hand: ৳80 is in Cash today', abs(pg_temp.bal(v_cash) - v_cash0 - 80) < 0.01
    AND (SELECT entry_date FROM money_ledger WHERE order_id = v_hand AND type = 'return_delivery_paid') = inventory_dhaka_today(),
    (pg_temp.bal(v_cash) - v_cash0)::text);
  PERFORM pg_temp.ck('2 Hand: With Steadfast unchanged', abs(pg_temp.bal(v_sf) - v_sf0) < 0.01);
  PERFORM pg_temp.ck('2 Hand: profit today +৳80 (delivery collected on the return)',
    abs(pg_temp.profit_today() - v_profit0 - 80) < 0.01, (pg_temp.profit_today() - v_profit0)::text);
  SELECT * INTO v_row FROM money_order_parts_for(ARRAY[v_hand]);
  PERFORM pg_temp.ck('2 Hand: the order''s parts say delivery ৳80, sale ৳0', v_row.delivery = 80 AND v_row.sale = 0 AND v_row.counts,
    v_row.delivery::text);
  PERFORM pg_temp.ck('2 Hand: All figures match (difference unchanged)', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);

  -- Correct it later.
  PERFORM admin_set_return_delivery_paid(v_hand, 50);
  PERFORM pg_temp.ck('2 Change later to ৳50: Cash and profit follow', abs(pg_temp.bal(v_cash) - v_cash0 - 50) < 0.01
    AND abs(pg_temp.profit_today() - v_profit0 - 50) < 0.01, (pg_temp.bal(v_cash) - v_cash0)::text);
  PERFORM pg_temp.ck('2 Change later: All figures match', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);
  PERFORM admin_set_return_delivery_paid(v_hand, 80);
  v_err := NULL;
  BEGIN
    PERFORM admin_set_return_delivery_paid(v_hand, -5);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('2 A negative amount is refused', v_err = 'The amount cannot be below 0.', COALESCE(v_err, 'it ran'));
  v_err := NULL;
  BEGIN
    PERFORM admin_set_return_delivery_paid(v_o2, 80);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('2 Only a returned order takes the amount', v_err = 'Only a returned order has a delivery charge paid on return.',
    COALESCE(v_err, 'it ran'));
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM admin_set_return_delivery_paid(v_hand, 0);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('2 A customer cannot change it', v_err = 'Not authorized.', COALESCE(v_err, 'it ran'));
  PERFORM set_config('request.jwt.claims', c_admin, true);

  -- Steadfast: ৳80 waits With Steadfast (through the damaged-returns function, nothing damaged).
  PERFORM admin_mark_order_returned_damaged(v_ship, NULL, '[]'::jsonb, 80);
  PERFORM pg_temp.ck('2 Steadfast: Mark returned (damaged function) with ৳80 stores 80',
    (SELECT status FROM orders WHERE id = v_ship) = 'returned' AND (SELECT return_delivery_paid FROM orders WHERE id = v_ship) = 80);
  PERFORM pg_temp.ck('2 Steadfast: ৳80 is With Steadfast, Cash unchanged',
    abs(pg_temp.bal(v_sf) - v_sf0 - 80) < 0.01 AND abs(pg_temp.bal(v_cash) - v_cash0 - 80) < 0.01,
    format('sf %s, cash %s', pg_temp.bal(v_sf) - v_sf0, pg_temp.bal(v_cash) - v_cash0));
  PERFORM pg_temp.ck('2 Steadfast: All figures match before the payout', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);
  v_j := order_profit(v_ship);
  PERFORM pg_temp.ck('2 Steadfast: Profit card has "paid on return" ৳80 and profit ৳80 before the bill',
    (v_j ->> 'return_delivery_paid')::numeric = 80 AND (v_j ->> 'profit')::numeric = 80 AND (v_j ->> 'delivery')::numeric = 0, v_j::text);

  -- The payout: Steadfast collected ৳80, kept ৳60 + ৳0.80, paid ৳19.20.
  INSERT INTO steadfast_payouts (steadfast_payment_id, paid_at, total_amount, parcel_count, items_synced)
  VALUES ('E2E-B65-' || v_tag, now(), 19.20, 1, true) RETURNING id INTO v_payout;
  INSERT INTO steadfast_payout_items (payout_id, item_key, consignment_id, invoice, order_id, cod_collected, delivery_charge, cod_fee,
                                      net_paid, expected_cod, match_status)
  VALUES (v_payout, 'c:E2E-B65-' || v_tag, 'E2E-B65-' || v_tag, (SELECT order_number FROM orders WHERE id = v_ship), v_ship,
          80, 60, 0.8, 19.2, 80, 'matched');
  INSERT INTO order_courier_costs (order_id, cod_collected, delivery_charge, cod_fee, other_deduction, total_kept, net_received, payout_id, paid_at)
  VALUES (v_ship, 80, 60, 0.8, 0, 60.8, 19.2, v_payout, now());
  v_j := order_profit(v_ship);
  PERFORM pg_temp.ck('2 Steadfast: with the bill the loss is ৳60.80 − ৳80 = a gain of ৳19.20',
    (v_j ->> 'profit')::numeric = 19.2 AND (v_j ->> 'courier')::numeric = 60.8, v_j::text);
  PERFORM pg_temp.ck('2 Steadfast: All figures match after the payout arrives (not placed yet)', abs(pg_temp.diff() - d0) < 0.01,
    pg_temp.diff()::text);
  PERFORM money_place_payout(v_payout, v_bank);
  PERFORM pg_temp.ck('2 Steadfast: placing the payout empties the ৳80 from With Steadfast, ৳19.20 lands in Bank',
    abs(pg_temp.bal(v_sf) - v_sf0) < 0.01 AND abs(pg_temp.bal(v_bank) - v_bank0 - 19.2) < 0.01,
    format('sf %s, bank %s', pg_temp.bal(v_sf) - v_sf0, pg_temp.bal(v_bank) - v_bank0));
  PERFORM pg_temp.ck('2 Steadfast: All figures match after the payout is placed', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);

  SELECT count(*) INTO v_n FROM money_ledger WHERE type = 'return_delivery_paid' AND order_id IN (v_hand, v_ship);
  PERFORM pg_temp.ck('2 Ledger: one "Delivery charge paid on return" line per order', v_n = 2, v_n::text);
  PERFORM pg_temp.ck('2 Ledger label', money_type_label('return_delivery_paid') = 'Delivery charge paid on return');

  -- Every older returned order keeps ৳0 (nothing changes for them).
  PERFORM pg_temp.ck('2 Older returned orders all have ৳0',
    NOT EXISTS (SELECT 1 FROM orders WHERE status = 'returned' AND return_delivery_paid <> 0 AND id NOT IN (v_hand, v_ship)));

  PERFORM pg_temp.ck('9 Balance check difference at the end is still ৳0.00', abs(pg_temp.diff()) < 0.01, pg_temp.diff()::text);
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
