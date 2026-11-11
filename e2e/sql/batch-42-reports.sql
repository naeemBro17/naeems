-- Batch 42 database tests (run by e2e/batch-42.spec.ts through the Supabase
-- command line). Everything happens inside ONE transaction that is always
-- rolled back at the end, so every change below is undone: the opening
-- balances, the test products, lots, orders, payments, expenses, stock
-- counts and the month lock never exist outside this script, and Inventory
-- mode is on only for this transaction (inventory.test_mode).
--
-- One shared set of test data; then every report total is compared with the
-- Batch 39 / 41 functions for the same dates (they must agree exactly), the
-- monthly count is checked, and the month lock is tried against every kind
-- of record.
--
-- The books start on the 1st of the month 3 years ago (a month with no real
-- orders or payouts in it), so the month lock can be tried on that month.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
BEGIN;
DO $test$
DECLARE
  v_admin    uuid;
  v_cust     uuid;
  c_admin    text;
  c_nopw     text;
  c_cust     text;
  v_err      text;
  v_txt      text;
  v_pa       uuid;
  v_pb       uuid;
  v_l0       uuid;
  v_l1       uuid;
  v_cash     uuid;
  v_ads      uuid;
  v_food     uuid;
  v_o1       uuid;
  v_o2       uuid;
  v_o3       uuid;
  v_o5       uuid;
  v_pay1     uuid;
  v_exp1     uuid;
  v_json     jsonb;
  v_sum      jsonb;
  v_parts    jsonb;
  v_rep      jsonb;
  v_pos      jsonb;
  v_sp       jsonb;
  v_num      numeric;
  v_num2     numeric;
  v_int      integer;
  v_ok       boolean;
  v_key      text;
  v_today    date := (now() AT TIME ZONE 'Asia/Dhaka')::date;
  v_start    date := date_trunc('month', (now() AT TIME ZONE 'Asia/Dhaka')::date - interval '3 years')::date;
  v_start_ts timestamptz;
  v_month    date;
  v_mfrom    date := date_trunc('month', (now() AT TIME ZONE 'Asia/Dhaka')::date)::date;
  v_tag      text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_ph1      text := '01799942041';
  v_ph2      text := '01799942042';
  v_ph3      text := '01799942043';
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  v_start_ts := (v_start::timestamp AT TIME ZONE 'Asia/Dhaka');
  v_month := v_start;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  IF EXISTS (SELECT 1 FROM lots WHERE kind = 'opening') OR EXISTS (SELECT 1 FROM money_books WHERE confirmed_at IS NOT NULL) THEN
    PERFORM pg_temp.ck('Real opening stock or opening balances exist — these tests run only before them', true, 'skipped');
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM money_month_locks) THEN
    PERFORM pg_temp.ck('A real month lock exists — these tests run only before the first one', true, 'skipped');
    RETURN;
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_nopw := json_build_object('sub', v_admin, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint - 3600)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;

  SELECT id INTO v_cash FROM money_accounts WHERE payment_method = 'cash';
  SELECT id INTO v_ads FROM money_categories WHERE name = 'Ads';
  SELECT id INTO v_food FROM money_categories WHERE name = 'Food';

  -- ---------- Permissions first (nothing exists yet)
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_int := 0;
  BEGIN PERFORM money_dashboard(v_today, v_today, NULL, NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM report_profit_loss(v_today, v_today); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM report_sales(v_today, v_today); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM report_products(v_today, v_today); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM report_lots(); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM report_stock(); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM report_customers(v_today, v_today); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM report_day_book(v_today, v_today); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM report_investors(v_today, v_today); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM report_charts(); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM stock_count_pick(NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM stock_count_save('[]'::jsonb); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM money_lock_checklist(v_start); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  BEGIN PERFORM money_lock_month(v_start); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Not authorized.' THEN v_int := v_int + 1; END IF; END;
  SELECT count(*) INTO v_num FROM money_month_locks;
  SELECT v_num + count(*) INTO v_num FROM stock_counts;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: a customer gets "Not authorized." from the Dashboard, all 10 reports, the count and the lock (14 of 14)',
    v_int = 14, v_int::text);
  PERFORM pg_temp.ck('Permissions: a customer reads no lock or count rows', v_num = 0, v_num::text);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN PERFORM report_profit_loss(v_today, v_today); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: the public cannot call a report at all', v_err LIKE 'permission denied%', v_err);

  -- ---------- One shared set of test data
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B42-A-' || v_tag, 'e2e-b42-a-' || v_tag, 'E2E B42 Cream', 300, 'in_stock', 0, true) RETURNING id INTO v_pa;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B42-B-' || v_tag, 'e2e-b42-b-' || v_tag, 'E2E B42 Serum', 500, 'in_stock', 0, true) RETURNING id INTO v_pb;

  PERFORM set_config('inventory.test_mode', 'on', true);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  -- Opening stock L-000 on the start date: 10 creams at ৳100, 20 serums at ৳50.
  v_l0 := inventory_confirm_opening(v_start, 0, jsonb_build_array(
    jsonb_build_object('product_id', v_pa, 'source', 'import', 'buy_price_bdt', '100', 'pieces', 10, 'expiry', to_char(v_today + 60, 'YYYY-MM-DD')),
    jsonb_build_object('product_id', v_pb, 'source', 'import', 'buy_price_bdt', '50', 'pieces', 20, 'expiry', '2030-06-01')),
    'e2e-b42.xlsx');
  PERFORM money_confirm_opening(v_start, jsonb_build_array(jsonb_build_object('account_id', v_cash, 'amount', 5000)),
                                '[]'::jsonb, '[]'::jsonb);
  -- L-001 today: 5 more serums at ৳60 (the newest lot of the serum).
  v_l1 := inventory_save_lot(jsonb_build_object('source_type', 'wholesale', 'lot_date', v_today::text, 'costs_pending', false,
    'notes', 'e2e b42', 'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pb, 'qty', 5, 'unit_price_foreign', '60', 'expiry_date', '2031-01-01')),
    'costs', '[]'::jsonb));
  -- Expenses: ৳500 Ads in the start month, ৳300 Food today.
  v_exp1 := ((money_add_entry('expense', 500, v_cash, v_start + 2, 'e2e b42 ads', v_ads) -> 'ids') ->> 0)::uuid;
  PERFORM money_add_entry('expense', 300, v_cash, v_today, 'e2e b42 food', v_food);
  -- o1: 2 creams, placed and delivered in the start month, paid in cash then.
  SELECT order_id INTO v_o1 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 2)),
    p_full_name => 'E2E B42 One', p_phone => v_ph1, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  PERFORM admin_set_order_status(v_o1, 'delivered', 'e2e');
  -- o2: 1 serum, placed and delivered today, not paid.
  SELECT order_id INTO v_o2 FROM admin_create_order_v2(
    p_source => 'facebook', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pb, 'quantity', 1)),
    p_full_name => 'E2E B42 Two', p_phone => v_ph2, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  PERFORM admin_set_order_status(v_o2, 'delivered', 'e2e');
  -- o3: 1 cream, placed 45 days ago, delivered today, not paid.
  SELECT order_id INTO v_o3 FROM admin_create_order_v2(
    p_source => 'whatsapp', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'E2E B42 Three', p_phone => v_ph3, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  PERFORM admin_set_order_status(v_o3, 'delivered', 'e2e');
  EXECUTE 'RESET ROLE';
  -- Move o1 into the start month (placed, delivered) and o3 to 45 days ago.
  UPDATE orders SET created_at = v_start_ts + interval '3 days 10 hours' WHERE id = v_o1;
  UPDATE order_status_history SET changed_at = v_start_ts + interval '4 days 10 hours' WHERE order_id = v_o1;
  UPDATE orders SET created_at = now() - interval '45 days' WHERE id = v_o3;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_pay1 := admin_add_order_payment(v_o1, 680, 'cash', NULL, v_start_ts + interval '4 days 12 hours', 'e2e b42');
  v_sum := money_summary(v_start, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Setup: books balance with the shared test data', (v_sum -> 'position' ->> 'balanced')::boolean,
    v_sum -> 'position' ->> 'difference');

  -- ---------- Every report agrees with the Batch 39 / 41 functions
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_parts := money_profit_parts(v_start, v_today);
  v_rep := report_profit_loss(v_start, v_today);
  v_pos := money_summary(v_start, v_today) -> 'position';
  v_sp := inventory_sales_profit(v_start, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('P&L: every line equals money_profit_parts for the same dates',
    (SELECT bool_and((v_rep -> 'parts' -> k) = (v_parts -> k)) FROM jsonb_object_keys(v_parts) k),
    format('%s | %s', v_rep -> 'parts', v_parts));
  PERFORM pg_temp.ck('P&L: gross profit = sales − cost of goods',
    (v_rep -> 'parts' ->> 'gross_profit')::numeric = (v_parts ->> 'sales')::numeric - (v_parts ->> 'cost')::numeric);
  PERFORM pg_temp.ck('P&L: expenses by category add up to the expenses line (৳800: Ads ৳500 + Food ৳300)',
    (SELECT sum((c ->> 'amount')::numeric) FROM jsonb_array_elements(v_rep -> 'expenses_by_category') c) = (v_parts ->> 'expenses')::numeric
    AND (v_parts ->> 'expenses')::numeric = 800, v_rep ->> 'expenses_by_category');
  PERFORM pg_temp.ck('P&L: one column per month (37 months), and the months add up to the total — net profit, sales, expenses',
    jsonb_array_length(v_rep -> 'months') = 37
    AND (SELECT sum((m ->> 'net_profit')::numeric) FROM jsonb_array_elements(v_rep -> 'months') m) = (v_parts ->> 'net_profit')::numeric
    AND (SELECT sum((m ->> 'sales')::numeric) FROM jsonb_array_elements(v_rep -> 'months') m) = (v_parts ->> 'sales')::numeric
    AND (SELECT sum((m ->> 'expenses')::numeric) FROM jsonb_array_elements(v_rep -> 'months') m) = (v_parts ->> 'expenses')::numeric,
    format('%s months', jsonb_array_length(v_rep -> 'months')));
  PERFORM pg_temp.ck('P&L: the start month has o1 (sales ৳600, cost ৳200) and the ৳500 Ads',
    (v_rep -> 'months' -> 0 ->> 'sales')::numeric = 600 AND (v_rep -> 'months' -> 0 ->> 'cost')::numeric = 200
    AND (v_rep -> 'months' -> 0 ->> 'expenses')::numeric = 500, v_rep -> 'months' -> 0 ->> 'month');

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := money_dashboard(v_mfrom, v_today, (v_mfrom - interval '1 month')::date, (v_mfrom - 1));
  v_sum := money_summary(v_mfrom, v_today);
  v_parts := money_profit_parts((v_mfrom - interval '1 month')::date, (v_mfrom - 1));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Dashboard: profit, return on money and money now are exactly the Money page''s (money_summary)',
    (v_json -> 'summary' -> 'profit') = (v_sum -> 'profit') AND (v_json -> 'summary' -> 'roi') = (v_sum -> 'roi')
    AND (v_json -> 'summary' -> 'position' -> 'accounts') = (v_sum -> 'position' -> 'accounts')
    AND (v_json -> 'summary' -> 'position' ->> 'net_worth') = (v_sum -> 'position' ->> 'net_worth')
    AND (v_json -> 'summary' -> 'position' ->> 'balanced') = (v_sum -> 'position' ->> 'balanced'));
  PERFORM pg_temp.ck('Dashboard: the previous period''s Your profit is money_profit_parts for it',
    (v_json -> 'previous' ->> 'your_profit')::numeric = (v_parts ->> 'your_profit')::numeric, v_json ->> 'previous');
  PERFORM pg_temp.ck('Dashboard: "expiring before they sell" finds the cream (expires in 60 days, no speed)',
    (v_json -> 'attention' ->> 'expiring')::int >= 1, v_json ->> 'attention');

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_rep := report_charts();
  v_parts := money_profit_parts(v_mfrom, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Charts: 12 months; this month''s Your profit and Net profit are money_profit_parts for it',
    jsonb_array_length(v_rep -> 'months') = 12
    AND (v_rep -> 'months' -> 11 ->> 'your_profit')::numeric = (v_parts ->> 'your_profit')::numeric
    AND (v_rep -> 'months' -> 11 ->> 'net_profit')::numeric = (v_parts ->> 'net_profit')::numeric, v_rep -> 'months' ->> 11);

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_rep := report_products(v_start, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Products: the table is inventory_sales_profit''s own per-product table; sales add up to its total',
    (v_rep -> 'sold') = (v_sp -> 'products')
    AND (SELECT sum((p ->> 'sales')::numeric) FROM jsonb_array_elements(v_rep -> 'sold') p) = (v_sp -> 'totals' ->> 'sales')::numeric);
  PERFORM pg_temp.ck('Products: the cream sold 3, the serum 1; stock left 7 and 24',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_rep -> 'sold') p WHERE (p ->> 'product_id')::uuid = v_pa AND (p ->> 'units')::int = 3)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_rep -> 'units') u WHERE (u ->> 'product_id')::uuid = v_pa AND (u ->> 'units_left')::int = 7)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_rep -> 'units') u WHERE (u ->> 'product_id')::uuid = v_pb AND (u ->> 'units_left')::int = 24));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_rep := report_lots();
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Lots: the lots'' sales and cost of sold units add up to Sales profit''s totals (all costed orders)',
    (SELECT sum((l ->> 'sales')::numeric) FROM jsonb_array_elements(v_rep) l) = (v_sp -> 'totals' ->> 'sales')::numeric
    AND (SELECT sum((l ->> 'cost_sold')::numeric) FROM jsonb_array_elements(v_rep) l) = (v_sp -> 'totals' ->> 'cost')::numeric,
    format('%s / %s', (SELECT sum((l ->> 'sales')::numeric) FROM jsonb_array_elements(v_rep) l), v_sp -> 'totals' ->> 'sales'));
  PERFORM pg_temp.ck('Lots: L-000 bought 30, sold 4 (3 creams + 1 serum), left 26; L-001 bought 5, left 5',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_rep) l WHERE (l ->> 'lot_id')::uuid = v_l0
            AND (l ->> 'units_bought')::int = 30 AND (l ->> 'units_sold')::int = 4 AND (l ->> 'units_left')::int = 26)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_rep) l WHERE (l ->> 'lot_id')::uuid = v_l1
            AND (l ->> 'units_bought')::int = 5 AND (l ->> 'units_left')::int = 5), v_rep::text);

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_rep := report_stock();
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Stock: the value at landed cost equals the Money page''s stock value',
    (v_rep ->> 'total_value')::numeric = (v_pos ->> 'stock_value')::numeric
    AND (SELECT sum((r ->> 'value')::numeric) FROM jsonb_array_elements(v_rep -> 'rows') r) = (v_pos ->> 'stock_value')::numeric,
    format('%s / %s', v_rep ->> 'total_value', v_pos ->> 'stock_value'));
  PERFORM pg_temp.ck('Stock: the cream (7 left, expires in 60 days, sold 1 in 90 days) will NOT sell in time',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_rep -> 'rows') r WHERE (r ->> 'product_id')::uuid = v_pa
            AND (r ->> 'sells_in_time')::boolean = false));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_rep := report_customers(v_start, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Customers: the dues add up to the Money page''s To receive (orders + previous balances)',
    COALESCE((SELECT sum((d ->> 'total')::numeric) FROM jsonb_array_elements(v_rep -> 'dues') d), 0)
      = (v_pos ->> 'to_receive')::numeric + (v_pos ->> 'previous_balances')::numeric,
    format('%s / %s', (SELECT sum((d ->> 'total')::numeric) FROM jsonb_array_elements(v_rep -> 'dues') d), v_pos ->> 'to_receive'));
  PERFORM pg_temp.ck('Customers: each customer''s 0–30 + 31–60 + 60+ = their total',
    (SELECT bool_and((d ->> 'd0')::numeric + (d ->> 'd31')::numeric + (d ->> 'd61')::numeric = (d ->> 'total')::numeric)
     FROM jsonb_array_elements(v_rep -> 'dues') d));
  PERFORM pg_temp.ck('Customers: o2 (today, ৳580) is 0–30 days; o3 (45 days ago, ৳380) is 31–60 days',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_rep -> 'dues') d WHERE d ->> 'phone' LIKE '%' || substr(v_ph2, 2) AND (d ->> 'd0')::numeric = 580)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_rep -> 'dues') d WHERE d ->> 'phone' LIKE '%' || substr(v_ph3, 2)
                AND (d ->> 'd31')::numeric = 380 AND (d ->> 'oldest_days')::int = 45), v_rep ->> 'dues');
  PERFORM pg_temp.ck('Customers: top customers are the Sales profit orders (bought = its sales, profit = its profit)',
    (SELECT sum((t ->> 'bought')::numeric) FROM jsonb_array_elements(v_rep -> 'top') t)
      = (SELECT sum((o ->> 'sale')::numeric) FROM jsonb_array_elements(v_sp -> 'orders') o)
    AND (SELECT sum((t ->> 'profit')::numeric) FROM jsonb_array_elements(v_rep -> 'top') t)
      = (SELECT sum((o ->> 'profit')::numeric) FROM jsonb_array_elements(v_sp -> 'orders') o WHERE (o ->> 'costed')::boolean));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_rep := report_day_book(v_start, v_today);
  SELECT balance INTO v_num FROM money_account_balances() WHERE account_id = v_cash;
  -- Real cash payments since the (test) start date are in Cash too.
  SELECT COALESCE(sum(amount), 0) INTO v_num2 FROM money_ledger
  WHERE account_id = v_cash AND NOT (source = 'payment' AND source_id = v_pay1::text)
    AND NOT (source = 'movement' AND source_id IN (SELECT id::text FROM money_movements WHERE type = 'opening_balance' OR note LIKE 'e2e b42%'));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Day book: Cash closes at the account balance; the last running balance is the same',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_rep -> 'accounts') a WHERE (a ->> 'account_id')::uuid = v_cash
            AND (a ->> 'closing')::numeric = v_num
            AND (a -> 'lines' -> (jsonb_array_length(a -> 'lines') - 1) ->> 'balance')::numeric = v_num), v_num::text);
  PERFORM pg_temp.ck('Day book: Cash = ৳5,000 opening − ৳500 − ৳300 + ৳680 = ৳4,880 (plus the real cash payments since the test start date)',
    v_num - v_num2 = 4880, format('%s − %s real', v_num, v_num2));
  PERFORM pg_temp.ck('Day book: every account closes at its balance',
    (SELECT bool_and((a ->> 'closing')::numeric = b.balance) FROM jsonb_array_elements(v_rep -> 'accounts') a
     JOIN money_account_balances() b ON b.account_id = (a ->> 'account_id')::uuid));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_rep := report_sales(v_start, (v_start + interval '1 month - 1 day')::date);
  v_json := report_investors(v_start, v_today);
  SELECT count(*) INTO v_int FROM money_to_give_rows() WHERE kind = 'investor';
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Sales: the start month has 1 entry (o1, ৳680), received ৳680, unpaid ৳0, source Phone',
    (v_rep -> 'totals' ->> 'entries')::int = 1 AND (v_rep -> 'totals' ->> 'total')::numeric = 680
    AND (v_rep -> 'totals' ->> 'received')::numeric = 680 AND (v_rep -> 'totals' ->> 'unpaid')::numeric = 0
    AND v_rep -> 'by_source' -> 0 ->> 'source' = 'phone', v_rep ->> 'totals');
  PERFORM pg_temp.ck('Investors: one row per investor of the Investors page', jsonb_array_length(v_json) = v_int);

  -- ---------- Monthly stock count
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := stock_count_pick(NULL);
  v_txt := (SELECT string_agg(r ->> 'why', ',' ORDER BY r ->> 'why') FROM jsonb_array_elements(v_json -> 'rows') r
             WHERE (r ->> 'product_id')::uuid IN (v_pa, v_pb));
  v_sum := money_summary(v_today, v_today);
  v_json := stock_count_save(jsonb_build_array(
    jsonb_build_object('product_id', v_pa, 'variant_id', NULL, 'counted', 6),
    jsonb_build_object('product_id', v_pb, 'variant_id', NULL, 'counted', 26)));
  v_parts := money_profit_parts(v_today, v_today);
  v_pos := money_summary(v_today, v_today);
  v_rep := stock_count_pick(NULL);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Count: both test products are on this month''s list (never counted, or expensive / fast)',
    v_txt IN ('fast,never', 'never,value', 'never,never', 'fast,value', 'fast,fast', 'value,value'), v_txt);
  PERFORM pg_temp.ck('Count: cream system 7, counted 6 → a ৳100 write-off "Count difference"',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) r WHERE (r ->> 'product_id')::uuid = v_pa
            AND (r ->> 'system_units')::int = 7 AND (r ->> 'difference')::int = -1)
    AND EXISTS (SELECT 1 FROM stock_write_offs w WHERE w.product_id = v_pa AND w.reason = 'count_difference' AND w.units = 1
                AND w.cost_bdt = 100 AND NOT w.added_back), v_json::text);
  PERFORM pg_temp.ck('Count: serum system 24, counted 26 → 2 added back to the newest lot (L-001), a −৳120 row',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) r WHERE (r ->> 'product_id')::uuid = v_pb AND (r ->> 'difference')::int = 2)
    AND (SELECT qty_remaining FROM lot_items WHERE lot_id = v_l1) = 7
    AND EXISTS (SELECT 1 FROM stock_write_offs w WHERE w.product_id = v_pb AND w.added_back AND w.units = 2 AND w.cost_bdt = -120),
    (SELECT qty_remaining::text FROM lot_items WHERE lot_id = v_l1));
  PERFORM pg_temp.ck('Count: profit "Stock removed (write-offs)" is the net ৳100 − ৳120 = −৳20; books still balance',
    (v_parts ->> 'write_offs')::numeric = -20 AND (v_pos -> 'position' ->> 'balanced')::boolean,
    format('%s · %s', v_parts ->> 'write_offs', v_pos -> 'position' ->> 'difference'));
  PERFORM pg_temp.ck('Count: the month''s list now shows both counted', (SELECT bool_and((r ->> 'counted')::boolean) AND count(*) = 2
    FROM jsonb_array_elements(v_rep -> 'rows') r WHERE (r ->> 'product_id')::uuid IN (v_pa, v_pb)));
  PERFORM pg_temp.ck('Count: the pick rule — 150 products → 20 a month, 90 → 15, 2 → 2',
    LEAST(150, LEAST(20, GREATEST(15, ceil(150 / 6.0)::int))) = 20 AND LEAST(90, LEAST(20, GREATEST(15, ceil(90 / 6.0)::int))) = 15
    AND LEAST(2, LEAST(20, GREATEST(15, ceil(2 / 6.0)::int))) = 2);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM stock_count_save(jsonb_build_array(jsonb_build_object('product_id', v_pa, 'counted', -1))); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Count: a count below 0 is refused', v_err LIKE 'Type what you counted%', v_err);
  PERFORM set_config('inventory.test_mode', '', true);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM stock_count_save(jsonb_build_array(jsonb_build_object('product_id', v_pa, 'counted', 6))); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('inventory.test_mode', 'on', true);
  PERFORM pg_temp.ck('Count: while Inventory mode is Off it explains why', v_err LIKE 'The stock count works only while Inventory mode is On%', v_err);

  -- ---------- Month lock: the checklist
  -- A throwaway open order placed in the start month blocks the lock.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o5 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pb, 'quantity', 1)),
    p_full_name => 'E2E B42 Five', p_phone => v_ph2, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  EXECUTE 'RESET ROLE';
  UPDATE orders SET created_at = v_start_ts + interval '20 days' WHERE id = v_o5;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := money_lock_checklist(v_month);
  BEGIN PERFORM money_lock_month(v_month); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  BEGIN PERFORM money_lock_month(v_mfrom); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  PERFORM admin_set_order_status(v_o5, 'cancelled', 'e2e');
  v_rep := money_lock_checklist(v_month);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Checklist: an order from that month still To confirm is a red line; the month can''t be locked',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_json -> 'items') i WHERE i ->> 'key' = 'orders' AND NOT (i ->> 'ok')::boolean)
    AND NOT (v_json ->> 'ready')::boolean AND v_err LIKE 'Not ready to lock%No orders still processing%', v_err);
  PERFORM pg_temp.ck('Checklist: this month can''t be locked (not over)', v_txt LIKE 'Not ready to lock%The month is over%', v_txt);
  PERFORM pg_temp.ck('Checklist: books balance ✓, no orders processing ✓, payouts ✓, count ✓ → ready',
    (v_rep ->> 'ready')::boolean AND (SELECT bool_and((i ->> 'ok')::boolean) FROM jsonb_array_elements(v_rep -> 'items') i)
    AND jsonb_array_length(v_rep -> 'items') = 5, v_rep ->> 'items');

  -- ---------- Lock: password, then lock
  PERFORM set_config('request.jwt.claims', c_nopw, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM money_lock_month(v_month); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Lock: needs the password typed again (within 5 minutes)', v_err = 'Please confirm your password again.', v_err);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := money_lock_month(v_month);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Lock: locked and written to the Activity Log',
    (v_json ->> 'locked')::boolean AND money_month_locked(v_start + 10)
    AND EXISTS (SELECT 1 FROM activity_log WHERE action = 'money.lock_month' AND entity_id = v_month::text));

  -- ---------- After the lock nothing dated in the month can change
  v_int := 0;
  v_txt := '';
  -- Money entry: add, change, delete.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM money_add_entry('expense', 50, v_cash, v_start + 5, 'e2e b42 late', v_ads); v_txt := v_txt || ' add-entry:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' add-entry:' || SQLERRM; END IF; END;
  BEGIN PERFORM money_delete_entry(v_exp1, 500); v_txt := v_txt || ' delete-entry:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' delete-entry:' || SQLERRM; END IF; END;
  -- Payment dated in the month: add, and delete the old one.
  BEGIN PERFORM admin_add_order_payment(v_o2, 10, 'cash', NULL, v_start_ts + interval '6 days', 'e2e b42 late'); v_txt := v_txt || ' add-payment:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' add-payment:' || SQLERRM; END IF; END;
  EXECUTE 'RESET ROLE';
  BEGIN UPDATE money_movements SET amount = -600 WHERE id = v_exp1; v_txt := v_txt || ' edit-entry:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' edit-entry:' || SQLERRM; END IF; END;
  BEGIN DELETE FROM order_payments WHERE id = v_pay1; v_txt := v_txt || ' delete-payment:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' delete-payment:' || SQLERRM; END IF; END;
  -- Orders: change the money, change the items, delete.
  BEGIN UPDATE orders SET discount = discount + 1, total = total - 1 WHERE id = v_o1; v_txt := v_txt || ' edit-order:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' edit-order:' || SQLERRM; END IF; END;
  BEGIN UPDATE orders SET status = 'returned' WHERE id = v_o1; v_txt := v_txt || ' return-order:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' return-order:' || SQLERRM; END IF; END;
  BEGIN UPDATE order_items SET quantity = quantity + 1, line_total = line_total + 300 WHERE order_id = v_o1; v_txt := v_txt || ' edit-items:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' edit-items:' || SQLERRM; END IF; END;
  BEGIN DELETE FROM orders WHERE id = v_o1; v_txt := v_txt || ' delete-order:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' delete-order:' || SQLERRM; END IF; END;
  BEGIN INSERT INTO orders (order_number, customer_name, customer_phone, division, district, thana, address_line, delivery_zone,
                            delivery_fee, subtotal, discount, total, payment_method, status, source, created_at)
        VALUES ('E2E-B42-' || v_tag, 'E2E B42 Late', v_ph1, 'Dhaka', 'Dhaka', 'Gulshan', 'Test road', 'inside_dhaka',
                80, 300, 0, 380, 'cod', 'delivered', 'phone', v_start_ts + interval '8 days');
        v_txt := v_txt || ' add-order:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' add-order:' || SQLERRM; END IF; END;
  -- Lots: the lot date, a row's expiry, its bills.
  BEGIN UPDATE lots SET lot_date = lot_date + 1 WHERE id = v_l0; v_txt := v_txt || ' edit-lot:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' edit-lot:' || SQLERRM; END IF; END;
  BEGIN UPDATE lot_items SET expiry_date = '2031-01-01' WHERE lot_id = v_l0; v_txt := v_txt || ' edit-lot-row:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' edit-lot-row:' || SQLERRM; END IF; END;
  BEGIN INSERT INTO lot_costs (lot_id, cost_type, amount_bdt) VALUES (v_l0, 'other', 10); v_txt := v_txt || ' lot-bill:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' lot-bill:' || SQLERRM; END IF; END;
  BEGIN DELETE FROM lots WHERE id = v_l0; v_txt := v_txt || ' delete-lot:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' delete-lot:' || SQLERRM; END IF; END;
  -- Write-offs and cost adjustments dated in the month.
  BEGIN INSERT INTO stock_write_offs (write_date, product_id, label, units, reason, cost_bdt) VALUES (v_start + 9, v_pa, 'late', 1, 'lost', 100);
        v_txt := v_txt || ' add-write-off:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' add-write-off:' || SQLERRM; END IF; END;
  BEGIN INSERT INTO cost_adjustments (adj_date, amount_bdt, reason) VALUES (v_start + 9, 10, 'late_bill'); v_txt := v_txt || ' add-adjustment:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' add-adjustment:' || SQLERRM; END IF; END;
  -- Opening balances (dated the start date).
  BEGIN UPDATE money_books SET opening_steadfast = COALESCE(opening_steadfast, 0) + 1 WHERE id = 1; v_txt := v_txt || ' edit-opening:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' edit-opening:' || SQLERRM; END IF; END;
  BEGIN UPDATE money_movements SET amount = amount + 1 WHERE type = 'opening_balance'; v_txt := v_txt || ' edit-opening-cash:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' edit-opening-cash:' || SQLERRM; END IF; END;
  BEGIN INSERT INTO money_opening_payables (supplier_id, amount) VALUES ((SELECT id FROM suppliers LIMIT 1), 5); v_txt := v_txt || ' add-opening-payable:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' add-opening-payable:' || SQLERRM; END IF; END;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_open_delete_lock(120);
  BEGIN PERFORM money_undo_opening('UNDO'); v_txt := v_txt || ' undo-opening:allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%is locked%' THEN v_int := v_int + 1; ELSE v_txt := v_txt || ' undo-opening:' || SQLERRM; END IF; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Lock: every kind of change dated in the locked month is refused (20 of 20: entries, payments, orders, items, lots, bills, write-offs, adjustments, opening balances)',
    v_int = 20, format('%s refused;%s', v_int, v_txt));
  BEGIN UPDATE orders SET discount = discount + 1, total = total - 1 WHERE id = v_o1; v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.ck('Lock: the message names the month and asks for a correction dated today',
    v_err LIKE '% is locked: % can''t be added, changed or deleted. Add a correction dated today with the note "correction for %".', v_err);

  -- What is NOT refused: notes, today's sales from the old lot, corrections.
  BEGIN UPDATE orders SET admin_note = 'e2e b42 note' WHERE id = v_o1; v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    SELECT order_id INTO v_o5 FROM admin_create_order_v2(
      p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
      p_full_name => 'E2E B42 Six', p_phone => v_ph1, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
      p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
    v_txt := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  BEGIN PERFORM money_add_entry('expense', 50, v_cash, v_today, 'correction for ' || to_char(v_month, 'FMMonth YYYY'), v_ads); v_key := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_key := SQLERRM; END;
  v_rep := report_profit_loss(v_start, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Lock: a note on an old order can still be changed', v_err = 'allowed', v_err);
  PERFORM pg_temp.ck('Lock: today''s order still takes stock from the locked month''s lot (L-000)', v_txt = 'allowed'
    AND EXISTS (SELECT 1 FROM order_item_lots x JOIN lot_items li ON li.id = x.lot_item_id WHERE x.order_id = v_o5 AND li.lot_id = v_l0), v_txt);
  PERFORM pg_temp.ck('Lock: a correction dated today works', v_key = 'allowed', v_key);
  PERFORM pg_temp.ck('Reports: the locked month is marked (P&L locked months and its month column)',
    v_rep -> 'locked_months' ? to_char(v_month, 'YYYY-MM-DD') AND (v_rep -> 'months' -> 0 ->> 'locked')::boolean, v_rep ->> 'locked_months');

  -- ---------- Unlock: the Super Admin only, with a reason, logged
  -- (the test customer becomes staff inside this transaction only)
  PERFORM set_config('request.jwt.claims', c_admin, true);
  UPDATE profiles SET role = 'moderator', status = 'approved' WHERE id = v_cust;
  INSERT INTO staff_members (id, username, full_name, permissions, is_disabled)
  VALUES (v_cust, 'e2e.b42.staff.' || v_tag, 'E2E B42 staff', ARRAY['view_profit_costs'], false)
  ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions, role_id = NULL, is_disabled = false;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM report_profit_loss(v_start, v_today); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  BEGIN PERFORM money_unlock_month(v_month, 'staff wants to change it'); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Staff with "View profit & costs" can open the reports', v_txt = 'allowed', v_txt);
  PERFORM pg_temp.ck('Unlock: refused for staff (only the Super Admin)', v_err = 'Only the Super Admin can unlock a month.', v_err);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM money_unlock_month(v_month, ''); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  v_json := money_unlock_month(v_month, 'e2e b42: fix a wrong expense');
  BEGIN PERFORM money_add_entry('expense', 50, v_cash, v_start + 5, 'e2e b42 after unlock', v_ads); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Unlock: needs a reason', v_err LIKE 'Write why you unlock it%', v_err);
  PERFORM pg_temp.ck('Unlock: unlocked, the reason is in the Activity Log',
    NOT (v_json ->> 'locked')::boolean AND v_json ->> 'unlock_reason' = 'e2e b42: fix a wrong expense'
    AND EXISTS (SELECT 1 FROM activity_log WHERE action = 'money.unlock_month' AND summary LIKE '%e2e b42: fix a wrong expense%'));
  PERFORM pg_temp.ck('Unlock: entries dated in the month can be added again', v_txt = 'allowed', v_txt);
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
