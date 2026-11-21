-- Batch 55 database tests (run by e2e/batch-55.spec.ts through the Supabase
-- command line). The runner puts the whole Batch 55 migration
-- (supabase/migration-056-batch55.sql, without its own BEGIN / COMMIT) in
-- front of this script, and the one-time fix
-- (supabase/fix-batch55-nabila-nur.sql, its DO block, pointed at the test
-- customer login) where the NABILA_FIX marker stands. Everything — the made-up
-- customers, orders, dues, bills, the merge and the fix — runs inside ONE
-- transaction that always ends with ROLLBACK. Nothing real is changed.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin   uuid;
  v_cust    uuid;
  c_admin   text;
  c_cust    text;
  v_acc     uuid;
  v_imp     uuid;
  v_bill    uuid;
  v_od      uuid;
  v_dp      uuid;
  v_pc      uuid;
  v_rem     uuid;
  v_oa      uuid;
  v_ob      uuid;
  v_ox      uuid;
  v_err     text;
  v_json    jsonb;
  v_t0      jsonb;
  v_dues0   numeric;
  v_rep0    numeric;
  v_net0    numeric;
  v_moved   jsonb;
  -- Made-up numbers (no such phones on the shop).
  c_a   constant text := '01799955101';
  c_b   constant text := '01799955102';
  c_b2  constant text := '01799955103';
  c_x   constant text := '01799955104';
  c_g   constant text := '01799955105';
  c_f   constant text := '01799955106';
  c_m   constant text := '01799955107';
  k_a   constant text := 'ph:01799955101';
  k_b   constant text := 'ph:01799955102';
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.new_order(p_tag text, p_name text, p_phone text, p_total numeric, p_customer uuid DEFAULT NULL) RETURNS uuid
    LANGUAGE sql AS $s$
      INSERT INTO orders (order_number, customer_name, customer_phone, division, district, thana, address_line, delivery_zone,
                          delivery_fee, subtotal, total, payment_method, payment_status, status, source, customer_id)
      VALUES ('E2E-B55-' || p_tag, p_name, p_phone, 'Dhaka', 'Dhaka', 'Mirpur', 'Test road 55', 'inside_dhaka',
              0, p_total, p_total, 'cod', 'unpaid', 'confirmed', 'web', p_customer)
      RETURNING id $s$$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;
  SELECT id INTO v_acc FROM money_accounts ORDER BY created_at LIMIT 1;

  -- ================================================ the migration itself
  PERFORM pg_temp.ck('Migration: customer_phones and customer_merges exist, RLS on',
    to_regclass('public.customer_phones') IS NOT NULL AND to_regclass('public.customer_merges') IS NOT NULL
    AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.customer_phones'::regclass)
    AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.customer_merges'::regclass));
  PERFORM pg_temp.ck('Nobody writes customer_phones / customer_merges directly',
    NOT has_table_privilege('authenticated', 'customer_phones', 'INSERT') AND NOT has_table_privilege('authenticated', 'customer_phones', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'customer_merges', 'INSERT') AND NOT has_table_privilege('anon', 'customer_phones', 'SELECT'));
  PERFORM pg_temp.ck('Anonymous visitors cannot call the new functions; the helpers are never called from the browser',
    NOT has_function_privilege('anon', 'admin_merge_customers(text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'admin_add_customer_number(text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'customer_money_totals()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'customer_phone_owner(text)', 'EXECUTE'));

  -- ================================================ made-up customers
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_add_customer('E2E B55 Keep', c_a);
  PERFORM admin_add_customer('E2E B55 Remove', c_b, NULL, NULL, NULL, NULL, NULL, 'Old note from B');
  v_oa := pg_temp.new_order('A1', 'E2E B55 Keep', c_a, 1000);
  v_ob := pg_temp.new_order('B1', 'E2E B55 Remove', c_b, 500);
  v_t0 := customer_money_totals();

  -- ================================================ extra numbers
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM admin_customer_numbers(k_a);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A customer login cannot read numbers', v_err = 'Only the Super Admin can do this.', COALESCE(v_err, 'no error'));
  v_err := NULL;
  BEGIN
    PERFORM admin_add_customer_number(k_a, c_x);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('… nor add one', v_err = 'Only the Super Admin can do this.', COALESCE(v_err, 'no error'));
  PERFORM set_config('request.jwt.claims', c_admin, true);

  v_json := admin_add_customer_number(k_a, '+880 1799-955104');
  PERFORM pg_temp.ck('Add a free number', (v_json ->> 'added')::boolean, v_json::text);
  v_json := admin_customer_numbers(k_a);
  PERFORM pg_temp.ck('The list: main number first, then the extra one (source added, can be removed)',
    jsonb_array_length(v_json) = 2 AND (v_json -> 0 ->> 'phone_key') = c_a AND (v_json -> 0 ->> 'is_main')::boolean
    AND (v_json -> 1 ->> 'phone_key') = c_x AND (v_json -> 1 ->> 'source') = 'added' AND (v_json -> 1 ->> 'can_remove')::boolean, v_json::text);
  PERFORM pg_temp.ck('… and one activity line', EXISTS (SELECT 1 FROM activity_log WHERE action = 'customer.number_added'
    AND summary = 'Added 01799955104 to E2E B55 Keep'));

  v_ox := pg_temp.new_order('X1', 'Someone typed', c_x, 200);
  PERFORM pg_temp.ck('An order on the extra number groups under its owner',
    (SELECT customer_key FROM order_customer_keys() WHERE order_id = v_ox) = k_a);
  PERFORM pg_temp.ck('… and the owner keeps its own name and number on the list',
    EXISTS (SELECT 1 FROM admin_customers_v3() WHERE customer_key = k_a AND full_name = 'E2E B55 Keep' AND phone = c_a AND order_count = 2));
  PERFORM pg_temp.ck('money_customer_key_for_phone and admin_add_customer agree',
    money_customer_key_for_phone(c_x) = k_a
    AND (SELECT customer_key FROM admin_add_customer('Other name', c_x)) = k_a);

  v_err := NULL;
  BEGIN
    PERFORM admin_remove_customer_number(k_a, c_x);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A number with orders cannot be removed', v_err = 'Orders, dues or Kaarbar bills use this number, so it can''t be removed.', COALESCE(v_err, 'no error'));

  v_json := admin_add_customer_number(k_a, c_m);
  INSERT INTO customer_due_reminders (customer_key, phone_key, amount, how) VALUES (k_a, c_m, 10, 'copied');
  v_err := NULL;
  BEGIN
    PERFORM admin_remove_customer_number(k_a, c_m);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A number with money rows cannot be removed', v_err LIKE 'Orders, dues or Kaarbar bills use this number%', COALESCE(v_err, 'no error'));

  v_json := admin_add_customer_number(k_a, c_f);
  v_json := admin_remove_customer_number(k_a, c_f);
  PERFORM pg_temp.ck('A number nothing uses can be removed', (v_json ->> 'removed')::boolean
    AND NOT EXISTS (SELECT 1 FROM customer_phones WHERE phone_key = c_f)
    AND EXISTS (SELECT 1 FROM activity_log WHERE action = 'customer.number_removed' AND summary = 'Removed 01799955106 from E2E B55 Keep'));

  v_json := admin_add_customer_number(k_a, c_b);
  PERFORM pg_temp.ck('Refused: someone''s main number (says whose, with their orders)',
    NOT (v_json ->> 'added')::boolean AND (v_json ->> 'owner_key') = k_b AND (v_json ->> 'owner_name') = 'E2E B55 Remove'
    AND (v_json ->> 'owner_orders')::int = 1 AND NOT EXISTS (SELECT 1 FROM customer_phones WHERE phone_key = c_b), v_json::text);
  v_json := admin_add_customer_number(k_b, c_b2, 'kaarbar');
  v_json := admin_add_customer_number(k_a, c_b2);
  PERFORM pg_temp.ck('Refused: someone''s extra number', NOT (v_json ->> 'added')::boolean AND (v_json ->> 'owner_key') = k_b, v_json::text);
  PERFORM pg_temp.ck('… the Kaarbar number is saved with source kaarbar',
    (SELECT source FROM customer_phones WHERE phone_key = c_b2) = 'kaarbar');
  PERFORM pg_temp.new_order('G1', 'Only orders', c_g, 100);
  v_json := admin_add_customer_number(k_a, c_g);
  PERFORM pg_temp.ck('Refused: a number that is a ph: order group', NOT (v_json ->> 'added')::boolean AND (v_json ->> 'owner_key') = 'ph:' || c_g, v_json::text);
  v_json := admin_add_customer_number(k_a, c_a);
  PERFORM pg_temp.ck('Its own main number: "same"', (v_json ->> 'same')::boolean, v_json::text);
  v_err := NULL;
  BEGIN
    PERFORM admin_add_customer_number(k_a, '01234');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A wrong number is refused in plain English', v_err = 'Enter a valid Bangladeshi mobile number (01XXXXXXXXX).', COALESCE(v_err, 'no error'));

  -- ================================================ merge: set up B's money
  INSERT INTO customer_opening_dues (phone_key, full_name, phone, amount) VALUES (c_b, 'E2E B55 Remove', c_b, 300) RETURNING id INTO v_od;
  INSERT INTO customer_due_payments (phone_key, amount, account_id, paid_date) VALUES (c_b, 100, v_acc, current_date) RETURNING id INTO v_dp;
  INSERT INTO customer_previous_corrections (phone_key, amount_change, old_amount, new_amount) VALUES (c_b, 50, 200, 250) RETURNING id INTO v_pc;
  INSERT INTO customer_due_reminders (customer_key, phone_key, amount, how) VALUES (k_b, c_b, 750, 'whatsapp') RETURNING id INTO v_rem;
  INSERT INTO kaarbar_imports (kind, customer_key) VALUES ('merge', k_b) RETURNING id INTO v_imp;
  INSERT INTO kaarbar_bills (kind, bill_no, bill_date, customer_key, phone_key, party_name, items_total, bill_discount, delivery, bill_total, import_id)
  VALUES ('sale', 'E2E55-1', DATE '2026-08-01', k_b, c_b, 'E2E B55 Remove', 400, 0, 0, 400, v_imp) RETURNING id INTO v_bill;

  -- ================================================ merge: refused cases
  INSERT INTO customers (customer_key, full_name, added_by_hand) VALUES ('n:e2e b55 no phone', 'E2E B55 No Phone', true);
  v_err := NULL;
  BEGIN
    PERFORM admin_merge_preview(k_a, 'p:' || v_cust);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Merge refused: the picked customer has a login', v_err = 'Has a login. Open it and merge this customer into it.', COALESCE(v_err, 'no error'));
  v_err := NULL;
  BEGIN
    PERFORM admin_merge_customers(k_a, 'n:e2e b55 no phone');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Merge refused: the picked customer has no phone', v_err = 'No phone number, so it can''t be merged.', COALESCE(v_err, 'no error'));
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM admin_merge_customers(k_a, k_b);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Merge refused for a customer login', v_err = 'Only the Super Admin can do this.', COALESCE(v_err, 'no error'));
  PERFORM set_config('request.jwt.claims', c_admin, true);

  -- ================================================ merge: preview
  v_json := admin_merge_preview(k_a, k_b);
  PERFORM pg_temp.ck('Preview: both sides'' orders, due, previous balance and bills',
    (v_json -> 'keep' ->> 'orders')::int = 2 AND (v_json -> 'keep' ->> 'due')::numeric = 1200
    AND (v_json -> 'keep' ->> 'bills')::int = 0
    AND (v_json -> 'remove' ->> 'orders')::int = 1 AND (v_json -> 'remove' ->> 'due')::numeric = 500
    AND (v_json -> 'remove' ->> 'previous')::numeric = 250 AND (v_json -> 'remove' ->> 'bills')::int = 1
    AND (v_json -> 'after' ->> 'orders')::int = 3 AND (v_json -> 'after' ->> 'due')::numeric = 1950, v_json::text);

  -- ================================================ merge: the money never changes
  -- A locked month must not stop a merge (only who the rows belong to
  -- changes). The month of the money start date: it locks the opening
  -- balances too.
  INSERT INTO money_month_locks (month, locked)
  VALUES (date_trunc('month', COALESCE(money_start_date(), current_date))::date, true)
  ON CONFLICT (month) DO UPDATE SET locked = true;
  v_t0 := customer_money_totals();
  SELECT COALESCE(sum(order_due + previous_left), 0) INTO v_dues0 FROM money_customer_dues();
  SELECT COALESCE(sum((d ->> 'total')::numeric), 0) INTO v_rep0 FROM jsonb_array_elements(report_customers(current_date - 400, current_date) -> 'dues') d;
  v_net0 := (money_position() ->> 'net_worth')::numeric;

  v_json := admin_merge_customers(k_a, k_b);
  PERFORM pg_temp.ck('Merge runs (with a month locked)', (v_json ->> 'moved')::int > 0, v_json::text);

  PERFORM pg_temp.ck('Total of all customers'' dues: exactly the same',
    (SELECT COALESCE(sum(order_due + previous_left), 0) FROM money_customer_dues()) = v_dues0);
  PERFORM pg_temp.ck('Previous balances, order dues, to receive and net worth: exactly the same',
    customer_money_totals() = v_t0 AND (money_position() ->> 'net_worth')::numeric = v_net0, customer_money_totals()::text || ' vs ' || v_t0::text);
  PERFORM pg_temp.ck('The customers report''s dues total: exactly the same',
    (SELECT COALESCE(sum((d ->> 'total')::numeric), 0) FROM jsonb_array_elements(report_customers(current_date - 400, current_date) -> 'dues') d) = v_rep0);

  -- ================================================ merge: the kept customer has all of it
  PERFORM pg_temp.ck('Both numbers of the removed customer are the kept one''s old numbers',
    (SELECT count(*) FROM customer_phones WHERE customer_key = k_a AND source = 'merge' AND phone_key IN (c_b, c_b2)) = 2);
  PERFORM pg_temp.ck('The removed customer''s order now groups under the kept one (the order itself is not edited)',
    (SELECT customer_key FROM order_customer_keys() WHERE order_id = v_ob) = k_a
    AND (SELECT customer_phone FROM orders WHERE id = v_ob) = c_b AND (SELECT customer_name FROM orders WHERE id = v_ob) = 'E2E B55 Remove');
  PERFORM pg_temp.ck('Opening due, payment and correction are on the kept main number',
    (SELECT phone_key FROM customer_opening_dues WHERE id = v_od) = c_a
    AND (SELECT phone_key FROM customer_due_payments WHERE id = v_dp) = c_a
    AND (SELECT phone_key FROM customer_previous_corrections WHERE id = v_pc) = c_a
    AND (SELECT amount FROM customer_opening_dues WHERE id = v_od) = 300);
  PERFORM pg_temp.ck('The reminder, the Kaarbar bill and its merge belong to the kept customer',
    (SELECT customer_key || '/' || phone_key FROM customer_due_reminders WHERE id = v_rem) = k_a || '/' || c_a
    AND (SELECT customer_key || '/' || phone_key FROM kaarbar_bills WHERE id = v_bill) = k_a || '/' || c_a
    AND (SELECT customer_key FROM kaarbar_imports WHERE id = v_imp) = k_a);
  PERFORM pg_temp.ck('The kept customer''s page shows it: one dues row (orders 1,700 + previous 250), its old bill',
    (SELECT count(*) FROM money_customer_dues() WHERE customer_key = k_a) = 1
    AND (SELECT order_due FROM money_customer_dues() WHERE customer_key = k_a) = 1700
    AND (SELECT previous_left FROM money_customer_dues() WHERE customer_key = k_a) = 250
    AND (SELECT phone_key FROM money_customer_dues() WHERE customer_key = k_a) = c_a
    AND (money_customer_history(k_a, c_a) ->> 'previous_left')::numeric = 250
    AND jsonb_array_length(kaarbar_customer_old_bills(k_a, c_a)) = 1);
  PERFORM pg_temp.ck('The removed customer is gone from the list; the kept one keeps its name and main number',
    NOT EXISTS (SELECT 1 FROM admin_customers_v3() WHERE customer_key = k_b)
    AND NOT EXISTS (SELECT 1 FROM customers WHERE customer_key = k_b)
    AND EXISTS (SELECT 1 FROM admin_customers_v3() WHERE customer_key = k_a AND full_name = 'E2E B55 Keep' AND phone = c_a AND order_count = 3));
  PERFORM pg_temp.ck('Its note is added to the end of the kept note',
    (SELECT note FROM customers WHERE customer_key = k_a) LIKE '%From E2E B55 Remove (01799955102):' || E'\n' || 'Old note from B',
    (SELECT note FROM customers WHERE customer_key = k_a));

  SELECT moved INTO v_moved FROM customer_merges WHERE kind = 'merge' AND kept_key = k_a AND removed_key = k_b;
  PERFORM pg_temp.ck('customer_merges.moved lists every moved row with its old value',
    v_moved IS NOT NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_moved) e WHERE e ->> 'table' = 'customer_opening_dues' AND e ->> 'id' = v_od::text AND e -> 'old' ->> 'phone_key' = c_b)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_moved) e WHERE e ->> 'table' = 'customer_due_payments' AND e ->> 'id' = v_dp::text)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_moved) e WHERE e ->> 'table' = 'customer_previous_corrections' AND e ->> 'id' = v_pc::text)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_moved) e WHERE e ->> 'table' = 'customer_due_reminders' AND e ->> 'id' = v_rem::text AND e -> 'old' ->> 'customer_key' = k_b)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_moved) e WHERE e ->> 'table' = 'kaarbar_bills' AND e ->> 'id' = v_bill::text)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_moved) e WHERE e ->> 'table' = 'kaarbar_imports' AND e ->> 'id' = v_imp::text)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_moved) e WHERE e ->> 'table' = 'customer_phones' AND e ->> 'id' = c_b2 AND e -> 'old' ->> 'customer_key' = k_b)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_moved) e WHERE e ->> 'table' = 'customer_phones' AND e ->> 'id' = c_b AND e -> 'old' = 'null'::jsonb)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_moved) e WHERE e ->> 'table' = 'customers' AND e ->> 'id' = k_b AND e -> 'old' ->> 'note' = 'Old note from B'),
    v_moved::text);
  PERFORM pg_temp.ck('… plus one activity line', EXISTS (SELECT 1 FROM activity_log WHERE action = 'customer.merged'
    AND summary = 'Merged E2E B55 Remove (01799955102) into E2E B55 Keep'));
  v_err := NULL;
  BEGIN
    PERFORM admin_merge_customers(k_a, k_b);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Merging the same customer again is refused', v_err IS NOT NULL, COALESCE(v_err, 'no error'));
  v_err := NULL;
  BEGIN
    UPDATE customer_due_payments SET amount = amount + 1 WHERE id = v_dp;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A locked month still refuses changing an amount', v_err LIKE '%is locked%', COALESCE(v_err, 'no error'));
  v_err := NULL;
  BEGIN
    UPDATE customer_opening_dues SET amount = amount + 1 WHERE id = v_od;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('… also on the opening balances', v_err LIKE '%is locked%', COALESCE(v_err, 'no error'));
END
$test$;

-- ================================================ the Nabila Nur fix, on a made-up login
DO $setup$
DECLARE
  v_cust uuid;
  v_o1   uuid;
  v_o2   uuid;
BEGIN
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  -- Unlock again (the merge test above locked a month).
  DELETE FROM money_month_locks WHERE month = date_trunc('month', COALESCE(money_start_date(), current_date))::date;
  UPDATE profiles SET full_name = 'Nabila  Nur', phone = '+880 1799-955201', division = 'Dhaka', district = 'Dhaka',
                      thana = 'Gulshan', address_line = 'House 55, Road 5'
  WHERE id = v_cust;
  INSERT INTO customer_notes (customer_id, note, tags) VALUES (v_cust, 'Likes sunscreen', '{}')
  ON CONFLICT (customer_id) DO UPDATE SET note = 'Likes sunscreen';
  INSERT INTO orders (order_number, customer_name, customer_phone, division, district, thana, address_line, delivery_zone,
                      delivery_fee, subtotal, total, payment_method, payment_status, status, source, customer_id)
  VALUES ('E2E-B55-N1', 'Nabila Nur', '01799955201', 'Dhaka', 'Dhaka', 'Gulshan', 'House 55, Road 5', 'inside_dhaka',
          0, 3230, 3230, 'cod', 'unpaid', 'delivered', 'web', v_cust) RETURNING id INTO v_o1;
  INSERT INTO orders (order_number, customer_name, customer_phone, division, district, thana, address_line, delivery_zone,
                      delivery_fee, subtotal, total, payment_method, payment_status, status, source, admin_customer_id)
  VALUES ('E2E-B55-N2', 'Nabila Nur', '01799955201', 'Dhaka', 'Dhaka', 'Gulshan', 'House 55, Road 5', 'inside_dhaka',
          0, 900, 900, 'cod', 'unpaid', 'confirmed', 'web', v_cust) RETURNING id INTO v_o2;
  INSERT INTO customer_due_reminders (customer_key, phone_key, amount, how) VALUES ('p:' || v_cust, '01799955201', 4130, 'copied');
  CREATE TEMP TABLE t_nab AS
    SELECT v_cust AS cust, v_o1 AS o1, v_o2 AS o2, customer_money_totals() AS totals,
           (SELECT count(*) FROM wishlist_items WHERE customer_id = v_cust) AS wish;
END
$setup$;

{{NABILA_FIX}}

DO $check$
DECLARE
  n t_nab%ROWTYPE;
BEGIN
  SELECT * INTO n FROM t_nab;
  PERFORM pg_temp.ck('Nabila fix: her orders group under ph:<her number>',
    (SELECT customer_key FROM order_customer_keys() WHERE order_id = n.o1) = 'ph:01799955201'
    AND (SELECT customer_key FROM order_customer_keys() WHERE order_id = n.o2) = 'ph:01799955201');
  PERFORM pg_temp.ck('… the orders themselves are not changed (name, phone, total)',
    (SELECT count(*) FROM orders WHERE id IN (n.o1, n.o2) AND customer_name = 'Nabila Nur' AND customer_phone = '01799955201'
       AND customer_id IS NULL AND admin_customer_id IS NULL) = 2
    AND (SELECT total FROM orders WHERE id = n.o1) = 3230);
  PERFORM pg_temp.ck('… the login has no orders, no name, no number, no address; it still exists with its wishlist',
    NOT EXISTS (SELECT 1 FROM orders WHERE customer_id = n.cust OR admin_customer_id = n.cust)
    AND EXISTS (SELECT 1 FROM profiles WHERE id = n.cust AND role = 'customer' AND full_name IS NULL AND phone IS NULL AND address_line IS NULL)
    AND (SELECT count(*) FROM wishlist_items WHERE customer_id = n.cust) = n.wish);
  PERFORM pg_temp.ck('… her record has her name, number, address and note; the login''s note row is gone',
    EXISTS (SELECT 1 FROM customers WHERE customer_key = 'ph:01799955201' AND full_name = 'Nabila  Nur' AND phone = '01799955201'
            AND thana = 'Gulshan' AND address_line = 'House 55, Road 5' AND note = 'Likes sunscreen')
    AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE customer_id = n.cust));
  PERFORM pg_temp.ck('… her reminder moved to her record',
    EXISTS (SELECT 1 FROM customer_due_reminders WHERE customer_key = 'ph:01799955201' AND amount = 4130)
    AND NOT EXISTS (SELECT 1 FROM customer_due_reminders WHERE customer_key = 'p:' || n.cust));
  PERFORM pg_temp.ck('… every money total is exactly the same', customer_money_totals() = n.totals,
    customer_money_totals()::text || ' vs ' || n.totals::text);
  PERFORM pg_temp.ck('… logged in customer_merges (one_time_fix, with the old values) and the activity log',
    EXISTS (SELECT 1 FROM customer_merges m WHERE m.kind = 'one_time_fix' AND m.kept_key = 'ph:01799955201' AND m.removed_key = 'p:' || n.cust
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.moved) e WHERE e ->> 'table' = 'orders' AND e ->> 'id' = n.o1::text
                        AND e -> 'old' ->> 'customer_id' = n.cust::text)
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.moved) e WHERE e ->> 'table' = 'profiles' AND e -> 'old' ->> 'full_name' = 'Nabila  Nur'))
    AND EXISTS (SELECT 1 FROM activity_log WHERE action = 'customer.login_fixed' AND summary ILIKE 'Moved Nabila Nur''s orders off the login {{CUSTOMER_EMAIL}}'));
END
$check$;

-- Running the fix a second time stops and changes nothing.
DO $again$
DECLARE
  v_err text;
BEGIN
  BEGIN
    {{NABILA_FIX_INNER}}
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Nabila fix a second time: stops with "Already done"', v_err LIKE 'Already done%', COALESCE(v_err, 'no error'));
END
$again$;

SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
