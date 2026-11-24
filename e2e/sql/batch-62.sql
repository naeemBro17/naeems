-- Batch 62, tested on the database (run by e2e/batch-62.spec.ts through
-- the Supabase command line).
--
-- SAFE ON THE LIVE DATABASE: everything runs inside ONE transaction that
-- always ends with ROLLBACK. Only made-up rows are added (products
-- "B62 …", made-up phones 0179997xxxx); the settings a check needs
-- (Inventory mode, order limit) are changed inside the transaction only.
--
-- Before Naeem has run migration-061 the spec puts the migration in front
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
  c_admin_pw text;
  c_cust     text;
  k_cust     text;
  v_tag      text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_today    date := inventory_dhaka_today();
  v_bkash    uuid := money_account_for_method('bkash');
  d0         numeric;
  v_err      text;
  v_j        jsonb;
  v_n        integer;
  v_prod     uuid;
  v_var      uuid;
  v_keep     uuid;
  v_sup      uuid;
  v_lotp     uuid;
  v_o        uuid;
  v_back     text;
BEGIN
  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  k_cust := 'p:' || v_cust;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2')::text;
  c_admin_pw := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;

  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.diff() RETURNS numeric LANGUAGE sql AS
    'SELECT (money_position() ->> ''difference'')::numeric'$f$;

  PERFORM set_config('request.jwt.claims', c_admin, true);
  d0 := pg_temp.diff();
  PERFORM pg_temp.ck('0 Balance check difference before the test is ৳0.00', abs(d0) < 0.01, d0::text);

  -- ---------------------------------------------------------- 1. WALLET
  PERFORM pg_temp.ck('1 Migration: every customer with a wallet entry or request has an open wallet',
    NOT EXISTS (SELECT 1 FROM (SELECT customer_key FROM store_wallet_entries UNION SELECT customer_key FROM store_wallet_requests) k
                WHERE NOT store_wallet_is_open(k.customer_key)));

  -- The test customer starts closed (this transaction only).
  IF store_wallet_balance(k_cust) <> 0 THEN
    RAISE EXCEPTION 'TEST_SETUP:the test customer already has wallet money';
  END IF;
  DELETE FROM store_wallet_access a WHERE store_wallet_owner(a.customer_key) = store_wallet_owner(k_cust);

  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_j := store_wallet_my();
  PERFORM pg_temp.ck('1 Closed: My wallet says open = false', (v_j ->> 'open')::boolean = false, v_j ->> 'open');
  v_err := NULL;
  BEGIN
    PERFORM store_wallet_request(1000, 'bkash', 'B62A' || v_tag, '01799970001');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Closed: the request is refused with the WhatsApp message',
    v_err = 'Your wallet isn''t open yet. Message us on WhatsApp and we''ll open it.', COALESCE(v_err, 'it ran'));
  v_err := NULL;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO store_wallet_requests (customer_key, profile_id, amount, method, trx_id, sender)
    VALUES (k_cust, v_cust, 1000, 'bkash', 'B62B' || v_tag, '01799970001');
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    EXECUTE 'RESET ROLE';
  END;
  PERFORM pg_temp.ck('1 Closed: a direct insert of a request is refused too', v_err LIKE 'Your wallet isn''t open yet%', COALESCE(v_err, 'it ran'));

  -- Admin "Add to wallet" opens it.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_j := store_wallet_add(k_cust, 1000, v_bkash, v_today, 'B62 test');
  PERFORM pg_temp.ck('1 Add to wallet works on a closed wallet', (v_j ->> 'balance')::numeric = 1000, v_j::text);
  PERFORM pg_temp.ck('1 Add to wallet opened it', store_wallet_is_open(k_cust));
  PERFORM pg_temp.ck('1 Admin customer page says open', (store_wallet_customer(k_cust) ->> 'open')::boolean);
  PERFORM pg_temp.ck('1 Balance check unchanged after Add to wallet', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);

  v_err := NULL;
  BEGIN
    PERFORM store_wallet_set_open(k_cust, false);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Closing a wallet with ৳1,000 is refused',
    v_err = 'This wallet still has ৳1,000. It can be closed when the balance is ৳0.', COALESCE(v_err, 'it ran'));

  PERFORM set_config('request.jwt.claims', c_admin_pw, true);
  PERFORM store_wallet_correct(k_cust, 0, 'B62 test back to 0');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_j := store_wallet_set_open(k_cust, false);
  PERFORM pg_temp.ck('1 At ৳0 the wallet closes', (v_j ->> 'open')::boolean = false AND NOT store_wallet_is_open(k_cust), v_j::text);
  v_j := store_wallet_set_open(k_cust, true);
  PERFORM pg_temp.ck('1 The switch opens it again', (v_j ->> 'open')::boolean AND store_wallet_is_open(k_cust), v_j::text);

  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_j := store_wallet_request(1000, 'bkash', 'B62C' || v_tag, '01799970001');
  PERFORM pg_temp.ck('1 Open: the request is accepted', v_j ->> 'status' = 'waiting', v_j::text);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_err := NULL;
  BEGIN
    PERFORM store_wallet_set_open(k_cust, false);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Closing with a waiting request is refused', v_err LIKE 'This wallet has a request waiting%', COALESCE(v_err, 'it ran'));

  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM store_wallet_set_open(k_cust, true);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 A customer cannot use the switch', v_err = 'Not authorized.', COALESCE(v_err, 'it ran'));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM pg_temp.ck('1 Needs attention: a key with no name or phone shows "A customer"',
    store_wallet_display_name('p:' || gen_random_uuid()) = 'A customer', store_wallet_display_name('p:' || gen_random_uuid()));
  PERFORM pg_temp.ck('1 Needs attention: a phone key with no name shows the phone',
    store_wallet_display_name('ph:01799970009') = '01799970009', store_wallet_display_name('ph:01799970009'));
  PERFORM pg_temp.ck('1 Needs attention: a given name wins', store_wallet_display_name(k_cust, 'Rina') = 'Rina');
  PERFORM pg_temp.ck('1 No waiting request is listed by its internal key',
    NOT EXISTS (SELECT 1 FROM store_wallet_waiting() w WHERE w.name ~ '^(p|ph|n):'));
  PERFORM pg_temp.ck('1 Balance check unchanged after the wallet steps', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);

  -- ---------------------------------------------------------- 2. HIDDEN SIZE
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active, keep_selling, size)
  VALUES ('B62-H-' || v_tag, 'b62-h-' || v_tag, 'B62 Hidden Size Cream', 1000, 'in_stock', NULL, true, true, '50ml')
  RETURNING id INTO v_prod;
  INSERT INTO product_variants (product_id, region, size, retail_price, in_stock, is_visible, sort_order)
  VALUES (v_prod, 'AU', '100ml', 1500, true, false, 1)
  RETURNING id INTO v_var;

  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM place_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'variant_id', v_var, 'quantity', 1)),
      'B62 Test', '01799970002', 'Dhaka', 'Dhaka', 'Gulshan', 'B62 road', 'inside_dhaka', 'cod');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('2 place_order refuses a hidden size', v_err = 'This size is no longer available.', COALESCE(v_err, 'it ran'));

  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM product_variants_view WHERE id = v_var;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('2 A signed-in customer cannot read the hidden size (view)', v_n = 0, v_n::text);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM product_variants WHERE id = v_var;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('2 A signed-in customer cannot read the hidden size (table)', v_n = 0, v_n::text);

  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO v_n FROM product_variants_view WHERE id = v_var;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('2 An anonymous visitor cannot read the hidden size (view)', v_n = 0, v_n::text);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO v_n FROM product_variants WHERE id = v_var;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('2 An anonymous visitor cannot read the hidden size (table)', v_n = 0, v_n::text);

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM product_variants_view WHERE id = v_var;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('2 The admin still sees the hidden size', v_n = 1, v_n::text);

  UPDATE product_variants SET is_visible = true WHERE id = v_var;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM product_variants_view WHERE id = v_var;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('2 Shown again: the customer reads it', v_n = 1, v_n::text);
  v_err := NULL;
  BEGIN
    PERFORM place_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'variant_id', v_var, 'quantity', 1)),
      'B62 Test', '01799970002', 'Dhaka', 'Dhaka', 'Gulshan', 'B62 road', 'inside_dhaka', 'cod');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('2 Shown again: the size can be ordered', v_err IS NULL, COALESCE(v_err, ''));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM pg_temp.ck('2 Balance check unchanged after the orders', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);

  -- ---------------------------------------------------------- 3. TAB
  PERFORM pg_temp.ck('3 The two fish oils count in tab',
    (SELECT count(*) FROM products WHERE stock_unit = 'tab'
       AND name IN ('Blackmores Fish Oil 1000 | 400 Capsules', 'Blackmores Omega Triple Super Strength Fish Oil')) = 2);
  PERFORM pg_temp.ck('3 Their pack sizes are untouched (400 and 150)',
    (SELECT pack_size FROM products WHERE name = 'Blackmores Fish Oil 1000 | 400 Capsules') = 400
    AND (SELECT pack_size FROM products WHERE name = 'Blackmores Omega Triple Super Strength Fish Oil') = 150);

  PERFORM inventory_save_supplier('B62 Supplier ' || v_tag);
  SELECT id INTO v_sup FROM suppliers WHERE name = 'B62 Supplier ' || v_tag;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active, stock_unit, pack_size)
  VALUES ('B62-T-' || v_tag, 'b62-t-' || v_tag, 'B62 Capsules', 2000, 'in_stock', 0, false, 'pcs', 60)
  RETURNING id INTO v_lotp;
  PERFORM inventory_save_lot(jsonb_build_object('source_type', 'local', 'country', 'Bangladesh', 'lot_date', v_today::text,
    'costs_pending', false, 'notes', 'B62 lot', 'supplier_id', v_sup,
    'items', jsonb_build_array(jsonb_build_object('product_id', v_lotp, 'qty', 120, 'unit_price_foreign', '10',
                                                  'expiry_date', '2028-06-01'))));
  PERFORM pg_temp.ck('3 The made-up product is locked (it has a lot)', inventory_pack_locked(v_lotp, NULL));
  v_n := (SELECT sum(qty_remaining) FROM lot_items WHERE product_id = v_lotp);
  v_err := NULL;
  BEGIN
    PERFORM inventory_set_pack(v_lotp, NULL, 'tab', 60);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('3 Word-only change pcs → tab is allowed', v_err IS NULL AND (SELECT stock_unit FROM products WHERE id = v_lotp) = 'tab',
    COALESCE(v_err, ''));
  PERFORM pg_temp.ck('3 Units in the lot unchanged by the word change', (SELECT sum(qty_remaining) FROM lot_items WHERE product_id = v_lotp) = v_n, v_n::text);
  v_err := NULL;
  BEGIN
    PERFORM inventory_set_pack(v_lotp, NULL, 'tab', 30);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('3 A pack-size change is still refused', v_err LIKE 'This product already has stock or sales counted per pack%',
    COALESCE(v_err, 'it ran'));
  v_err := NULL;
  BEGIN
    PERFORM inventory_set_pack(v_lotp, NULL, 'box', 60);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('3 An unknown word is refused', v_err = 'Stock unit must be pcs, ml, g or tab.', COALESCE(v_err, 'it ran'));
  PERFORM pg_temp.ck('3 Balance check unchanged after the lot', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);

  -- ---------------------------------------------------------- 4. REOPEN KEEP SELLING
  UPDATE app_settings SET value = '20' WHERE key = 'order_limit_per_item';
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active, keep_selling)
  VALUES ('B62-K-' || v_tag, 'b62-k-' || v_tag, 'B62 Keep Selling Serum', 1200, 'in_stock', 0, true, true)
  RETURNING id INTO v_keep;

  -- Mode On (no lots at all for this product).
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'true' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o FROM place_order(jsonb_build_array(jsonb_build_object('product_id', v_keep, 'quantity', 2)),
    'B62 Keep', '01799970003', 'Dhaka', 'Dhaka', 'Gulshan', 'B62 road', 'inside_dhaka', 'cod');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_set_order_status(v_o, 'confirmed');
  PERFORM admin_set_order_status(v_o, 'cancelled');
  v_err := NULL;
  BEGIN
    v_back := admin_reopen_order(v_o);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('4 Mode On: a Keep selling order reopens at stock 0', v_err IS NULL AND v_back = 'confirmed',
    COALESCE(v_err, v_back));
  PERFORM pg_temp.ck('4 Mode On: the 2 units are recorded as sold without stock',
    (SELECT COALESCE(sum(units), 0) FROM stock_shortfalls WHERE order_id = v_o AND status <> 'cancelled') = 2,
    (SELECT COALESCE(sum(units), 0) FROM stock_shortfalls WHERE order_id = v_o AND status <> 'cancelled')::text);
  PERFORM pg_temp.ck('4 Mode On: the order says "bought after the order"', (SELECT buys_later FROM orders WHERE id = v_o));
  PERFORM pg_temp.ck('4 Balance check unchanged (Mode On)', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);

  -- Mode Off.
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  UPDATE products SET stock_quantity = 1 WHERE id = v_keep;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o FROM place_order(jsonb_build_array(jsonb_build_object('product_id', v_keep, 'quantity', 3)),
    'B62 Keep', '01799970003', 'Dhaka', 'Dhaka', 'Gulshan', 'B62 road', 'inside_dhaka', 'cod');
  PERFORM pg_temp.ck('4 Mode Off: the order takes the 1 in stock, 2 bought after',
    (SELECT stock_quantity FROM products WHERE id = v_keep) = 0
    AND (SELECT qty FROM order_item_unstocked u JOIN order_items oi ON oi.id = u.order_item_id WHERE oi.order_id = v_o) = 2);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_set_order_status(v_o, 'cancelled');
  PERFORM pg_temp.ck('4 Mode Off: cancel gives the 1 back', (SELECT stock_quantity FROM products WHERE id = v_keep) = 1);
  UPDATE products SET stock_quantity = 0 WHERE id = v_keep;
  v_err := NULL;
  BEGIN
    v_back := admin_reopen_order(v_o);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('4 Mode Off: a Keep selling order reopens at stock 0', v_err IS NULL AND v_back = 'pending',
    COALESCE(v_err, v_back));
  PERFORM pg_temp.ck('4 Mode Off: stock stays 0 (never below)', (SELECT stock_quantity FROM products WHERE id = v_keep) = 0);
  PERFORM pg_temp.ck('4 Mode Off: all 3 are now bought after the order',
    (SELECT qty FROM order_item_unstocked u JOIN order_items oi ON oi.id = u.order_item_id WHERE oi.order_id = v_o) = 3,
    (SELECT qty FROM order_item_unstocked u JOIN order_items oi ON oi.id = u.order_item_id WHERE oi.order_id = v_o)::text);
  PERFORM pg_temp.ck('4 Mode Off: no stock counted as taken (pre-inventory units 0)',
    (SELECT pre_inventory_units FROM order_items WHERE order_id = v_o) = 0,
    (SELECT pre_inventory_units FROM order_items WHERE order_id = v_o)::text);
  PERFORM admin_set_order_status(v_o, 'cancelled');
  PERFORM pg_temp.ck('4 Mode Off: cancelling again gives nothing back (stock still 0)',
    (SELECT stock_quantity FROM products WHERE id = v_keep) = 0);

  -- A product without Keep selling is still refused when short.
  UPDATE products SET keep_selling = false, stock_quantity = 5 WHERE id = v_keep;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o FROM place_order(jsonb_build_array(jsonb_build_object('product_id', v_keep, 'quantity', 1)),
    'B62 Keep', '01799970003', 'Dhaka', 'Dhaka', 'Gulshan', 'B62 road', 'inside_dhaka', 'cod');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_set_order_status(v_o, 'cancelled');
  UPDATE products SET stock_quantity = 0 WHERE id = v_keep;
  v_err := NULL;
  BEGIN
    PERFORM admin_reopen_order(v_o);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('4 Without Keep selling a short reopen is still refused', v_err LIKE 'Only 0 %', COALESCE(v_err, 'it ran'));
  PERFORM pg_temp.ck('4 Balance check unchanged (Mode Off)', abs(pg_temp.diff() - d0) < 0.01, pg_temp.diff()::text);

  -- ---------------------------------------------------------- 5. PAYOUTS
  PERFORM pg_temp.ck('5 No payout without parcel lines is marked synced',
    NOT EXISTS (SELECT 1 FROM steadfast_payouts p WHERE p.items_synced
                AND NOT EXISTS (SELECT 1 FROM steadfast_payout_items i WHERE i.payout_id = p.id)));

  PERFORM pg_temp.ck('9 Balance check difference at the end is still ৳0.00', abs(pg_temp.diff()) < 0.01, pg_temp.diff()::text);
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
