-- Batch 48 database tests (run by e2e/batch-48.spec.ts through the Supabase
-- command line). The runner puts the whole Batch 48 migration
-- (supabase/migration-049-batch48.sql, without its own BEGIN / COMMIT) in
-- front of this script, so everything — the migration, the throwaway
-- product, promo code and orders — runs inside ONE transaction that always
-- ends with ROLLBACK. No real order, setting or promo code is ever changed.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin   uuid;
  v_cust    uuid;
  c_admin   text;
  c_cust    text;
  v_tag     text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_prod    uuid;
  v_fee     numeric;
  v_cod     uuid;
  v_bk      uuid;
  v_ng      uuid;
  v_promo   uuid;
  v_o       uuid;
  v_used    integer;
  v_err     text;
  v_row     orders%ROWTYPE;
  v_int     integer;
  v_json    jsonb;
  v_items   jsonb;
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;

  -- ================================================ the migration itself
  PERFORM pg_temp.ck('Migration: the advance discount columns are on orders',
    (SELECT count(*) FROM information_schema.columns WHERE table_name = 'orders'
       AND column_name IN ('advance_discount', 'advance_discount_type', 'advance_discount_value')) = 3);
  PERFORM pg_temp.ck('Migration: every existing order has advance discount 0 (nothing old changed)',
    NOT EXISTS (SELECT 1 FROM orders WHERE advance_discount <> 0 OR advance_discount_type IS NOT NULL));
  PERFORM pg_temp.ck('Migration: the setting starts On, Percent, 0.5',
    (SELECT value FROM app_settings WHERE key = 'advance_discount_enabled') = 'true'
    AND (SELECT value FROM app_settings WHERE key = 'advance_discount_type') = 'percent'
    AND (SELECT value FROM app_settings WHERE key = 'advance_discount_value') = '0.5');
  PERFORM pg_temp.ck('Migration: a Nagad money account, and Nagad payments land in it (not Cash)',
    money_account_for_method('nagad') = (SELECT id FROM money_accounts WHERE payment_method = 'nagad' AND kind = 'nagad')
    AND money_account_for_method('nagad') <> money_account_for_method('cash')
    AND money_account_for_method('bkash') = (SELECT id FROM money_accounts WHERE payment_method = 'bkash'));
  PERFORM pg_temp.ck('Migration: nobody signed out can call the new functions',
    NOT has_function_privilege('anon', 'admin_set_order_payment_method(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'advance_discount_amount(text,numeric)', 'EXECUTE'));

  -- ================================================ setup (rolled back)
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  PERFORM set_config('inventory.test_mode', '', true);
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B48-' || v_tag, 'e2e-b48-' || v_tag, 'E2E B48 Serum', 1000, 'in_stock', 50, true) RETURNING id INTO v_prod;
  v_items := jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1));
  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE key = 'delivery_fee_inside_dhaka'), 80) INTO v_fee;

  -- ================================================ placing orders
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_cod FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
    'inside_dhaka', 'cod');
  SELECT * INTO v_row FROM orders WHERE id = v_cod;
  PERFORM pg_temp.ck('COD gets no advance discount',
    v_row.advance_discount = 0 AND v_row.discount = 0 AND v_row.total = 1000 + v_fee AND v_row.advance_discount_type IS NULL,
    format('discount %s, total %s', v_row.discount, v_row.total));

  SELECT order_id INTO v_bk FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
    'inside_dhaka', 'bkash', 'TRXB48', '01800000048');
  SELECT * INTO v_row FROM orders WHERE id = v_bk;
  PERFORM pg_temp.ck('bKash: 0.5% of ৳1,000 = ৳5 off the products, delivery not discounted',
    v_row.advance_discount = 5 AND v_row.discount = 5 AND v_row.total = 995 + v_fee
    AND v_row.advance_discount_type = 'percent' AND v_row.advance_discount_value = 0.5
    AND v_row.payment_status = 'pending_verification',
    format('advance %s, total %s', v_row.advance_discount, v_row.total));

  SELECT order_id INTO v_ng FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
    'inside_dhaka', 'nagad', 'TRXN48', '01900000048');
  SELECT * INTO v_row FROM orders WHERE id = v_ng;
  PERFORM pg_temp.ck('Nagad: saved as a Nagad order with its TrxID and sender, waiting for the check, same discount',
    v_row.payment_method = 'nagad' AND v_row.bkash_trx_id = 'TRXN48' AND v_row.bkash_sender = '01900000048'
    AND v_row.payment_status = 'pending_verification' AND v_row.advance_discount = 5 AND v_row.total = 995 + v_fee,
    format('%s %s %s', v_row.payment_method, v_row.payment_status, v_row.total));

  SELECT total::text INTO v_err FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
    'inside_dhaka', 'nagad', 'TRXN48B', '01900000048');
  PERFORM pg_temp.ck('place_order returns the saved total', v_err::numeric = 995 + v_fee, v_err);

  v_err := NULL;
  BEGIN
    PERFORM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road', 'inside_dhaka', 'nagad', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Nagad without a Transaction ID is refused', v_err = 'A Nagad Transaction ID is required for Nagad payment.', COALESCE(v_err, 'it ran'));

  -- Promo code first, then the advance discount; times_used counts the code once.
  INSERT INTO promo_codes (code, discount_type, discount_amount, active, max_uses, times_used)
  VALUES ('E2EB48' || v_tag, 'fixed', 100, true, NULL, 0) RETURNING id INTO v_promo;
  SELECT order_id INTO v_o FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
    'inside_dhaka', 'bkash', 'TRXP48', '01800000048', 'E2EB48' || v_tag);
  SELECT * INTO v_row FROM orders WHERE id = v_o;
  SELECT times_used INTO v_used FROM promo_codes WHERE id = v_promo;
  PERFORM pg_temp.ck('Promo + advance: ৳100 code, then 0.5% of ৳900 = ৳4.50 -> ৳5; both stack',
    v_row.discount = 105 AND v_row.advance_discount = 5 AND v_row.total = 1000 + v_fee - 105,
    format('discount %s, advance %s', v_row.discount, v_row.advance_discount));
  PERFORM pg_temp.ck('The advance discount never touches promo counting (times_used +1 for the code only)', v_used = 1, v_used::text);

  -- Fixed amount, and a fixed amount larger than the base.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  UPDATE app_settings SET value = 'fixed' WHERE key = 'advance_discount_type';
  UPDATE app_settings SET value = '50' WHERE key = 'advance_discount_value';
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
    'inside_dhaka', 'nagad', 'TRXF48', '01900000048');
  SELECT * INTO v_row FROM orders WHERE id = v_o;
  PERFORM pg_temp.ck('Fixed ৳50: ৳50 off, rule saved as fixed 50',
    v_row.advance_discount = 50 AND v_row.advance_discount_type = 'fixed' AND v_row.advance_discount_value = 50
    AND v_row.total = 950 + v_fee, v_row.total::text);
  UPDATE app_settings SET value = '5000' WHERE key = 'advance_discount_value';
  SELECT order_id INTO v_o FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
    'inside_dhaka', 'bkash', 'TRXX48', '01800000048');
  SELECT * INTO v_row FROM orders WHERE id = v_o;
  PERFORM pg_temp.ck('Fixed larger than the products: never more than the products (delivery still paid)',
    v_row.advance_discount = 1000 AND v_row.total = v_fee, v_row.total::text);

  -- Value 0, Off, and a broken value: nothing off, bKash still works.
  UPDATE app_settings SET value = '0' WHERE key = 'advance_discount_value';
  SELECT order_id INTO v_o FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
    'inside_dhaka', 'bkash', 'TRXZ48', '01800000048');
  PERFORM pg_temp.ck('Value 0: no discount, bKash still works', (SELECT advance_discount = 0 AND total = 1000 + v_fee FROM orders WHERE id = v_o));
  UPDATE app_settings SET value = 'percent' WHERE key = 'advance_discount_type';
  UPDATE app_settings SET value = '0.5' WHERE key = 'advance_discount_value';
  UPDATE app_settings SET value = 'false' WHERE key = 'advance_discount_enabled';
  SELECT order_id INTO v_o FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
    'inside_dhaka', 'nagad', 'TRXO48', '01900000048');
  PERFORM pg_temp.ck('Off: no discount, Nagad still works', (SELECT advance_discount = 0 AND total = 1000 + v_fee AND payment_method = 'nagad' FROM orders WHERE id = v_o));
  UPDATE app_settings SET value = 'true' WHERE key = 'advance_discount_enabled';
  UPDATE app_settings SET value = 'abc' WHERE key = 'advance_discount_value';
  v_err := NULL;
  BEGIN
    SELECT order_id INTO v_o FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
      'inside_dhaka', 'bkash', 'TRXA48', '01800000048');
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A broken setting value counts as Off (orders never fail over it)',
    v_err IS NULL AND (SELECT advance_discount = 0 FROM orders WHERE id = v_o), COALESCE(v_err, ''));
  UPDATE app_settings SET value = '0.5' WHERE key = 'advance_discount_value';

  -- Only the Super Admin can change the setting.
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', c_cust, true);
  UPDATE app_settings SET value = '99' WHERE key = 'advance_discount_value';
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('A customer cannot change the setting', (SELECT value FROM app_settings WHERE key = 'advance_discount_value') = '0.5');

  -- ================================================ money and profit
  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_json := order_profit(v_bk);
  PERFORM pg_temp.ck('Profit: the advance discount reduces the sale like a promo (৳1,000 − ৳5 = ৳995)',
    (v_json ->> 'sale')::numeric = 995, v_json ->> 'sale');

  -- Confirming a Nagad advance records a Nagad payment (lands in Nagad).
  UPDATE orders SET payment_status = 'paid' WHERE id = v_ng;
  PERFORM pg_temp.ck('Confirm received on a Nagad order: a Nagad payment with its TrxID',
    EXISTS (SELECT 1 FROM order_payments WHERE order_id = v_ng AND method = 'nagad' AND trx_id = 'TRXN48'
            AND amount = 995 + v_fee AND note = 'Nagad advance'));

  -- ================================================ Edit order: payment method
  v_err := NULL;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  BEGIN
    PERFORM admin_set_order_payment_method(v_bk, 'cod');
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A customer cannot change the payment method', v_err = 'Not authorized.', COALESCE(v_err, 'it ran'));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_set_order_payment_method(v_ng, 'bkash');
  SELECT * INTO v_row FROM orders WHERE id = v_ng;
  PERFORM pg_temp.ck('Nagad -> bKash keeps the discount, and the confirmed advance moves to the bKash wallet',
    v_row.payment_method = 'bkash' AND v_row.advance_discount = 5 AND v_row.total = 995 + v_fee
    AND EXISTS (SELECT 1 FROM order_payments WHERE order_id = v_ng AND method = 'bkash' AND source = 'status_paid')
    AND NOT EXISTS (SELECT 1 FROM order_payments WHERE order_id = v_ng AND method = 'nagad'));

  PERFORM admin_set_order_payment_method(v_bk, 'cod');
  SELECT * INTO v_row FROM orders WHERE id = v_bk;
  PERFORM pg_temp.ck('bKash -> Cash on Delivery removes the advance discount and the total goes up by it',
    v_row.payment_method = 'cod' AND v_row.advance_discount = 0 AND v_row.discount = 0 AND v_row.total = 1000 + v_fee
    AND v_row.advance_discount_type IS NULL AND v_row.payment_status = 'unpaid',
    format('%s discount %s total %s %s', v_row.payment_method, v_row.discount, v_row.total, v_row.payment_status));
  -- Staff-only history text is kept in order_history_private.
  SELECT count(*) INTO v_int
    FROM order_status_history h
    LEFT JOIN order_history_private p ON p.history_id = h.id
   WHERE h.order_id = v_bk
     AND (COALESCE(p.note, h.note) LIKE 'Payment method bKash → Cash on Delivery%'
          OR COALESCE(p.note, h.note) LIKE 'Advance payment discount%removed'
          OR COALESCE(p.note, h.note) LIKE 'Total %→%');
  PERFORM pg_temp.ck('… and the change is written in the order history', v_int >= 3, v_int::text);

  -- Edit order: the discount box (promo part) leaves the advance part alone.
  SELECT order_id INTO v_o FROM place_order(v_items, 'E2E B48', '01700000048', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
    'inside_dhaka', 'nagad', 'TRXE48', '01900000048');
  PERFORM admin_edit_order(v_o, jsonb_build_object('discount', 3));
  SELECT * INTO v_row FROM orders WHERE id = v_o;
  PERFORM pg_temp.ck('Edit order: a whole discount below the advance part keeps them consistent, no "reason" added',
    v_row.discount = 3 AND v_row.advance_discount = 3 AND v_row.discount_reason IS NULL,
    format('discount %s advance %s reason %s', v_row.discount, v_row.advance_discount, v_row.discount_reason));

  -- New order (admin): fully paid by Nagad is a Nagad order.
  SELECT order_id INTO v_o FROM admin_create_order_v2(
    p_source => 'facebook', p_items => v_items,
    p_full_name => 'E2E B48', p_phone => '01700000048', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 60,
    p_paid_amount => 1060, p_paid_method => 'nagad', p_paid_trx_id => 'TRXM48');
  PERFORM pg_temp.ck('New order fully paid by Nagad is saved as a Nagad order with its TrxID',
    (SELECT payment_method = 'nagad' AND bkash_trx_id = 'TRXM48' FROM orders WHERE id = v_o));
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
