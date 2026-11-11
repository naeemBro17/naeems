-- Batch 43 database tests (run by e2e/batch-43.spec.ts through the Supabase
-- command line). Everything happens inside ONE transaction that is always
-- rolled back at the end: the test products, lots, supplier, orders,
-- investor and money entries never exist outside this script, and Inventory
-- mode is on only for this transaction (inventory.test_mode).
--
-- Checks: the offer rows (the Stock report's rows plus speed, history and
-- price), the buying-list rows (usual source, left, on the way, newest
-- cost), "below cost" (cost of the lot that sells next, pack size, who sees
-- taka) and the investor report (every number equals money_summary /
-- report_investors / money_profit_parts).
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
BEGIN;
DO $test$
DECLARE
  v_admin    uuid;
  v_cust     uuid;
  c_admin    text;
  c_cust     text;
  v_err      text;
  v_txt      text;
  v_pa       uuid;
  v_pb       uuid;
  v_pc       uuid;
  v_pd       uuid;
  v_sup      uuid;
  v_sup2     uuid;
  v_inv      uuid;
  v_cash     uuid;
  v_json     jsonb;
  v_row      jsonb;
  v_rep      jsonb;
  v_sum      jsonb;
  v_parts    jsonb;
  v_int      integer;
  v_num      numeric;
  v_ok       boolean;
  v_today    date := (now() AT TIME ZONE 'Asia/Dhaka')::date;
  v_start    date := date_trunc('month', (now() AT TIME ZONE 'Asia/Dhaka')::date - interval '3 years')::date;
  v_mfrom    date := date_trunc('month', (now() AT TIME ZONE 'Asia/Dhaka')::date)::date;
  v_tag      text := to_char(clock_timestamp(), 'HH24MISSMS');
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  IF EXISTS (SELECT 1 FROM lots WHERE kind = 'opening') OR EXISTS (SELECT 1 FROM money_books WHERE confirmed_at IS NOT NULL) THEN
    PERFORM pg_temp.ck('Real opening stock or opening balances exist — these tests run only before them', true, 'skipped');
    RETURN;
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  SELECT id INTO v_cash FROM money_accounts WHERE payment_method = 'cash';

  -- ---------- Permissions first
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_int := 0;
  BEGIN PERFORM smart_offer_rows(); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM smart_buying_rows(); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM smart_below_cost('[]'::jsonb); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM report_investor_statement(gen_random_uuid(), v_today, v_today); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: a customer gets "Not authorized." from all 4 helpers', v_int = 4, v_int::text);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN PERFORM smart_below_cost('[]'::jsonb); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: the public cannot call them at all', v_err LIKE 'permission denied%', v_err);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM smart_selling_price(gen_random_uuid(), NULL); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: the helper functions inside are not callable from the website', v_err LIKE 'permission denied%', v_err);

  -- ---------- Test data
  -- A cream ৳1,000 (expires in 60 days), B serum ৳500 (offer ৳450),
  -- C toner (already expired), D drops in packs of 10.
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B43-A-' || v_tag, 'e2e-b43-a-' || v_tag, 'E2E B43 Cream', 1000, 'in_stock', 0, true) RETURNING id INTO v_pa;
  INSERT INTO products (sku, slug, name, retail_price, offer_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B43-B-' || v_tag, 'e2e-b43-b-' || v_tag, 'E2E B43 Serum', 500, 450, 'in_stock', 0, true) RETURNING id INTO v_pb;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B43-C-' || v_tag, 'e2e-b43-c-' || v_tag, 'E2E B43 Toner', 300, 'in_stock', 0, true) RETURNING id INTO v_pc;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active, pack_size, stock_unit)
  VALUES ('E2E-B43-D-' || v_tag, 'e2e-b43-d-' || v_tag, 'E2E B43 Drops', 250, 'in_stock', 0, true, 10, 'pcs') RETURNING id INTO v_pd;

  PERFORM set_config('inventory.test_mode', 'on', true);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM inventory_confirm_opening(v_start, 0, jsonb_build_array(
    jsonb_build_object('product_id', v_pa, 'source', 'import', 'buy_price_bdt', '100', 'pieces', 10, 'expiry', to_char(v_today + 60, 'YYYY-MM-DD')),
    jsonb_build_object('product_id', v_pb, 'source', 'import', 'buy_price_bdt', '50', 'pieces', 20, 'expiry', '2030-06-01'),
    jsonb_build_object('product_id', v_pc, 'source', 'import', 'buy_price_bdt', '40', 'pieces', 4, 'expiry', to_char(v_today - 70, 'YYYY-MM-DD')),
    jsonb_build_object('product_id', v_pd, 'source', 'import', 'buy_price_bdt', '200', 'pieces', 3, 'expiry', '2030-01-01')),
    'e2e-b43.xlsx');
  PERFORM money_confirm_opening(v_start, jsonb_build_array(jsonb_build_object('account_id', v_cash, 'amount', 5000)), '[]'::jsonb, '[]'::jsonb);
  v_sup := inventory_save_supplier('E2E B43 Supplier ' || v_tag, 'Testland ' || v_tag);
  v_sup2 := inventory_save_supplier('E2E B43 Other ' || v_tag, 'Otherland ' || v_tag);
  -- Serum: once from the other supplier (10 days ago), twice from the main
  -- one (today; and 7 more "costs pending" arriving in 20 days, with 3 creams).
  PERFORM inventory_save_lot(jsonb_build_object('source_type', 'import', 'country', 'Otherland ' || v_tag, 'supplier_id', v_sup2,
    'lot_date', (v_today - 10)::text, 'costs_pending', false, 'notes', 'e2e b43', 'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pb, 'qty', 2, 'unit_price_foreign', '55', 'expiry_date', '2031-01-01')), 'costs', '[]'::jsonb));
  PERFORM inventory_save_lot(jsonb_build_object('source_type', 'import', 'country', 'Testland ' || v_tag, 'supplier_id', v_sup,
    'lot_date', v_today::text, 'costs_pending', false, 'notes', 'e2e b43', 'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pb, 'qty', 5, 'unit_price_foreign', '60', 'expiry_date', '2031-01-01')), 'costs', '[]'::jsonb));
  PERFORM inventory_save_lot(jsonb_build_object('source_type', 'import', 'country', 'Testland ' || v_tag, 'supplier_id', v_sup,
    'lot_date', (v_today + 20)::text, 'costs_pending', true, 'notes', 'e2e b43', 'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pb, 'qty', 7, 'unit_price_foreign', '70', 'expiry_date', '2031-06-01'),
      jsonb_build_object('product_id', v_pa, 'qty', 3, 'unit_price_foreign', '110', 'expiry_date', '2031-06-01')), 'costs', '[]'::jsonb));
  -- Sales today: 2 creams, 3 serums.
  PERFORM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 2), jsonb_build_object('product_id', v_pb, 'quantity', 3)),
    p_full_name => 'E2E B43 One', p_phone => '01799943041', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);

  -- ---------- Part 1: offer rows
  v_json := smart_offer_rows();
  v_rep := report_stock();
  EXECUTE 'RESET ROLE';
  SELECT r INTO v_row FROM jsonb_array_elements(v_json -> 'rows') r
  WHERE (r ->> 'product_id')::uuid = v_pa AND (r ->> 'lot_code') = 'L-000';
  PERFORM pg_temp.ck('Offers: the cream row — 8 left, 2 sold in 90 days, 90 days of history, price ৳1,000, cost ৳100',
    (v_row ->> 'units')::int = 8 AND (v_row ->> 'units_90')::int = 2 AND (v_row ->> 'history_days')::int = 90
    AND (v_row ->> 'price')::numeric = 1000 AND (v_row ->> 'unit_cost')::numeric = 100 AND (v_row ->> 'units_before')::int = 0, v_row::text);
  SELECT r INTO v_row FROM jsonb_array_elements(v_json -> 'rows') r
  WHERE (r ->> 'product_id')::uuid = v_pa AND (r ->> 'lot_code') <> 'L-000';
  PERFORM pg_temp.ck('Offers: the later cream lot counts the 8 that sell first (units before = 8)',
    (v_row ->> 'units')::int = 3 AND (v_row ->> 'units_before')::int = 8, v_row::text);
  SELECT r INTO v_row FROM jsonb_array_elements(v_json -> 'rows') r WHERE (r ->> 'product_id')::uuid = v_pb LIMIT 1;
  PERFORM pg_temp.ck('Offers: the price is the offer price when it is lower (serum ৳450)', (v_row ->> 'price')::numeric = 450, v_row ->> 'price');
  SELECT r INTO v_row FROM jsonb_array_elements(v_json -> 'rows') r WHERE (r ->> 'product_id')::uuid = v_pc;
  PERFORM pg_temp.ck('Offers: the expired toner is there (4 units, expiry before this month) for the Expired list',
    (v_row ->> 'units')::int = 4 AND (v_row ->> 'expiry_date')::date < v_mfrom, v_row::text);
  SELECT count(*) INTO v_int FROM jsonb_array_elements(v_rep -> 'rows') r
  WHERE (r ->> 'product_id')::uuid IN (v_pa, v_pb, v_pc, v_pd) AND r ->> 'expiry_date' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json -> 'rows') o
                    WHERE o ->> 'lot_item_id' = r ->> 'lot_item_id' AND (o ->> 'units')::int = (r ->> 'units')::int
                      AND (o ->> 'unit_cost')::numeric = (r ->> 'unit_cost')::numeric
                      AND round((o ->> 'units_90')::numeric / 3.0, 1) = (r ->> 'per_month')::numeric);
  PERFORM pg_temp.ck('Offers: every row equals the Stock report (units, landed cost, speed = 90 days ÷ 3)', v_int = 0, v_int::text);

  -- ---------- Part 2: buying list rows
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := smart_buying_rows();
  EXECUTE 'RESET ROLE';
  SELECT r INTO v_row FROM jsonb_array_elements(v_json -> 'rows') r WHERE (r ->> 'product_id')::uuid = v_pb;
  PERFORM pg_temp.ck('Buying: the serum is usually bought from the main supplier (2 lots against 1) and its country',
    (v_row ->> 'supplier_id')::uuid = v_sup AND v_row ->> 'country' = 'Testland ' || v_tag, v_row::text);
  PERFORM pg_temp.ck('Buying: serum left = 20 + 2 + 5 − 3 sold = 24; on the way = 7 (costs pending, dated later)',
    (v_row ->> 'units_left')::int = 24 AND (v_row ->> 'units_on_way')::int = 7, v_row::text);
  PERFORM pg_temp.ck('Buying: serum sold 3 in 90 and 120 days; newest landed cost and buy price ৳70',
    (v_row ->> 'units_90')::int = 3 AND (v_row ->> 'sold_120')::int = 3
    AND (v_row ->> 'last_unit_cost')::numeric = 70 AND (v_row ->> 'last_buy_unit')::numeric = 70, v_row::text);
  SELECT r INTO v_row FROM jsonb_array_elements(v_json -> 'rows') r WHERE (r ->> 'product_id')::uuid = v_pa;
  PERFORM pg_temp.ck('Buying: the cream — 8 left, 3 on the way',
    (v_row ->> 'units_left')::int = 8 AND (v_row ->> 'units_on_way')::int = 3 AND (v_row ->> 'supplier_id')::uuid = v_sup, v_row::text);
  PERFORM pg_temp.ck('Buying: a product only in the opening stock is not on any buying list',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json -> 'rows') r WHERE (r ->> 'product_id')::uuid IN (v_pc, v_pd)));
  PERFORM pg_temp.ck('Buying: the supplier and country lists include the test ones',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_json -> 'suppliers') s WHERE (s ->> 'id')::uuid = v_sup)
    AND (v_json -> 'countries') ? ('Testland ' || v_tag) AND (v_json -> 'countries') ? ('Otherland ' || v_tag));

  -- ---------- Part 3: below cost
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := smart_below_cost(jsonb_build_array(
    jsonb_build_object('product_id', v_pa, 'variant_id', NULL, 'sold_unit', NULL, 'price', 50, 'quantity', 2),
    jsonb_build_object('product_id', v_pb, 'variant_id', NULL, 'sold_unit', NULL, 'price', 450, 'quantity', 1),
    jsonb_build_object('product_id', v_pd, 'variant_id', NULL, 'sold_unit', NULL, 'price', 150, 'quantity', 1),
    jsonb_build_object('product_id', v_pd, 'variant_id', NULL, 'sold_unit', 'pcs', 'price', 15, 'quantity', 4),
    jsonb_build_object('product_id', v_pd, 'variant_id', NULL, 'sold_unit', 'pcs', 'price', 25, 'quantity', 4),
    jsonb_build_object('product_id', gen_random_uuid(), 'variant_id', NULL, 'sold_unit', NULL, 'price', 1, 'quantity', 1),
    jsonb_build_object('product_id', v_pa, 'variant_id', NULL, 'sold_unit', NULL, 'price', 100, 'quantity', 1)));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Below cost: cream at ৳50 against the next lot''s ৳100 — below, cost ৳100, loss ৳100 for 2',
    (v_json -> 0 ->> 'below')::boolean AND (v_json -> 0 ->> 'cost')::numeric = 100 AND (v_json -> 0 ->> 'loss')::numeric = 100, v_json ->> 0);
  PERFORM pg_temp.ck('Below cost: serum at ৳450 is not below (cost ৳50)',
    NOT (v_json -> 1 ->> 'below')::boolean AND (v_json -> 1 ->> 'loss') IS NULL, v_json ->> 1);
  PERFORM pg_temp.ck('Below cost: a pack of 10 drops costs ৳200 (৳20 a unit) — ৳150 is below',
    (v_json -> 2 ->> 'below')::boolean AND (v_json -> 2 ->> 'cost')::numeric = 200, v_json ->> 2);
  PERFORM pg_temp.ck('Below cost: loose drops — ৳15 a unit is below ৳20 (loss ৳20 for 4), ৳25 is not',
    (v_json -> 3 ->> 'below')::boolean AND (v_json -> 3 ->> 'cost')::numeric = 20 AND (v_json -> 3 ->> 'loss')::numeric = 20
    AND NOT (v_json -> 4 ->> 'below')::boolean, format('%s | %s', v_json -> 3, v_json -> 4));
  PERFORM pg_temp.ck('Below cost: a product never bought gives no warning', NOT (v_json -> 5 ->> 'below')::boolean AND v_json -> 5 ->> 'cost' IS NULL, v_json ->> 5);
  PERFORM pg_temp.ck('Below cost: exactly at cost is not below', NOT (v_json -> 6 ->> 'below')::boolean, v_json ->> 6);

  -- Staff who may only create orders: below = yes / no, never taka.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  UPDATE profiles SET role = 'moderator', status = 'approved' WHERE id = v_cust;
  INSERT INTO staff_members (id, username, full_name, permissions, is_disabled)
  VALUES (v_cust, 'e2e.b43.staff.' || v_tag, 'E2E B43 staff', ARRAY['create_orders'], false)
  ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions, role_id = NULL, is_disabled = false;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := smart_below_cost(jsonb_build_array(
    jsonb_build_object('product_id', v_pa, 'variant_id', NULL, 'sold_unit', NULL, 'price', 50, 'quantity', 2)));
  BEGIN PERFORM smart_offer_rows(); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  BEGIN PERFORM report_investor_statement(gen_random_uuid(), v_today, v_today); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Below cost: staff with "Create manual orders" see "below" but no cost and no loss',
    (v_json -> 0 ->> 'below')::boolean AND v_json -> 0 -> 'cost' = 'null'::jsonb AND v_json -> 0 -> 'loss' = 'null'::jsonb, v_json::text);
  PERFORM pg_temp.ck('Permissions: that staff member cannot open Give an offer or the investor report',
    v_err = 'Not authorized.' AND v_txt = 'Not authorized.', format('%s | %s', v_err, v_txt));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  UPDATE staff_members SET permissions = ARRAY['edit_orders'] WHERE id = v_cust;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN v_json := smart_below_cost(jsonb_build_array(
    jsonb_build_object('product_id', v_pa, 'variant_id', NULL, 'sold_unit', NULL, 'price', 50, 'quantity', 2))); v_err := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Below cost: staff with "Edit orders" get the warning too (no taka)',
    v_err = 'allowed' AND (v_json -> 0 ->> 'below')::boolean AND v_json -> 0 -> 'cost' = 'null'::jsonb, v_err);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  UPDATE staff_members SET permissions = ARRAY['create_orders', 'view_profit_costs'] WHERE id = v_cust;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := smart_below_cost(jsonb_build_array(
    jsonb_build_object('product_id', v_pa, 'variant_id', NULL, 'sold_unit', NULL, 'price', 50, 'quantity', 2)));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Below cost: staff with "View profit & costs" also see the cost and the loss',
    (v_json -> 0 ->> 'cost')::numeric = 100 AND (v_json -> 0 ->> 'loss')::numeric = 100, v_json::text);

  -- ---------- Part 4: the investor report
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_inv := money_save_party(NULL, 'E2E B43 Investor ' || v_tag, '', 'investor');
  PERFORM money_add_entry('investor_in', 10000, v_cash, v_start + 1, 'e2e b43 capital', NULL, v_inv);
  PERFORM money_add_entry('investor_profit_share', 500, v_cash, v_today, 'e2e b43 share', NULL, v_inv);
  PERFORM money_add_entry('investor_capital_back', 1000, v_cash, v_today, 'e2e b43 back', NULL, v_inv);
  PERFORM admin_set_order_status((SELECT id FROM orders WHERE customer_phone = '01799943041' ORDER BY created_at DESC LIMIT 1), 'delivered', 'e2e');
  v_json := report_investor_statement(v_inv, v_mfrom, v_today);
  v_sum := money_summary(v_mfrom, v_today);
  v_rep := report_investors(v_mfrom, v_today);
  v_parts := money_profit_parts(v_mfrom, v_today);
  BEGIN PERFORM report_investor_statement(gen_random_uuid(), v_mfrom, v_today); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  BEGIN PERFORM report_investor_statement(v_inv, v_today, v_mfrom - 1); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Investor report: sales, net profit and return % equal money_summary for the same dates (the Money page)',
    (v_json ->> 'sales')::numeric = (v_sum -> 'profit' ->> 'sales')::numeric
    AND (v_json ->> 'net_profit')::numeric = (v_sum -> 'profit' ->> 'net_profit')::numeric
    AND (v_json -> 'roi_percent') IS NOT DISTINCT FROM (v_sum -> 'roi' -> 'percent')
    AND (v_json ->> 'sales')::numeric = 2 * 1000 + 3 * 450,
    format('%s / %s / %s', v_json ->> 'sales', v_json ->> 'net_profit', v_json ->> 'roi_percent'));
  SELECT r INTO v_row FROM jsonb_array_elements(v_rep) r WHERE (r ->> 'id')::uuid = v_inv;
  PERFORM pg_temp.ck('Investor report: the investor''s row equals Reports → Investors',
    v_json -> 'investor' = v_row, format('%s | %s', v_json -> 'investor', v_row));
  PERFORM pg_temp.ck('Investor report: capital in ৳10,000, returned ৳1,000, still owed ৳9,000, profit share ৳500 in the period',
    (v_row ->> 'capital_in')::numeric = 10000 AND (v_row ->> 'capital_back')::numeric = 1000
    AND (v_row ->> 'owed')::numeric = 9000 AND (v_row ->> 'share_range')::numeric = 500, v_row::text);
  PERFORM pg_temp.ck('Investor report: one row per month of the year so far; this month equals money_profit_parts',
    jsonb_array_length(v_json -> 'months') = extract(month FROM v_today)::int
    AND (v_json -> 'months' -> -1 ->> 'net_profit')::numeric = (v_parts ->> 'net_profit')::numeric
    AND (v_json -> 'months' -> -1 ->> 'sales')::numeric = (v_parts ->> 'sales')::numeric,
    format('%s months', jsonb_array_length(v_json -> 'months')));
  PERFORM pg_temp.ck('Investor report: an unknown investor is refused', v_err = 'Investor not found.', v_err);
  PERFORM pg_temp.ck('Investor report: wrong dates are refused like every report', v_txt <> 'allowed', v_txt);
  PERFORM pg_temp.ck('Investor report: no product costs and no customer names in it',
    position('E2E B43 One' IN v_json::text) = 0 AND position('E2E B43 Cream' IN v_json::text) = 0, '');
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
