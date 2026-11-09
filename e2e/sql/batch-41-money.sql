-- Batch 41 database tests (run by e2e/batch-41.spec.ts through the Supabase
-- command line). Everything happens inside ONE transaction that is always
-- rolled back at the end (if anything fails half-way, the transaction is
-- aborted and rolled back too), so every change below is undone: the opening balances, the
-- test money entries, products, lots, orders and the Steadfast payout never
-- exist outside this script, and Inventory mode is on only for this
-- transaction (inventory.test_mode). The live books never see any of it.
--
-- The script acts as the real test accounts: {{ADMIN_EMAIL}} (the test
-- Super Admin) and {{CUSTOMER_EMAIL}} (the test customer).
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
  v_l0       uuid;
  v_lot      uuid;
  v_lot_code text;
  v_cash     uuid;
  v_bkash    uuid;
  v_bank     uuid;
  v_sf       uuid;
  v_ads      uuid;
  v_inv      uuid;
  v_sup      uuid;
  v_o0       uuid;
  v_o1       uuid;
  v_o2       uuid;
  v_o4       uuid;
  v_pay      uuid;
  v_payout   uuid;
  v_item     uuid;
  v_wo       uuid;
  v_dp       uuid;
  v_json     jsonb;
  v_sum      jsonb;
  v_before   jsonb;
  v_after    jsonb;
  v_num      numeric;
  v_num2     numeric;
  v_int      integer;
  v_ids      jsonb;
  v_today    date := (now() AT TIME ZONE 'Asia/Dhaka')::date;
  v_tag      text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_ph1      text := '01799941041';
  v_ph3      text := '01799941043';
  v_ph4      text := '01799941044';
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  -- One account's balance (as the admin sees it).
  EXECUTE $f$CREATE FUNCTION pg_temp.bal(p_account uuid) RETURNS numeric LANGUAGE sql AS '
    SELECT COALESCE(sum(amount), 0) FROM money_ledger WHERE account_id = p_account'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  IF EXISTS (SELECT 1 FROM lots WHERE kind = 'opening') OR EXISTS (SELECT 1 FROM money_books WHERE confirmed_at IS NOT NULL) THEN
    PERFORM pg_temp.ck('Real opening stock or opening balances exist — the money tests run only before them', true, 'skipped');
    RETURN;
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;

  SELECT id INTO v_cash FROM money_accounts WHERE payment_method = 'cash';
  SELECT id INTO v_bkash FROM money_accounts WHERE payment_method = 'bkash';
  SELECT id INTO v_bank FROM money_accounts WHERE payment_method = 'bank';
  SELECT id INTO v_sf FROM money_accounts WHERE kind = 'steadfast';
  SELECT id INTO v_ads FROM money_categories WHERE name = 'Ads';
  PERFORM pg_temp.ck('Setup: Cash, bKash, Bank, With Steadfast and the Ads category exist',
    v_cash IS NOT NULL AND v_bkash IS NOT NULL AND v_bank IS NOT NULL AND v_sf IS NOT NULL AND v_ads IS NOT NULL);
  PERFORM pg_temp.ck('Setup: expense categories in the brief''s order, no Profit share / Courier / Weight',
    (SELECT array_agg(name ORDER BY sort_order) FROM money_categories WHERE sort_order <= 11)
      = ARRAY['Ads', 'Packaging', 'Subscriptions', 'Salaries & bonus', 'Customer gifts & offers', 'Food', 'Utilities',
              'Bank & mobile fees', 'Rent', 'Transport', 'Other'],
    (SELECT array_agg(name ORDER BY sort_order)::text FROM money_categories));

  -- Throwaway products (they exist only inside this transaction).
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B41-A-' || v_tag, 'e2e-b41-a-' || v_tag, 'E2E B41 Cream', 300, 'in_stock', 0, true) RETURNING id INTO v_pa;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B41-B-' || v_tag, 'e2e-b41-b-' || v_tag, 'E2E B41 Serum', 500, 'in_stock', 0, true) RETURNING id INTO v_pb;

  -- ---------- Mode Off: Remove stock explains why it can't work
  PERFORM set_config('inventory.test_mode', '', true);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM money_write_off(v_pa, NULL, 1, 'expired', NULL, NULL); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  BEGIN PERFORM money_save_category(NULL, 'Courier charges'); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Write-off: while Inventory mode is Off it explains why', v_err LIKE 'Remove stock works only while Inventory mode is On%', v_err);
  PERFORM pg_temp.ck('Categories: "Courier" can''t be an expense category', v_txt LIKE '%can''t be an expense category%', v_txt);

  -- ===================================================== Mode ON from here on
  PERFORM set_config('inventory.test_mode', 'on', true);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  -- Opening stock L-000: 10 creams at ৳100.
  v_l0 := inventory_confirm_opening(v_today, 0, jsonb_build_array(
    jsonb_build_object('product_id', v_pa, 'source', 'import', 'buy_price_bdt', '100', 'pieces', 10, 'expiry', '2027-06-01')),
    'e2e-b41.xlsx');
  -- Site orders for the "already has a due" choices (placed before the
  -- opening balances are confirmed).
  SELECT order_id INTO v_o0 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'E2E B41 Three', p_phone => v_ph3, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  SELECT order_id INTO v_o4 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'E2E B41 Four', p_phone => v_ph4, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);

  -- ---------- Opening balances: preview (nothing saved)
  v_json := money_opening_preview(jsonb_build_array(
    jsonb_build_object('phone', '+880 1799-941041', 'name', 'E2E B41 One', 'due', '1500'),
    jsonb_build_object('phone', '8801799941043', 'name', 'E2E B41 Three', 'due', '1000'),
    jsonb_build_object('phone', '1799941044', 'name', 'E2E B41 Four', 'due', '700'),
    jsonb_build_object('phone', 'abc', 'name', 'Bad', 'due', '5'),
    jsonb_build_object('phone', '01799941041', 'name', 'Twice', 'due', '5')));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Opening preview: +880 / 880 / no 0 / spaces all match the same phone',
    (SELECT array_agg(r ->> 'phone_key' ORDER BY (r ->> 'n')::int) FROM jsonb_array_elements(v_json -> 'rows') r)
      = ARRAY[v_ph1, v_ph3, v_ph4, NULL, v_ph1],
    (SELECT array_agg(r ->> 'phone_key' ORDER BY (r ->> 'n')::int)::text FROM jsonb_array_elements(v_json -> 'rows') r));
  PERFORM pg_temp.ck('Opening preview: a new customer is listed as new, a site customer as known with the site due (৳380)',
    (v_json -> 'rows' -> 0 ->> 'known')::boolean = false
    AND (v_json -> 'rows' -> 1 ->> 'known')::boolean = true AND (v_json -> 'rows' -> 1 ->> 'site_due')::numeric = 380,
    v_json::text);
  PERFORM pg_temp.ck('Opening preview: a bad phone and the same phone twice are flagged',
    v_json -> 'rows' -> 3 ->> 'problem' = 'Phone number not valid' AND v_json -> 'rows' -> 4 ->> 'problem' = 'Same phone twice in the file',
    v_json::text);
  PERFORM pg_temp.ck('Opening preview: nothing saved', NOT EXISTS (SELECT 1 FROM customer_opening_dues)
    AND (SELECT confirmed_at FROM money_books) IS NULL);

  -- ---------- Confirm the opening balances
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM money_confirm_opening(v_today - 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  v_json := money_confirm_opening(v_today,
    jsonb_build_array(jsonb_build_object('account_id', v_cash, 'amount', 5000), jsonb_build_object('account_id', v_bkash, 'amount', 3000),
                      jsonb_build_object('account_id', v_bank, 'amount', 20000)),
    jsonb_build_array(jsonb_build_object('phone', '+880 1799-941041', 'name', 'E2E B41 One', 'due', '1500', 'choice', 'kaarbar'),
                      jsonb_build_object('phone', '8801799941043', 'name', 'E2E B41 Three', 'due', '1000', 'choice', 'kaarbar'),
                      jsonb_build_object('phone', '1799941044', 'name', 'E2E B41 Four', 'due', '700', 'choice', 'keep_site')),
    jsonb_build_array(jsonb_build_object('kind', 'investor', 'name', 'E2E B41 Investor ' || v_tag, 'amount', 10000),
                      jsonb_build_object('kind', 'supplier', 'name', 'E2E B41 Supplier ' || v_tag, 'amount', 2000)));
  BEGIN PERFORM money_confirm_opening(v_today, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Opening: the start date must be the opening stock''s date', v_err LIKE 'The start date must be the opening stock''s date%', v_err);
  PERFORM pg_temp.ck('Opening: confirmed once; a second confirm is refused', v_txt LIKE 'The opening balances were already confirmed%', v_txt);
  PERFORM pg_temp.ck('Opening: 3 accounts, 2 dues (৳1,500 new; Kaarbar ৳1,000 − site ৳380 = ৳620), "keep the site due" adds nothing, ৳12,000 owed',
    (v_json ->> 'accounts')::int = 3 AND (v_json ->> 'dues')::int = 2 AND (v_json ->> 'dues_total')::numeric = 2120
    AND (v_json ->> 'payables_total')::numeric = 12000
    AND (SELECT amount FROM customer_opening_dues WHERE phone_key = v_ph3) = 620
    AND NOT EXISTS (SELECT 1 FROM customer_opening_dues WHERE phone_key = v_ph4), v_json::text);
  PERFORM pg_temp.ck('Opening: the new customer is in the Customers list',
    EXISTS (SELECT 1 FROM customers WHERE customer_key = 'ph:' || v_ph1 AND added_by_hand));
  PERFORM pg_temp.ck('Balance check: green right after the opening',
    (v_sum -> 'position' ->> 'balanced')::boolean, v_sum -> 'position' ->> 'difference');
  SELECT id INTO v_inv FROM parties_payable WHERE name = 'E2E B41 Investor ' || v_tag;
  SELECT id INTO v_sup FROM suppliers WHERE name = 'E2E B41 Supplier ' || v_tag;

  -- ---------- Expense, move money, investors, owner, not-shop money
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_before := money_profit_parts(v_today, v_today);
  v_num := pg_temp.bal(v_cash);
  v_num2 := pg_temp.bal(v_bank);
  PERFORM money_add_entry('expense', 500, v_cash, v_today, 'e2e ads', v_ads);
  v_after := money_profit_parts(v_today, v_today);
  v_ids := money_add_entry('transfer', 1000, v_bkash, v_today, 'e2e move', NULL, NULL, NULL, v_bank) -> 'ids';
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Expense: ৳500 Ads lowers net profit by ৳500 and Cash by ৳500',
    (v_after ->> 'net_profit')::numeric = (v_before ->> 'net_profit')::numeric - 500 AND (v_after ->> 'expenses')::numeric = 500
    AND pg_temp.bal(v_cash) = v_num - 500, format('%s → %s', v_before ->> 'net_profit', v_after ->> 'net_profit'));
  PERFORM pg_temp.ck('Move money: always a pair (−৳1,000 bKash, +৳1,000 Bank, same pair id), adds up to 0',
    (SELECT count(*) = 2 AND sum(amount) = 0 AND count(DISTINCT transfer_id) = 1 AND min(amount) = -1000
     FROM money_movements WHERE id IN (SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(v_ids) x))
    AND pg_temp.bal(v_bank) = v_num2 + 1000);

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_before := money_profit_parts(v_today, v_today);
  v_num := pg_temp.bal(v_bank);
  PERFORM money_add_entry('investor_in', 10000, v_bank, v_today, NULL, NULL, v_inv);
  PERFORM money_add_entry('investor_profit_share', 300, v_bank, v_today, NULL, NULL, v_inv);
  PERFORM money_add_entry('investor_capital_back', 2000, v_bank, v_today, NULL, NULL, v_inv);
  PERFORM money_add_entry('owner_withdrawal', 700, v_cash, v_today);
  PERFORM money_add_entry('owner_money_in', 400, v_cash, v_today);
  PERFORM money_add_entry('non_business_in', 2500, v_bank, v_today, 'consultancy');
  PERFORM money_add_entry('non_business_out', 1000, v_bank, v_today, 'consultancy');
  v_after := money_profit_parts(v_today, v_today);
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Not expenses: investor in / profit share / capital back, my withdrawal / money in, not-shop money never change net profit',
    (v_after ->> 'net_profit')::numeric = (v_before ->> 'net_profit')::numeric AND (v_after ->> 'expenses')::numeric = 500,
    format('%s → %s', v_before ->> 'net_profit', v_after ->> 'net_profit'));
  PERFORM pg_temp.ck('Profit lines: Net − profit share ৳300 = Your profit; − withdrawals ৳700 = Left in the business',
    (v_after ->> 'your_profit')::numeric = (v_after ->> 'net_profit')::numeric - 300
    AND (v_after ->> 'left_in_business')::numeric = (v_after ->> 'net_profit')::numeric - 300 - 700, v_after::text);
  PERFORM pg_temp.ck('Accounts: Bank +10,000 − 300 − 2,000 + 2,500 − 1,000 = +৳9,200',
    pg_temp.bal(v_bank) = v_num + 9200, format('%s → %s', v_num, pg_temp.bal(v_bank)));
  PERFORM pg_temp.ck('To give: investor capital ৳10,000 opening + ৳10,000 in − ৳2,000 back = ৳18,000; profit share ৳300',
    EXISTS (SELECT 1 FROM money_to_give_rows() r WHERE r.id = v_inv AND r.owed = 18000 AND r.share_all = 300 AND r.share_month = 300),
    (SELECT row_to_json(r)::text FROM money_to_give_rows() r WHERE r.id = v_inv));
  PERFORM pg_temp.ck('Balance check: green after every kind of entry', (v_sum -> 'position' ->> 'balanced')::boolean,
    v_sum -> 'position' ->> 'difference');

  -- ---------- A lot with payments (fixes cash) and the supplier balance
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_lot := inventory_save_lot(jsonb_build_object('source_type', 'wholesale', 'lot_date', v_today::text, 'costs_pending', false,
    'notes', 'e2e b41', 'supplier_id', v_sup,
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pa, 'qty', 5, 'unit_price_foreign', '120', 'expiry_date', '2026-12-01'),
      jsonb_build_object('product_id', v_pb, 'qty', 10, 'unit_price_foreign', '200', 'expiry_date', '2027-01-01')),
    'costs', '[]'::jsonb));
  v_num := pg_temp.bal(v_bank);
  v_json := money_set_lot_payments(v_lot, jsonb_build_array(jsonb_build_object('account_id', v_bank, 'amount', 2000, 'date', v_today)));
  SELECT owed INTO v_num2 FROM money_to_give_rows() WHERE id = v_sup;
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  SELECT code INTO v_lot_code FROM lots WHERE id = v_lot;
  PERFORM pg_temp.ck('Lot: landed ৳2,600, paid ৳2,000 from Bank → ৳600 owed to its supplier',
    (v_json ->> 'landed')::numeric = 2600 AND (v_json ->> 'owed')::numeric = 600 AND pg_temp.bal(v_bank) = v_num - 2000, v_json::text);
  PERFORM pg_temp.ck('Lot: the unpaid ৳600 appears once in To give (supplier: ৳2,000 opening + ৳600)', v_num2 = 2600, v_num2::text);
  PERFORM pg_temp.ck('Lot: buying stock is not an expense (net profit unchanged)',
    (v_sum -> 'profit' ->> 'expenses')::numeric = 500, v_sum -> 'profit' ->> 'expenses');
  PERFORM pg_temp.ck('Balance check: green after a lot with a part payment', (v_sum -> 'position' ->> 'balanced')::boolean,
    v_sum -> 'position' ->> 'difference');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM money_add_entry('supplier_payment', 600, v_bank, v_today, 'rest of the lot', NULL, NULL, v_sup);
  SELECT owed INTO v_num2 FROM money_to_give_rows() WHERE id = v_sup;
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Lot: after a ৳600 supplier payment only the opening ৳2,000 is owed', v_num2 = 2000, v_num2::text);
  PERFORM pg_temp.ck('Balance check: green after the supplier payment', (v_sum -> 'position' ->> 'balanced')::boolean,
    v_sum -> 'position' ->> 'difference');

  -- ---------- A sale: payment counted once, Steadfast payout, fees once
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o1 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 2)),
    p_full_name => 'E2E B41 One', p_phone => v_ph1, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  v_num := pg_temp.bal(v_bkash);
  v_pay := admin_add_order_payment(v_o1, 200, 'bkash', 'E2EB41', now(), 'advance');
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Ledger: a customer payment appears exactly once (bKash +৳200)',
    (SELECT count(*) FROM money_ledger WHERE source = 'payment' AND source_id = v_pay::text) = 1
    AND pg_temp.bal(v_bkash) = v_num + 200);
  PERFORM pg_temp.ck('Customer payments are read, never copied into money entries',
    NOT EXISTS (SELECT 1 FROM money_movements WHERE order_id = v_o1));
  PERFORM pg_temp.ck('Write-off FEFO setup: the order took its 2 creams from the earliest-expiry lot at ৳120',
    (SELECT sum(units) FROM order_item_lots x JOIN lot_items li ON li.id = x.lot_item_id WHERE x.order_id = v_o1 AND li.lot_id = v_lot) = 2);
  PERFORM pg_temp.ck('Balance check: green with an order not delivered yet (paid in part)',
    (v_sum -> 'position' ->> 'balanced')::boolean, v_sum -> 'position' ->> 'difference');

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_set_order_status(v_o1, 'delivered', 'e2e');
  EXECUTE 'RESET ROLE';
  -- Steadfast (mocked): COD ৳480 collected; a payout of ৳415.20 after
  -- delivery ৳60 + COD fee ৳4.80.
  INSERT INTO order_payments (order_id, amount, method, paid_at, note, source, created_by_username)
  VALUES (v_o1, 480, 'cod_steadfast', now(), 'e2e COD', 'steadfast_cod', 'e2e');
  INSERT INTO steadfast_payouts (steadfast_payment_id, paid_at, total_amount, parcel_count, items_synced)
  VALUES ('e2e-b41-' || v_tag, now(), 415.20, 1, true) RETURNING id INTO v_payout;
  INSERT INTO steadfast_payout_items (payout_id, item_key, consignment_id, invoice, order_id, cod_collected, delivery_charge, cod_fee,
                                      net_paid, expected_cod, match_status)
  VALUES (v_payout, 'c:e2e-b41-' || v_tag, 'e2e-b41-' || v_tag, (SELECT order_number FROM orders WHERE id = v_o1), v_o1,
          480, 60, 4.8, 415.2, 480, 'matched');
  INSERT INTO order_courier_costs (order_id, cod_collected, delivery_charge, cod_fee, other_deduction, total_kept, net_received, payout_id, paid_at)
  VALUES (v_o1, 480, 60, 4.8, 0, 64.8, 415.2, v_payout, now());
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_num := pg_temp.bal(v_sf);
  v_num2 := pg_temp.bal(v_bank);
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Steadfast: the COD waits in "With Steadfast" (+৳480 − ৳64.80 kept = ৳415.20 until placed)',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_sum -> 'position' -> 'unplaced_payouts') p WHERE (p ->> 'payout_id')::uuid = v_payout),
    v_sum -> 'position' ->> 'with_steadfast');
  PERFORM pg_temp.ck('Balance check: green with a payout not placed yet', (v_sum -> 'position' ->> 'balanced')::boolean,
    v_sum -> 'position' ->> 'difference');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM money_place_payout(v_payout, v_bank);
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Steadfast: placing the payout moves ৳415.20 from "With Steadfast" to Bank',
    pg_temp.bal(v_sf) = v_num - 415.2 AND pg_temp.bal(v_bank) = v_num2 + 415.2,
    format('sf %s → %s, bank %s → %s', v_num, pg_temp.bal(v_sf), v_num2, pg_temp.bal(v_bank)));
  PERFORM pg_temp.ck('Steadfast: the last account is remembered for the next payout',
    (SELECT last_payout_account_id FROM money_books) = v_bank);
  PERFORM pg_temp.ck('No double counting: courier + COD fee (৳64.80) only in order profit, never an expense',
    (v_sum -> 'profit' ->> 'courier')::numeric = 64.8 AND (v_sum -> 'profit' ->> 'expenses')::numeric = 500, v_sum -> 'profit' ->> 'courier');
  PERFORM pg_temp.ck('Profit: 600 − 240 + 80 − 64.80 − 500 = −৳124.80 net',
    (v_sum -> 'profit' ->> 'net_profit')::numeric = -124.8, v_sum -> 'profit' ->> 'net_profit');
  PERFORM pg_temp.ck('Balance check: green after the payout is placed', (v_sum -> 'position' ->> 'balanced')::boolean,
    v_sum -> 'position' ->> 'difference');

  -- ---------- Write-offs
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := money_write_off(v_pa, NULL, 1, 'expired', 'e2e', NULL);
  v_wo := (v_json ->> 'id')::uuid;
  SELECT order_id INTO v_o2 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pb, 'quantity', 1)),
    p_full_name => 'E2E B41 One', p_phone => v_ph1, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  PERFORM admin_set_order_status(v_o2, 'shipped', 'e2e');
  SELECT id INTO v_item FROM order_items WHERE order_id = v_o2;
  PERFORM admin_mark_order_returned_damaged(v_o2, 'e2e damaged',
    jsonb_build_array(jsonb_build_object('order_item_id', v_item, 'units', 1)));
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Write-off: 1 cream leaves the earliest-expiry lot at its landed cost ৳120',
    (v_json ->> 'cost_bdt')::numeric = 120 AND v_json -> 'lots' -> 0 ->> 'code' = v_lot_code, v_json::text);
  PERFORM pg_temp.ck('Write-off: it is an adjustment stock movement, and units left = 15 − 4 sold − 1 removed = 10',
    EXISTS (SELECT 1 FROM stock_movements m JOIN lot_items li ON li.id = m.lot_item_id
            WHERE li.product_id = v_pa AND m.movement_type = 'adjustment' AND m.qty = -1)
    AND inventory_units_left(v_pa, NULL) = 10, inventory_units_left(v_pa, NULL)::text);
  PERFORM pg_temp.ck('Damaged return: the order is Returned and the serum does NOT go back in stock (10 − 1 = 9)',
    (SELECT status FROM orders WHERE id = v_o2) = 'returned' AND inventory_units_left(v_pb, NULL) = 9,
    inventory_units_left(v_pb, NULL)::text);
  PERFORM pg_temp.ck('Damaged return: written off at the sale''s cost ৳200',
    EXISTS (SELECT 1 FROM stock_write_offs WHERE order_id = v_o2 AND reason = 'damaged_return' AND cost_bdt = 200 AND units = 1));
  PERFORM pg_temp.ck('Write-offs are their own profit line (৳320), not expenses',
    (v_sum -> 'profit' ->> 'write_offs')::numeric = 320 AND (v_sum -> 'profit' ->> 'expenses')::numeric = 500
    AND (v_sum -> 'profit' ->> 'net_profit')::numeric = -444.8, v_sum -> 'profit' ->> 'net_profit');
  PERFORM pg_temp.ck('Balance check: green after write-offs and a damaged return', (v_sum -> 'position' ->> 'balanced')::boolean,
    v_sum -> 'position' ->> 'difference');

  -- ---------- Customer dues and the reminder
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_num := pg_temp.bal(v_cash);
  v_dp := money_add_due_payment('+8801799941041', 500, v_cash, v_today, 'e2e');
  BEGIN PERFORM money_add_due_payment(v_ph1, 5000, v_cash, v_today, NULL); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM money_record_reminder('ph:' || v_ph1, v_ph1, 1000, NULL, 'whatsapp');
  SELECT row_to_json(d)::jsonb INTO v_json FROM money_customer_dues() d WHERE d.customer_key = 'ph:' || v_ph1;
  v_after := money_customer_history('ph:' || v_ph1, v_ph1);
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Previous balance: ৳1,500 − ৳500 paid into Cash = ৳1,000 left; Cash +৳500',
    (v_json ->> 'previous_left')::numeric = 1000 AND pg_temp.bal(v_cash) = v_num + 500, v_json::text);
  PERFORM pg_temp.ck('Previous balance: paying more than is left is refused', v_err LIKE 'The previous balance left is only%', v_err);
  PERFORM pg_temp.ck('Dues: the delivered order is fully paid and the Returned order owes nothing',
    (v_json ->> 'order_due')::numeric = 0, v_json::text);
  PERFORM pg_temp.ck('Reminder: written in the customer''s history (৳1,000, today) and the Activity Log',
    jsonb_array_length(v_after -> 'reminders') = 1 AND (v_after -> 'reminders' -> 0 ->> 'amount')::numeric = 1000
    AND EXISTS (SELECT 1 FROM activity_log WHERE action = 'money.due_reminder' AND entity_id = 'ph:' || v_ph1),
    v_after::text);
  PERFORM pg_temp.ck('Balance check: green after a previous-balance payment', (v_sum -> 'position' ->> 'balanced')::boolean,
    v_sum -> 'position' ->> 'difference');

  -- ---------- Edits are logged; deletes need the amount typed
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT id INTO v_pay FROM money_movements WHERE type = 'expense' AND note = 'e2e ads';
  PERFORM money_update_entry(v_pay, 550, v_cash, v_today, 'e2e ads', v_ads);
  BEGIN PERFORM money_delete_entry(v_pay, 1); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Edit: logged with before and after',
    EXISTS (SELECT 1 FROM activity_log WHERE action = 'money.edit' AND entity_id = v_pay::text
            AND (details -> 'before' ->> 'amount')::numeric = -500 AND (details -> 'after' ->> 'amount')::numeric = -550));
  PERFORM pg_temp.ck('Delete: refused unless the amount is typed', v_err LIKE 'Type the amount (550) to confirm.', v_err);
  PERFORM pg_temp.ck('Balance check: green after an edit', (v_sum -> 'position' ->> 'balanced')::boolean, v_sum -> 'position' ->> 'difference');

  -- ---------- The balance check turns red when something is removed behind its back
  DELETE FROM stock_write_offs WHERE id = v_wo;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_sum := money_summary(v_today, v_today);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Balance check: red with the right difference (−৳120) when a write-off record is removed behind its back',
    (v_sum -> 'position' ->> 'balanced')::boolean = false AND (v_sum -> 'position' ->> 'difference')::numeric = -120
    AND (v_sum -> 'position' ->> 'first_wrong')::date = v_today, v_sum -> 'position' ->> 'difference');

  -- ---------- The customer sees only "Previous balance ৳X"
  PERFORM set_config('request.jwt.claims', c_admin, true);
  UPDATE profiles SET phone = v_ph1 WHERE id = v_cust;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_num := customer_previous_balance();
  BEGIN PERFORM money_summary(v_today, v_today); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  BEGIN PERFORM money_add_entry('expense', 10, v_cash, v_today, NULL, v_ads); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  SELECT (SELECT count(*) FROM money_movements) + (SELECT count(*) FROM money_ledger) + (SELECT count(*) FROM customer_opening_dues)
       + (SELECT count(*) FROM stock_write_offs) + (SELECT count(*) FROM money_accounts) + (SELECT count(*) FROM parties_payable)
       + (SELECT count(*) FROM money_books)
  INTO v_int;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Customer: sees one number, "Previous balance" ৳1,000', v_num = 1000, v_num::text);
  PERFORM pg_temp.ck('Permissions: a customer can read nothing and add nothing',
    v_err = 'Not authorized.' AND v_txt = 'Not authorized.' AND v_int = 0, format('%s | %s | %s rows', v_err, v_txt, v_int));

  -- ---------- Staff with "Add money entries" only (the test customer made a
  -- moderator inside this transaction only)
  PERFORM set_config('request.jwt.claims', c_admin, true);
  UPDATE profiles SET role = 'moderator', status = 'approved' WHERE id = v_cust;
  INSERT INTO staff_members (id, username, full_name, permissions, is_disabled)
  VALUES (v_cust, 'e2e.b41.staff.' || v_tag, 'E2E B41 staff', ARRAY['add_money_entries'], false)
  ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions, role_id = NULL, is_disabled = false;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN v_ids := money_add_entry('expense', 75, v_cash, v_today, 'e2e staff', v_ads) -> 'ids'; v_txt := 'added'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  BEGIN PERFORM money_summary(v_today, v_today); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  BEGIN PERFORM money_add_entry('owner_withdrawal', 75, v_cash, v_today); v_json := '{"w":"allowed"}'; EXCEPTION WHEN OTHERS THEN v_json := jsonb_build_object('w', SQLERRM); END;
  SELECT (SELECT count(*) FROM money_movements) + (SELECT count(*) FROM money_ledger) + (SELECT count(*) FROM money_books)
       + (SELECT count(*) FROM stock_write_offs) + (SELECT count(*) FROM parties_payable)
  INTO v_int;
  SELECT count(*) INTO v_num FROM money_accounts;
  BEGIN PERFORM order_profit(v_o1); v_dp := NULL; v_num2 := 0; EXCEPTION WHEN OTHERS THEN v_num2 := 1; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('"Add money entries": can add an expense', v_txt = 'added', v_txt);
  PERFORM pg_temp.ck('"Add money entries": cannot read profit, balances or any list (server-side)',
    v_err = 'Not authorized.' AND v_int = 0 AND v_num2 = 1, format('%s | %s rows', v_err, v_int));
  PERFORM pg_temp.ck('"Add money entries": sees the account names for the form, nothing else', v_num >= 4, v_num::text);
  PERFORM pg_temp.ck('"Add money entries": cannot record owner or investor money', v_json ->> 'w' = 'Not authorized.', v_json::text);
  PERFORM pg_temp.ck('The new switch is Off for every role and person',
    NOT EXISTS (SELECT 1 FROM staff_roles WHERE 'add_money_entries' = ANY (permissions))
    AND NOT EXISTS (SELECT 1 FROM staff_members WHERE 'add_money_entries' = ANY (permissions) AND id <> v_cust));

  -- ---------- Undo the opening: Careful actions + Safety Lock
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM money_undo_opening('UNDO'); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM admin_open_delete_lock(120);
  BEGIN PERFORM money_undo_opening('UNDO'); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  SELECT id INTO v_dp FROM customer_due_payments WHERE phone_key = v_ph1;
  PERFORM money_delete_due_payment(v_dp, 500);
  PERFORM money_undo_opening('UNDO');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Undo: needs the Safety Lock open', v_err LIKE 'Open the Safety Lock first%', v_err);
  PERFORM pg_temp.ck('Undo: refused while previous-balance payments exist', v_txt LIKE 'There are 1 payments against previous balances%', v_txt);
  PERFORM pg_temp.ck('Undo: the opening is gone and logged',
    (SELECT confirmed_at FROM money_books) IS NULL AND NOT EXISTS (SELECT 1 FROM customer_opening_dues)
    AND NOT EXISTS (SELECT 1 FROM money_movements WHERE type = 'opening_balance')
    AND EXISTS (SELECT 1 FROM activity_log WHERE action = 'money.opening_undo'));

END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
