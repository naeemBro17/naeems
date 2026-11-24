-- Batch 60: My Wallet (the store wallet), tested on the database.
--
-- SAFE ON THE LIVE DATABASE: everything runs inside ONE transaction that
-- ends with ROLLBACK, so nothing below is ever kept. Only MADE-UP rows are
-- added (products "B60 …", made-up phones 0179996xxxx, transaction IDs
-- "B60…"); no real row is changed. (Order alerts are only queued web
-- requests, sent after a COMMIT — a rolled-back order sends nothing.)
--
-- Needs migration-060 on the database. Before Naeem has run it, run the
-- migration in front of this file in the same transaction (drop the
-- migration's COMMIT and this file's BEGIN).
--
-- Run:  supabase db query --linked -f e2e/sql/batch-60.sql
-- Result: one row, a JSON list of { step, check, hand, site, ok, detail }.
-- After EVERY step the balance check (money_position) must still show the
-- same difference as before the test (৳0.00 on the live books).
BEGIN;

CREATE TEMP TABLE t_w (n serial, step text, chk text, hand numeric, site numeric, ok boolean, detail text) ON COMMIT DROP;
GRANT ALL ON t_w TO authenticated;
GRANT ALL ON SEQUENCE t_w_n_seq TO authenticated;

DO $wallet$
DECLARE
  v_admin  uuid := (SELECT id FROM profiles WHERE role = 'admin' AND status = 'approved' ORDER BY created_at, id LIMIT 1);
  c_admin  text;
  c_admin_pw text;
  v_cust   uuid := (SELECT u.id FROM auth.users u JOIN profiles p ON p.id = u.id
                    WHERE p.role = 'customer' AND lower(u.email) LIKE '%@naeems.test' ORDER BY u.created_at LIMIT 1);
  c_cust   text;
  k_cust   text;
  v_mod    uuid;
  v_tag    text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_today  date := inventory_dhaka_today();
  v_cash   uuid := money_account_for_method('cash');
  v_bkash  uuid := money_account_for_method('bkash');
  v_fee    numeric := COALESCE((SELECT value::numeric FROM app_settings WHERE key = 'delivery_fee_inside_dhaka'), 80);
  v_sup    uuid;
  v_pa     uuid;  -- ৳1,000
  v_p999   uuid;  -- products so the advance part is exactly ৳999 / ৳1,000
  v_p1000  uuid;
  v_pw1    uuid;
  v_pw2    uuid;
  v_lot    uuid;
  d0       numeric;
  v_req    jsonb;
  v_req2   jsonb;
  v_j      jsonb;
  v_id     uuid;
  v_oa     uuid;
  v_ob     uuid;
  v_oc     uuid;
  v_od     uuid;
  v_oe     uuid;
  v_n      numeric;
  v_m      numeric;
  v_b      boolean;
  v_txt    text;
  v_c0     numeric;
  v_k0     numeric;
  v_wall0  numeric;
  v_t0     timestamptz := now();
  v_adv0   numeric := (SELECT COALESCE(sum(advance_discount), 0) FROM orders);
  ph2 constant text := '0179996' || '0002';
  ph3 constant text := '0179996' || '0003';
  k2  constant text := 'ph:' || '0179996' || '0002';
  k3  constant text := 'ph:' || '0179996' || '0003';
BEGIN
  IF v_cust IS NULL THEN
    RAISE EXCEPTION 'The e2e test customer login (@naeems.test) was not found.';
  END IF;
  k_cust := 'p:' || v_cust;
  -- Batch 62: a request needs an open wallet (opened in this transaction only).
  IF to_regprocedure('store_wallet_open_key(text)') IS NOT NULL THEN
    EXECUTE 'SELECT store_wallet_open_key($1)' USING k_cust;
  END IF;
  c_admin :=json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2')::text;
  c_admin_pw := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2',
                  'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;
  PERFORM set_config('request.jwt.claims', c_admin, true);

  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_step text, p_chk text, p_hand numeric, p_site numeric, p_detail text DEFAULT '')
    RETURNS void LANGUAGE sql AS
    'INSERT INTO t_w (step, chk, hand, site, ok, detail) VALUES (p_step, p_chk, p_hand, p_site,
       p_site IS NOT NULL AND abs(p_hand - p_site) < 0.01, p_detail)'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.bal(p_account uuid) RETURNS numeric LANGUAGE sql AS
    'SELECT COALESCE(sum(amount), 0) FROM money_ledger WHERE account_id = p_account'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.diff() RETURNS numeric LANGUAGE sql AS
    'SELECT (money_position() ->> ''difference'')::numeric'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.due(p_order uuid) RETURNS numeric LANGUAGE sql AS
    'SELECT GREATEST(o.total - order_payment_net(o.id), 0) FROM orders o WHERE o.id = p_order'$f$;

  d0 := pg_temp.diff();
  PERFORM pg_temp.ck('0 Start', 'Balance check difference before the test (live books)', 0, d0);
  v_c0 := pg_temp.bal(v_cash);
  v_k0 := pg_temp.bal(v_bkash);
  v_wall0 := COALESCE((SELECT sum(amount) FROM store_wallet_entries), 0);

  -- ------------------------------------------------------------ SETUP
  PERFORM inventory_save_supplier('B60 Supplier ' || v_tag);
  SELECT id INTO v_sup FROM suppliers WHERE name = 'B60 Supplier ' || v_tag;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('B60-A-' || v_tag, 'b60-a-' || v_tag, 'B60 Cream', 1000, 'in_stock', 0, true) RETURNING id INTO v_pa;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('B60-999-' || v_tag, 'b60-999-' || v_tag, 'B60 Gel', 999 - v_fee, 'in_stock', 0, true) RETURNING id INTO v_p999;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('B60-1000-' || v_tag, 'b60-1000-' || v_tag, 'B60 Toner', 1000 - v_fee, 'in_stock', 0, true) RETURNING id INTO v_p1000;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('B60-W1-' || v_tag, 'b60-w1-' || v_tag, 'B60 Serum', 1500 - v_fee, 'in_stock', 0, true) RETURNING id INTO v_pw1;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('B60-W2-' || v_tag, 'b60-w2-' || v_tag, 'B60 Balm', 1429 - v_fee, 'in_stock', 0, true) RETURNING id INTO v_pw2;
  v_lot := inventory_save_lot(jsonb_build_object('source_type', 'local', 'country', 'Bangladesh', 'lot_date', v_today::text,
    'costs_pending', false, 'notes', 'B60 lot', 'supplier_id', v_sup,
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pa, 'qty', 40, 'unit_price_foreign', '500', 'expiry_date', '2028-06-01'),
      jsonb_build_object('product_id', v_p999, 'qty', 10, 'unit_price_foreign', '400', 'expiry_date', '2028-06-01'),
      jsonb_build_object('product_id', v_p1000, 'qty', 10, 'unit_price_foreign', '400', 'expiry_date', '2028-06-01'),
      jsonb_build_object('product_id', v_pw1, 'qty', 10, 'unit_price_foreign', '600', 'expiry_date', '2028-06-01'),
      jsonb_build_object('product_id', v_pw2, 'qty', 10, 'unit_price_foreign', '600', 'expiry_date', '2028-06-01'))));
  -- Inventory mode Off keeps the stock number by hand: give the products stock.
  UPDATE products SET stock_quantity = 40 WHERE id IN (v_pa, v_p999, v_p1000, v_pw1, v_pw2) AND NOT inventory_mode_on();
  PERFORM pg_temp.ck('0 Start', 'Setup keeps the balance check', d0, pg_temp.diff());

  -- No-login customers (Naeem adds money for them).
  SELECT order_id INTO v_od FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'B60 Karim', p_phone => ph2, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => v_fee);
  SELECT order_id INTO v_oe FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'B60 Karim', p_phone => ph2, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => v_fee);
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'B60 Karim other number', p_phone => ph3, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => v_fee);

  -- ------------------------------------------------------------ 1. REQUEST
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_req := store_wallet_request(3000, 'bkash', 'b60a' || v_tag, '01799960001');
  PERFORM pg_temp.ck('1 Request', 'Customer sends ৳3,000: request waiting', 1,
    CASE WHEN v_req ->> 'status' = 'waiting' THEN 1 ELSE 0 END, v_req::text);
  PERFORM pg_temp.ck('1 Request', 'Transaction ID saved in capitals', 1,
    CASE WHEN v_req ->> 'trx_id' = upper('B60A' || v_tag) THEN 1 ELSE 0 END);
  PERFORM pg_temp.ck('1 Request', 'Balance still ৳0 while it waits', 0, (store_wallet_my() ->> 'balance')::numeric);
  PERFORM pg_temp.ck('1 Request', 'My wallet shows 1 waiting request', 1, jsonb_array_length(store_wallet_my() -> 'waiting'));

  v_txt := NULL;
  BEGIN
    PERFORM store_wallet_request(499, 'bkash', 'B60B' || v_tag, '01799960001');
  EXCEPTION WHEN others THEN
    v_txt := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Request', '৳499 refused: "Minimum ৳500"', 1, CASE WHEN v_txt = 'Minimum ৳500' THEN 1 ELSE 0 END, v_txt);

  v_txt := NULL;
  BEGIN
    PERFORM store_wallet_request(1000, 'nagad', 'B60A' || v_tag, '01799960001');
  EXCEPTION WHEN others THEN
    v_txt := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Request', 'Same transaction ID again refused', 1,
    CASE WHEN v_txt = 'This transaction ID has already been used.' THEN 1 ELSE 0 END, v_txt);

  v_txt := NULL;
  BEGIN
    PERFORM store_wallet_request(1000, 'bkash', '  ', '01799960001');
  EXCEPTION WHEN others THEN
    v_txt := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Request', 'Empty transaction ID refused', 1, CASE WHEN v_txt = 'Transaction ID is required' THEN 1 ELSE 0 END, v_txt);

  v_txt := NULL;
  BEGIN
    PERFORM store_wallet_request(1000, 'bkash', 'AB-12!', '01799960001');
  EXCEPTION WHEN others THEN
    v_txt := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Request', 'Malformed transaction ID refused', 1, CASE WHEN v_txt IS NOT NULL THEN 1 ELSE 0 END, v_txt);

  v_txt := NULL;
  BEGIN
    PERFORM store_wallet_request(1000, 'bkash', 'B60C' || v_tag, '12345');
  EXCEPTION WHEN others THEN
    v_txt := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Request', 'Bad sender number refused', 1, CASE WHEN v_txt = 'Enter a valid number' THEN 1 ELSE 0 END, v_txt);

  -- A transaction ID already used on an order payment.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_add_order_payment(v_oe, 10, 'bkash', 'B60PAY' || v_tag, now(), 'b60', 'payment');
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_txt := NULL;
  BEGIN
    PERFORM store_wallet_request(1000, 'bkash', 'b60pay' || v_tag, '01799960001');
  EXCEPTION WHEN others THEN
    v_txt := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Request', 'Transaction ID of an order payment refused', 1,
    CASE WHEN v_txt = 'This transaction ID has already been used.' THEN 1 ELSE 0 END, v_txt);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  DELETE FROM order_payments WHERE order_id = v_oe;
  PERFORM order_payments_sync(v_oe);

  -- Who may confirm.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_b := false;
  BEGIN
    PERFORM store_wallet_confirm((v_req ->> 'id')::uuid, NULL);
    v_b := true;
  EXCEPTION WHEN others THEN
    v_b := false;
  END;
  PERFORM pg_temp.ck('1 Request', 'The customer can''t confirm their own request', 0, CASE WHEN v_b THEN 1 ELSE 0 END);
  v_mod := (SELECT p.id FROM profiles p JOIN staff_members s ON s.id = p.id
            WHERE p.role = 'moderator' AND p.status = 'approved' ORDER BY p.created_at LIMIT 1);
  IF v_mod IS NOT NULL THEN
    UPDATE staff_members SET is_disabled = false, role_id = NULL,
           permissions = ARRAY['view_orders', 'change_order_status', 'create_orders', 'edit_orders']
    WHERE id = v_mod;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mod, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    v_b := false;
    BEGIN
      PERFORM store_wallet_confirm((v_req ->> 'id')::uuid, NULL);
      v_b := true;
    EXCEPTION WHEN others THEN
      v_b := false;
    END;
    PERFORM pg_temp.ck('1 Request', 'Staff without money access can''t confirm', 0, CASE WHEN v_b THEN 1 ELSE 0 END);
  END IF;

  -- ------------------------------------------------------------ 2. CONFIRM / REJECT
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM pg_temp.ck('2 Confirm', 'Home sees the waiting request', 1,
    (SELECT count(*) FROM store_wallet_waiting() w WHERE w.id = (v_req ->> 'id')::uuid));
  v_j := store_wallet_confirm((v_req ->> 'id')::uuid, NULL);
  PERFORM pg_temp.ck('2 Confirm', 'Balance ৳3,000 after Confirm', 3000, store_wallet_balance(k_cust));
  PERFORM pg_temp.ck('2 Confirm', 'Money came into bKash (the default for bKash)', 3000, pg_temp.bal(v_bkash) - v_k0);
  PERFORM pg_temp.ck('2 Confirm', 'Customer wallets under To give +৳3,000', v_wall0 + 3000,
    (money_position() ->> 'to_give_wallets')::numeric);
  PERFORM pg_temp.ck('2 Confirm', 'Balance check unchanged', d0, pg_temp.diff());
  v_b := false;
  BEGIN
    PERFORM store_wallet_confirm((v_req ->> 'id')::uuid, NULL);
    v_b := true;
  EXCEPTION WHEN others THEN
    v_b := false;
  END;
  PERFORM pg_temp.ck('2 Confirm', 'Confirming twice is refused', 0, CASE WHEN v_b THEN 1 ELSE 0 END);

  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM pg_temp.ck('2 Confirm', 'Customer sees the confirmed answer once (for the toast)', 1,
    jsonb_array_length(store_wallet_my() -> 'results'));
  PERFORM store_wallet_seen((v_req ->> 'id')::uuid);
  PERFORM pg_temp.ck('2 Confirm', 'After it is seen it does not show again', 0, jsonb_array_length(store_wallet_my() -> 'results'));
  v_req2 := store_wallet_request(2000, 'nagad', 'B60R' || v_tag, '01799960001');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_n := pg_temp.bal(money_account_for_method('nagad'));
  PERFORM store_wallet_reject((v_req2 ->> 'id')::uuid, 'Not received');
  PERFORM pg_temp.ck('2 Reject', 'Reject: no money moves (Nagad unchanged)', v_n, pg_temp.bal(money_account_for_method('nagad')));
  PERFORM pg_temp.ck('2 Reject', 'Reject: balance still ৳3,000', 3000, store_wallet_balance(k_cust));
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM pg_temp.ck('2 Reject', 'Customer sees the rejected answer until dismissed', 1,
    (SELECT count(*) FROM jsonb_array_elements(store_wallet_my() -> 'results') x WHERE x ->> 'status' = 'rejected'));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM pg_temp.ck('2 Reject', 'Balance check unchanged', d0, pg_temp.diff());

  -- ------------------------------------------------------------ 3. ADMIN ADD
  v_j := store_wallet_add(k2, 2000, v_cash, v_today, 'Sent on WhatsApp');
  PERFORM pg_temp.ck('3 Add', 'Add to wallet ৳2,000 (no login): balance', 2000, store_wallet_balance(k2));
  PERFORM pg_temp.ck('3 Add', 'Cash +৳2,000', 2000, pg_temp.bal(v_cash) - v_c0);
  PERFORM pg_temp.ck('3 Add', 'Balance check unchanged', d0, pg_temp.diff());
  v_b := false;
  BEGIN
    PERFORM store_wallet_add(k2, 0, v_cash, v_today, NULL);
    v_b := true;
  EXCEPTION WHEN others THEN
    v_b := false;
  END;
  PERFORM pg_temp.ck('3 Add', '৳0 refused', 0, CASE WHEN v_b THEN 1 ELSE 0 END);
  v_b := false;
  BEGIN
    PERFORM store_wallet_add(k2, 100, money_steadfast_account(), v_today, NULL);
    v_b := true;
  EXCEPTION WHEN others THEN
    v_b := false;
  END;
  PERFORM pg_temp.ck('3 Add', 'Into "With Steadfast" refused', 0, CASE WHEN v_b THEN 1 ELSE 0 END);

  -- ------------------------------------------------------------ 4. USE AT CHECKOUT
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT x.order_id, x.store_wallet INTO v_oa, v_n FROM place_order_wallet(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'B60 Customer', p_phone => '01799960001', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod',
    p_store_wallet => 1000) x;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM pg_temp.ck('4 Use (part)', 'Order total ৳1,000 + delivery', 1000 + v_fee, (SELECT total FROM orders WHERE id = v_oa));
  PERFORM pg_temp.ck('4 Use (part)', 'place_order says ৳1,000 from the wallet', 1000, v_n);
  PERFORM pg_temp.ck('4 Use (part)', 'Due on the order = total − ৳1,000', v_fee, pg_temp.due(v_oa));
  PERFORM pg_temp.ck('4 Use (part)', 'Steadfast COD = what is left', v_fee, order_courier_cod(v_oa));
  PERFORM pg_temp.ck('4 Use (part)', 'Wallet ৳3,000 → ৳2,000', 2000, store_wallet_balance(k_cust));
  PERFORM pg_temp.ck('4 Use (part)', 'No account moved (bKash still +৳3,000, Cash still +৳2,000)', 5000,
    (pg_temp.bal(v_bkash) - v_k0) + (pg_temp.bal(v_cash) - v_c0));
  PERFORM pg_temp.ck('4 Use (part)', 'Order shows "Paid from wallet ৳1,000"', 1000,
    (SELECT from_wallet FROM store_wallet_order_paid(ARRAY[v_oa])));
  PERFORM pg_temp.ck('4 Use (part)', 'Payment status stays unpaid (COD part left)', 1,
    (SELECT count(*) FROM orders WHERE id = v_oa AND payment_status = 'unpaid'));
  PERFORM pg_temp.ck('4 Use (part)', 'Balance check unchanged', d0, pg_temp.diff());

  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_txt := NULL;
  BEGIN
    PERFORM place_order_wallet(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
      p_full_name => 'B60 Customer', p_phone => '01799960001', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod',
      p_store_wallet => 5000);
  EXCEPTION WHEN others THEN
    v_txt := SQLERRM;
  END;
  PERFORM pg_temp.ck('4 Use', 'Asking more than the balance: "Your wallet balance changed…"', 1,
    CASE WHEN v_txt = 'Your wallet balance changed. Please check and try again.' THEN 1 ELSE 0 END, v_txt);

  SELECT x.order_id INTO v_ob FROM place_order_wallet(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'B60 Customer', p_phone => '01799960001', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'bkash',
    p_bkash_trx_id => 'B60NOTNEEDED' || v_tag, p_bkash_sender => '01799960001', p_store_wallet => 1000 + v_fee) x;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM pg_temp.ck('4 Use (full)', 'Fully paid from the wallet: due ৳0', 0, pg_temp.due(v_ob));
  PERFORM pg_temp.ck('4 Use (full)', 'Fully paid: payment status paid', 1, (SELECT count(*) FROM orders WHERE id = v_ob AND payment_status = 'paid'));
  PERFORM pg_temp.ck('4 Use (full)', 'Fully paid: no bKash payment kept (method COD, no TrxID)', 1,
    (SELECT count(*) FROM orders WHERE id = v_ob AND payment_method = 'cod' AND bkash_trx_id IS NULL));
  PERFORM pg_temp.ck('4 Use (full)', 'Fully paid: no advance discount (wallet never earns it)', 0,
    (SELECT advance_discount FROM orders WHERE id = v_ob));
  PERFORM pg_temp.ck('4 Use (full)', 'Fully paid: Steadfast COD ৳0', 0, order_courier_cod(v_ob));
  PERFORM pg_temp.ck('4 Use (full)', 'Wallet ৳2,000 − ৳' || (1000 + v_fee), 930, store_wallet_balance(k_cust));
  PERFORM pg_temp.ck('4 Use (full)', 'Balance check unchanged', d0, pg_temp.diff());

  -- ------------------------------------------------------------ 5. GIVEN BACK
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM cancel_order(v_oa, 'b60 cancel');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM pg_temp.ck('5 Cancel', 'Cancelled: the ৳1,000 wallet part goes back', 1930, store_wallet_balance(k_cust));
  PERFORM pg_temp.ck('5 Cancel', 'Cancelled: entry "order_back" +৳1,000', 1000,
    (SELECT sum(amount) FROM store_wallet_entries WHERE order_id = v_oa AND kind = 'order_back'));
  PERFORM pg_temp.ck('5 Cancel', 'Cancelled: the order owes nothing and holds nothing', 0, order_payment_net(v_oa));
  PERFORM pg_temp.ck('5 Cancel', 'Cancelled: no cash moved', 5000, (pg_temp.bal(v_bkash) - v_k0) + (pg_temp.bal(v_cash) - v_c0));
  PERFORM pg_temp.ck('5 Cancel', 'Balance check unchanged', d0, pg_temp.diff());

  PERFORM admin_set_order_status(v_ob, 'confirmed', 'b60');
  PERFORM admin_set_order_status(v_ob, 'shipped', 'b60');
  PERFORM admin_mark_order_returned(v_ob, 'b60 returned');
  PERFORM pg_temp.ck('5 Return', 'Returned: the whole ৳' || (1000 + v_fee) || ' goes back', 3000,
    store_wallet_balance(k_cust));
  PERFORM pg_temp.ck('5 Return', 'Balance check unchanged', d0, pg_temp.diff());

  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT x.order_id INTO v_oc FROM place_order_wallet(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'B60 Customer', p_phone => '01799960001', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod',
    p_store_wallet => 1000 + v_fee) x;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_update_order_delivery_fee(v_oc, 0, 'b60 free delivery');
  PERFORM pg_temp.ck('5 Edit down', 'Edited down by the delivery fee: it goes back', v_fee,
    (SELECT sum(amount) FROM store_wallet_entries WHERE order_id = v_oc AND kind = 'order_back'));
  PERFORM pg_temp.ck('5 Edit down', 'Wallet after: ৳3,000 − the order + the delivery fee back', 2000, store_wallet_balance(k_cust));
  PERFORM pg_temp.ck('5 Edit down', 'The order is still fully paid', 0, pg_temp.due(v_oc));
  PERFORM pg_temp.ck('5 Edit down', 'Balance check unchanged', d0, pg_temp.diff());
  PERFORM admin_update_order_delivery_fee(v_oc, v_fee, 'b60 delivery back');
  PERFORM pg_temp.ck('5 Edit up', 'Edited up again: taken back from the wallet', 1930, store_wallet_balance(k_cust));
  PERFORM pg_temp.ck('5 Edit up', 'The order is fully paid again', 0, pg_temp.due(v_oc));
  PERFORM pg_temp.ck('5 Edit up', 'Balance check unchanged', d0, pg_temp.diff());

  -- ------------------------------------------------------------ 6. OVERPAID
  v_c0 := pg_temp.bal(v_cash);
  PERFORM admin_add_order_payment(v_od, 1200 + v_fee, 'cash', NULL, now(), 'b60 paid more', 'payment');
  PERFORM pg_temp.ck('6 Overpaid', '৳200 paid above the total goes to the wallet', 200,
    (SELECT sum(amount) FROM store_wallet_entries WHERE order_id = v_od AND kind = 'overpaid'));
  PERFORM pg_temp.ck('6 Overpaid', 'Cash got all of it', 1200 + v_fee, pg_temp.bal(v_cash) - v_c0);
  PERFORM pg_temp.ck('6 Overpaid', 'Wallet ৳2,000 + ৳200', 2200, store_wallet_balance(k2));
  PERFORM pg_temp.ck('6 Overpaid', 'No "credit" left (Batch 58''s credit is the wallet now)', 0,
    COALESCE((SELECT credit FROM money_customer_dues() WHERE customer_key = k2), 0));
  PERFORM pg_temp.ck('6 Overpaid', 'Balance check unchanged', d0, pg_temp.diff());
  PERFORM admin_add_order_payment(v_od, 200, 'cash', NULL, now(), 'b60 refund the extra', 'refund');
  PERFORM pg_temp.ck('6 Overpaid', 'Refund of the extra: taken back out of the wallet', 2000, store_wallet_balance(k2));
  PERFORM pg_temp.ck('6 Overpaid', 'Balance check unchanged', d0, pg_temp.diff());

  -- ------------------------------------------------------------ 7. ADMIN USE / DELETE
  v_n := store_wallet_use(v_oe, 500);
  PERFORM pg_temp.ck('7 Admin use', 'Use wallet balance on an admin order: ৳500 taken', 500, v_n);
  PERFORM pg_temp.ck('7 Admin use', 'Due goes down by ৳500', 500 + v_fee, pg_temp.due(v_oe));
  PERFORM pg_temp.ck('7 Admin use', 'Steadfast COD = what is left', 500 + v_fee, order_courier_cod(v_oe));
  PERFORM pg_temp.ck('7 Admin use', 'Wallet ৳1,500', 1500, store_wallet_balance(k2));
  PERFORM pg_temp.ck('7 Admin use', 'Balance check unchanged', d0, pg_temp.diff());
  v_b := false;
  BEGIN
    PERFORM admin_update_order_payment((SELECT id FROM order_payments WHERE order_id = v_oe AND method = 'store_wallet' LIMIT 1),
      100, 'cash', NULL, now(), NULL);
    v_b := true;
  EXCEPTION WHEN others THEN
    v_b := false;
  END;
  PERFORM pg_temp.ck('7 Admin use', 'A wallet payment can''t be edited into cash', 0, CASE WHEN v_b THEN 1 ELSE 0 END);
  DELETE FROM admin_safety_locks WHERE user_id = v_admin;
  INSERT INTO admin_safety_locks (user_id, delete_any_until, opened_at) VALUES (v_admin, now() + interval '1 hour', now());
  SELECT x.deleted INTO v_b FROM admin_delete_orders(ARRAY[v_oe]) x;
  PERFORM pg_temp.ck('7 Delete', 'Order deleted (Super Admin + Safety Lock)', 1, CASE WHEN v_b THEN 1 ELSE 0 END);
  PERFORM pg_temp.ck('7 Delete', 'Deleted: the ৳500 goes back to the wallet', 2000, store_wallet_balance(k2));
  PERFORM pg_temp.ck('7 Delete', 'Balance check unchanged', d0, pg_temp.diff());

  -- ------------------------------------------------------------ 8. MERGE
  PERFORM store_wallet_add(k3, 500, v_cash, v_today, 'b60 other number');
  v_n := COALESCE((SELECT sum(amount) FROM store_wallet_entries), 0);
  PERFORM admin_merge_customers(k2, k3);
  PERFORM pg_temp.ck('8 Merge', 'Merged: the kept customer has both wallets', 2500, store_wallet_balance(k2));
  PERFORM pg_temp.ck('8 Merge', 'Merged: all wallets together unchanged', v_n, COALESCE((SELECT sum(amount) FROM store_wallet_entries), 0));
  PERFORM pg_temp.ck('8 Merge', 'Balance check unchanged', d0, pg_temp.diff());

  -- ------------------------------------------------------------ 9. CORRECT
  v_b := false;
  BEGIN
    PERFORM store_wallet_correct(k2, 100, 'b60 typo');
    v_b := true;
  EXCEPTION WHEN others THEN
    v_b := false;
  END;
  PERFORM pg_temp.ck('9 Correct', 'Without the password typed again: refused', 0, CASE WHEN v_b THEN 1 ELSE 0 END);
  PERFORM set_config('request.jwt.claims', c_admin_pw, true);
  v_b := false;
  BEGIN
    PERFORM store_wallet_correct(k2, 100, '  ');
    v_b := true;
  EXCEPTION WHEN others THEN
    v_b := false;
  END;
  PERFORM pg_temp.ck('9 Correct', 'Without a note: refused', 0, CASE WHEN v_b THEN 1 ELSE 0 END);
  PERFORM store_wallet_correct(k2, 2400, 'b60 counted again');
  PERFORM pg_temp.ck('9 Correct', 'Corrected to ৳2,400', 2400, store_wallet_balance(k2));
  PERFORM pg_temp.ck('9 Correct', 'Balance check unchanged (correction counted, no money moved)', d0, pg_temp.diff());
  PERFORM set_config('request.jwt.claims', c_admin, true);

  -- ------------------------------------------------------------ 10. ADVANCE DISCOUNT ৳1,000 RULE
  -- (the live setting is used as it is; checks only run when it is On)
  IF (SELECT advance_discount_amount('bkash', 1000) LIMIT 1) IS NOT NULL
     AND (SELECT a.amount FROM advance_discount_amount('bkash', 1000) a) > 0 THEN
    PERFORM set_config('request.jwt.claims', c_cust, true);
    SELECT x.order_id INTO v_id FROM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_p999, 'quantity', 1)),
      p_full_name => 'B60 Customer', p_phone => '01799960001', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'bkash',
      p_bkash_trx_id => 'B60ADV1' || v_tag, p_bkash_sender => '01799960001') x;
    PERFORM pg_temp.ck('10 Advance', '৳999 paid in advance: no discount', 0, (SELECT advance_discount FROM orders WHERE id = v_id));
    SELECT x.order_id INTO v_id FROM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_p1000, 'quantity', 1)),
      p_full_name => 'B60 Customer', p_phone => '01799960001', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'bkash',
      p_bkash_trx_id => 'B60ADV2' || v_tag, p_bkash_sender => '01799960001') x;
    PERFORM pg_temp.ck('10 Advance', '৳1,000 paid in advance: the discount', (SELECT a.amount FROM advance_discount_amount('bkash', 1000 - v_fee) a),
      (SELECT advance_discount FROM orders WHERE id = v_id));
    -- Wallet ৳500 + bKash: ৳1,500 − ৳500 = ৳1,000 left → discount.
    SELECT x.order_id INTO v_id FROM place_order_wallet(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_pw1, 'quantity', 1)),
      p_full_name => 'B60 Customer', p_phone => '01799960001', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'bkash',
      p_bkash_trx_id => 'B60ADV3' || v_tag, p_bkash_sender => '01799960001', p_store_wallet => 500) x;
    PERFORM pg_temp.ck('10 Advance', 'Wallet ৳500 + ৳1,000 in advance: discount on the ৳1,000 part only',
      (SELECT a.amount FROM advance_discount_amount('bkash', 1000) a), (SELECT advance_discount FROM orders WHERE id = v_id));
    PERFORM pg_temp.ck('10 Advance', 'Still waiting for the bKash check (pending verification)', 1,
      (SELECT count(*) FROM orders WHERE id = v_id AND payment_status = 'pending_verification'));
    -- Wallet ৳430 + bKash: ৳1,429 − ৳430 = ৳999 left → none.
    SELECT x.order_id INTO v_id FROM place_order_wallet(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_pw2, 'quantity', 1)),
      p_full_name => 'B60 Customer', p_phone => '01799960001', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'B60 road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'bkash',
      p_bkash_trx_id => 'B60ADV4' || v_tag, p_bkash_sender => '01799960001', p_store_wallet => 430) x;
    PERFORM pg_temp.ck('10 Advance', 'Wallet ৳430 + ৳999 in advance: no discount', 0, (SELECT advance_discount FROM orders WHERE id = v_id));
    PERFORM set_config('request.jwt.claims', c_admin, true);
    -- Marking the advance paid records only the rest (wallet part stays).
    UPDATE orders SET payment_status = 'paid' WHERE id = v_id;
    PERFORM pg_temp.ck('10 Advance', 'bKash marked paid: recorded only the ৳999 left', 999,
      (SELECT sum(amount) FROM order_payments WHERE order_id = v_id AND method = 'bkash'));
    PERFORM pg_temp.ck('10 Advance', 'Balance check unchanged', d0, pg_temp.diff());
  ELSE
    PERFORM pg_temp.ck('10 Advance', 'Advance discount is Off on the live shop (checks skipped)', 1, 1);
  END IF;
  PERFORM pg_temp.ck('10 Advance', 'Old orders keep their discount (none recalculated)', v_adv0,
    (SELECT COALESCE(sum(advance_discount), 0) FROM orders WHERE created_at < v_t0));
END
$wallet$;

-- ------------------------------------------------------------ 11. RLS
-- As the signed-in customer (the "authenticated" role, like the website).
DO $rls$
DECLARE
  v_cust uuid := (SELECT u.id FROM auth.users u JOIN profiles p ON p.id = u.id
                  WHERE p.role = 'customer' AND lower(u.email) LIKE '%@naeems.test' ORDER BY u.created_at LIMIT 1);
  v_own   bigint;
  v_other bigint;
  v_err1  text;
  v_err2  text;
  v_err3  text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_own FROM store_wallet_entries;
  SELECT count(*) INTO v_other FROM store_wallet_entries WHERE customer_key <> 'p:' || v_cust;
  BEGIN
    INSERT INTO store_wallet_entries (customer_key, amount, kind, entry_date) VALUES ('p:' || v_cust, 1000, 'correction', current_date);
  EXCEPTION WHEN others THEN
    v_err1 := SQLERRM;
  END;
  BEGIN
    INSERT INTO store_wallet_requests (customer_key, profile_id, amount, method, trx_id, sender, status)
    VALUES ('p:' || v_cust, v_cust, 1000, 'bkash', 'B60RLS' || to_char(clock_timestamp(), 'MISSMS'), '01799960001', 'confirmed');
  EXCEPTION WHEN others THEN
    v_err2 := SQLERRM;
  END;
  BEGIN
    UPDATE store_wallet_requests SET status = 'confirmed' WHERE profile_id = v_cust;
    GET DIAGNOSTICS v_other = ROW_COUNT;
    IF v_other = 0 THEN
      v_err3 := 'no rows changed';
    END IF;
  EXCEPTION WHEN others THEN
    v_err3 := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  INSERT INTO t_w (step, chk, hand, site, ok, detail) VALUES
    ('11 Security', 'The customer reads their own wallet rows', 1, v_own, v_own > 0, ''),
    ('11 Security', 'The customer can''t write wallet rows', 1, CASE WHEN v_err1 IS NOT NULL THEN 1 ELSE 0 END, v_err1 IS NOT NULL, COALESCE(v_err1, '')),
    ('11 Security', 'The customer can''t send an already-confirmed request', 1, CASE WHEN v_err2 IS NOT NULL THEN 1 ELSE 0 END, v_err2 IS NOT NULL, COALESCE(v_err2, '')),
    ('11 Security', 'The customer can''t confirm by changing a request', 1, CASE WHEN v_err3 IS NOT NULL THEN 1 ELSE 0 END, v_err3 IS NOT NULL, COALESCE(v_err3, ''));
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_other FROM store_wallet_entries WHERE customer_key LIKE 'ph:0179996%';
  EXECUTE 'RESET ROLE';
  INSERT INTO t_w (step, chk, hand, site, ok, detail) VALUES
    ('11 Security', 'The customer can''t read another customer''s wallet', 0, v_other, v_other = 0, '');
END
$rls$;

SELECT json_agg(json_build_object('step', step, 'check', chk, 'hand', hand, 'site', site, 'ok', ok, 'detail', detail) ORDER BY n)::text AS wallet
FROM t_w;
ROLLBACK;
